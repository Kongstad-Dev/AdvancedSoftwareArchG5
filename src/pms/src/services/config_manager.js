const fs = require('fs').promises;
const path = require('path');
const db = require('../db/database');
const logger = require('../utils/logger');

const CONFIG_PATH = process.env.FACTORY_CONFIG_PATH || '/app/config/factory_config.json';
const MAX_UNITS_PER_FACTORY = 2000; // Maximum units a factory can handle at once

class ConfigManager {
    /**
     * Get current factory workload and generate configuration
     * Only returns the ACTIVE order for each factory (first in queue)
     */
    async generateFactoryConfig() {
        try {
            const result = await db.query(`
                WITH ranked_assignments AS (
                    SELECT 
                        fa.factory_id,
                        fa.product_type as "sodaName",
                        (fa.assigned_quantity - fa.completed_quantity) as number,
                        fa.completed_quantity,
                        fa.sensor_id as "sensorID",
                        fa.id as assignment_id,
                        o.order_id,
                        fa.status,
                        fa.assigned_at,
                        ROW_NUMBER() OVER (PARTITION BY fa.factory_id ORDER BY fa.assigned_at) as queue_position
                    FROM factory_assignments fa
                    JOIN orders o ON fa.order_id = o.id
                    WHERE fa.status IN ('assigned', 'in_progress')
                )
                SELECT * FROM ranked_assignments
                WHERE queue_position = 1
                ORDER BY factory_id
            `);

            // Each factory gets only its ACTIVE order (first in queue)
            const config = {};
            result.rows.forEach(row => {
                if (row.number > 0) {  // Only include if there's work to do
                    config[row.factory_id] = [{
                        sodaName: row.sodaName,
                        number: row.number,
                        sensorID: row.sensorID,
                        orderId: row.order_id,
                        assignmentId: row.assignment_id,
                        completedOffset: row.completed_quantity || 0  // Starting offset for progress tracking
                    }];
                }
            });

            return config;
        } catch (error) {
            logger.error('Error generating factory config', { error: error.message });
            throw error;
        }
    }

    /**
     * Write factory configuration to file
     */
    async writeFactoryConfig(config) {
        try {
            await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
            logger.info('Factory configuration updated', {
                factories: Object.keys(config).length,
                path: CONFIG_PATH
            });
            return true;
        } catch (error) {
            logger.error('Error writing factory config', { error: error.message });
            throw error;
        }
    }

    /**
     * Update configuration and notify factories
     */
    async updateConfiguration() {
        const config = await this.generateFactoryConfig();
        await this.writeFactoryConfig(config);
        return config;
    }

    /**
     * Assign order to factories - distributes across multiple factories if needed
     */
    async assignOrderToFactory(orderId, productType, quantity) {
        return db.withTransaction(async (client) => {
            // Get order
            const orderResult = await client.query(
                'SELECT * FROM orders WHERE id = $1',
                [orderId]
            );
            const order = orderResult.rows[0];

            if (!order) {
                throw new Error(`Order ${orderId} not found`);
            }

            // Get all available factories ordered by current workload
            const factoryResult = await client.query(`
                SELECT 
                    f.id,
                    f.current_load,
                    COALESCE(SUM(CASE WHEN fa.status IN ('assigned', 'in_progress') 
                                      THEN fa.assigned_quantity - fa.completed_quantity 
                                      ELSE 0 END), 0) as pending_units
                FROM factories f
                LEFT JOIN factory_assignments fa ON fa.factory_id = f.id
                WHERE f.status = 'UP'
                GROUP BY f.id, f.current_load
                ORDER BY pending_units ASC, f.current_load ASC
            `);

            if (factoryResult.rows.length === 0) {
                throw new Error('No available factories');
            }

            const factories = factoryResult.rows;
            const assignments = [];
            let remainingQuantity = quantity;
            let factoryIndex = 0;

            // Distribute order across factories
            while (remainingQuantity > 0 && factoryIndex < factories.length) {
                const factory = factories[factoryIndex];
                const assignQuantity = Math.min(remainingQuantity, MAX_UNITS_PER_FACTORY);

                // Always use the first sensor (S1-1, S2-1, etc.) - others are backups
                const sensorId = `${factory.id.replace('F', 'S')}-1`;

                // Create assignment
                const assignmentResult = await client.query(`
                    INSERT INTO factory_assignments 
                    (order_id, factory_id, product_type, assigned_quantity, sensor_id, status)
                    VALUES ($1, $2, $3, $4, $5, 'assigned')
                    RETURNING *
                `, [orderId, factory.id, productType, assignQuantity, sensorId]);

                // Update factory load
                await client.query(
                    'UPDATE factories SET current_load = current_load + $1 WHERE id = $2',
                    [assignQuantity, factory.id]
                );

                assignments.push(assignmentResult.rows[0]);

                logger.info('Order portion assigned to factory', {
                    orderId: order.order_id,
                    factoryId: factory.id,
                    quantity: assignQuantity,
                    sensorId,
                    remaining: remainingQuantity - assignQuantity
                });

                remainingQuantity -= assignQuantity;
                factoryIndex++;
            }

            if (remainingQuantity > 0) {
                throw new Error(`Could not fully assign order. ${remainingQuantity} units remaining.`);
            }

            // Update order status
            await client.query(
                `UPDATE orders SET status = 'assigned', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                [orderId]
            );

            logger.info('Order fully assigned', {
                orderId: order.order_id,
                totalQuantity: quantity,
                factories: assignments.length,
                assignments: assignments.map(a => ({ factory: a.factory_id, quantity: a.assigned_quantity }))
            });

            // Update configuration file
            await this.updateConfiguration();

            return assignments;
        });
    }

    /**
     * Update progress from sensor reading
     */
    async updateProgress(factoryId, sensorId, sodaName, count, total) {
        try {
            const result = await db.query(`
                UPDATE factory_assignments
                SET completed_quantity = $1,
                    status = CASE 
                        WHEN $1 >= assigned_quantity THEN 'completed'
                        WHEN $1 > 0 THEN 'in_progress'
                        ELSE status
                    END
                WHERE factory_id = $2 
                    AND product_type = $3
                    AND status != 'completed'
                RETURNING *
            `, [count, factoryId, sodaName]);

            if (result.rows.length > 0) {
                const assignment = result.rows[0];

                // Update order completed quantity
                await db.query(`
                    UPDATE orders o
                    SET completed_quantity = (
                        SELECT COALESCE(SUM(completed_quantity), 0)
                        FROM factory_assignments
                        WHERE order_id = o.id
                    ),
                    status = CASE 
                        WHEN (SELECT COALESCE(SUM(completed_quantity), 0) FROM factory_assignments WHERE order_id = o.id) >= o.quantity 
                        THEN 'completed'
                        WHEN (SELECT COALESCE(SUM(completed_quantity), 0) FROM factory_assignments WHERE order_id = o.id) > 0 
                        THEN 'in_progress'
                        ELSE status
                    END,
                    updated_at = CURRENT_TIMESTAMP
                    WHERE id = $1
                `, [assignment.order_id]);

                // Update factory load if completed
                if (assignment.status === 'completed') {
                    await db.query(
                        'UPDATE factories SET current_load = GREATEST(current_load - $1, 0) WHERE id = $2',
                        [assignment.assigned_quantity, factoryId]
                    );

                    logger.info('Assignment completed', {
                        factoryId,
                        sensorId,
                        productType: sodaName,
                        quantity: assignment.assigned_quantity
                    });

                    // Update configuration to remove completed work
                    await this.updateConfiguration();
                }

                return assignment;
            }

            return null;
        } catch (error) {
            logger.error('Error updating progress', { error: error.message, factoryId, sensorId });
            throw error;
        }
    }

    /**
     * Replace a failed sensor with the first available healthy sensor
     * @param {string} factoryId - Factory ID (e.g., 'F1')
     * @param {string} failedSensorId - Failed sensor ID (e.g., 'S1-1')
     */
    async replaceSensor(factoryId, failedSensorId) {
        try {
            // Query MMS for healthy sensors in this factory
            const MMS_API = process.env.MMS_API || 'http://mms:8000';
            const sensorHealthResponse = await fetch(`${MMS_API}/factories/${factoryId}/sensors`);
            const sensorHealthData = await sensorHealthResponse.json();

            if (!sensorHealthData.success || !sensorHealthData.data) {
                logger.error('Failed to get sensor health data from MMS', {
                    factoryId,
                    failedSensorId
                });
                return {
                    success: false,
                    message: 'Could not retrieve sensor health data'
                };
            }

            const healthySensors = sensorHealthData.data.healthy_sensors || [];
            const atRiskSensors = sensorHealthData.data.at_risk_sensors || [];
            const atRiskSensorIds = atRiskSensors.map(s => s.sensor_id);

            // Filter out the failed sensor and any at-risk sensors from available options
            const availableSensors = healthySensors.filter(
                sensorId => sensorId !== failedSensorId && !atRiskSensorIds.includes(sensorId)
            );

            if (availableSensors.length === 0) {
                logger.error('No healthy sensors available - factory needs restart', {
                    factoryId,
                    failedSensorId,
                    healthySensors,
                    atRiskSensors: atRiskSensorIds
                });

                // Update factory status to DOWN
                await db.query(
                    `UPDATE factories SET status = 'DOWN', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                    [factoryId]
                );

                return {
                    success: false,
                    message: 'All sensors failed or at-risk - factory restarting',
                    requiresRestart: true
                };
            }

            // Sort available sensors by sensor number to get the first one (S1-1, S1-2, etc.)
            const sortedHealthySensors = availableSensors.sort((a, b) => {
                const numA = parseInt(a.split('-')[1]);
                const numB = parseInt(b.split('-')[1]);
                return numA - numB;
            });

            const replacementSensorId = sortedHealthySensors[0];

            logger.info('Attempting sensor replacement with first healthy sensor', {
                factoryId,
                failedSensorId,
                replacementSensorId,
                healthySensorsAvailable: healthySensors.length
            });

            // Update the sensor_id in factory_assignments for active work
            const result = await db.query(`
                UPDATE factory_assignments
                SET sensor_id = $1
                WHERE factory_id = $2 
                  AND sensor_id = $3 
                  AND status IN ('assigned', 'in_progress')
                RETURNING *
            `, [replacementSensorId, factoryId, failedSensorId]);

            if (result.rowCount === 0) {
                logger.warn('No active assignments found for failed sensor', {
                    factoryId,
                    failedSensorId
                });
                return {
                    success: false,
                    message: 'No active assignments found for this sensor'
                };
            }

            logger.info('Sensor replaced successfully', {
                factoryId,
                failedSensorId,
                replacementSensorId,
                assignmentsUpdated: result.rowCount
            });

            // Update configuration file to reflect new sensor
            await this.updateConfiguration();

            return {
                success: true,
                factoryId,
                failedSensorId,
                replacementSensorId,
                assignmentsUpdated: result.rowCount
            };

        } catch (error) {
            logger.error('Failed to replace sensor', {
                factoryId,
                failedSensorId,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Update factory status (UP, DEGRADED, DOWN)
     * @param {string} factoryId - Factory ID (F1, F2, etc)
     * @param {string} status - New status (UP, DEGRADED, DOWN)
     */
    async updateFactoryStatus(factoryId, status) {
        try {
            logger.info('Updating factory status', { factoryId, status });

            await db.query(
                `UPDATE factories SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
                [status, factoryId]
            );

            // Regenerate config to ensure factory can pick up work if back online
            await this.updateConfiguration();

            logger.info('Factory status updated successfully', { factoryId, status });

            return {
                success: true,
                factoryId,
                status
            };

        } catch (error) {
            logger.error('Failed to update factory status', {
                factoryId,
                status,
                error: error.message
            });
            return {
                success: false,
                message: error.message
            };
        }
    }

    /**
     * Reset factory sensor assignments to first sensor after restart
     * @param {string} factoryId - Factory ID (F1, F2, etc)
     */
    async resetFactorySensorAssignments(factoryId) {
        try {
            // Extract factory number from ID (F1 -> 1)
            const factoryNum = factoryId.replace('F', '');
            const firstSensorId = `S${factoryNum}-1`;

            logger.info('Resetting sensor assignments to first sensor after factory restart', {
                factoryId,
                firstSensorId
            });

            // Update all active assignments for this factory to use first sensor
            const result = await db.query(`
                UPDATE factory_assignments
                SET sensor_id = $1
                WHERE factory_id = $2 
                  AND status IN ('assigned', 'in_progress')
                RETURNING *
            `, [firstSensorId, factoryId]);

            if (result.rowCount > 0) {
                logger.info('Sensor assignments reset successfully', {
                    factoryId,
                    firstSensorId,
                    assignmentsUpdated: result.rowCount
                });

                // Update configuration file to reflect new sensor
                await this.updateConfiguration();
            } else {
                logger.info('No active assignments to reset for factory', { factoryId });
            }

            return {
                success: true,
                factoryId,
                sensorId: firstSensorId,
                assignmentsUpdated: result.rowCount
            };

        } catch (error) {
            logger.error('Failed to reset sensor assignments', {
                factoryId,
                error: error.message
            });
            return {
                success: false,
                message: error.message
            };
        }
    }
}

module.exports = new ConfigManager();
