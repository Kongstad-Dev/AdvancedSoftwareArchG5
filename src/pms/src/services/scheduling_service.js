const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');
const orderRepository = require('../repositories/order_repository');
const factoryRepository = require('../repositories/factory_repository');
const logger = require('../utils/logger');

class SchedulingService {
    /**
     * Create a new order and assign it to a factory
     * @param {Object} orderData - Order data
     * @returns {Promise<Object>} Created order with assignment
     */
    async createOrder(orderData) {
        const { productType, quantity, deadline, priority } = orderData;
        const orderId = uuidv4();

        return db.withTransaction(async (client) => {
            // Create the order in pending status
            const orderResult = await client.query(
                `INSERT INTO orders (order_id, product_type, quantity, deadline, priority, status)
                 VALUES ($1, $2, $3, $4, $5, 'pending')
                 RETURNING *`,
                [orderId, productType, quantity, deadline, priority || 1]
            );
            const order = orderResult.rows[0];

            logger.info('Order created', {
                orderId: order.order_id,
                productType: productType
            });

            return {
                order: order,
                assignment: null
            };
        });
    }

    /**
     * Find the best available factory for an order
     * Prioritizes factories with lower current load, then more healthy sensors
     * @param {Object} client - Database client
     * @returns {Promise<Object>} Best factory or null
     */
    async findBestFactory(client) {
        try {
            // Query MMS for sensor health data
            const MMS_API = process.env.MMS_API || 'http://mms:8000';
            const factoriesResponse = await fetch(`${MMS_API}/factories`);
            const factoriesData = await factoriesResponse.json();

            // Build a map of factory_id -> healthy sensor count
            const healthySensorCounts = {};
            if (factoriesData.success && factoriesData.data) {
                factoriesData.data.forEach(factory => {
                    const healthyCount = factory.healthy_sensors ? factory.healthy_sensors.length : 0;
                    healthySensorCounts[factory.factory_id] = healthyCount;
                });
            }

            // Get all UP factories
            const result = await client.query(
                `SELECT * FROM factories 
                 WHERE status = 'UP'
                 ORDER BY current_load ASC`
            );

            if (result.rows.length === 0) {
                return null;
            }

            // Sort by current_load (ascending), then by healthy sensor count (descending)
            const sortedFactories = result.rows.sort((a, b) => {
                if (a.current_load !== b.current_load) {
                    return a.current_load - b.current_load; // Lower load = better
                }

                const healthyA = healthySensorCounts[a.id] || 0;
                const healthyB = healthySensorCounts[b.id] || 0;
                return healthyB - healthyA; // More healthy sensors = better
            });

            return sortedFactories[0];
        } catch (error) {
            logger.warn('Failed to get sensor health data from MMS, falling back to load-based selection', {
                error: error.message
            });

            // Fallback to simple load-based selection if MMS is unavailable
            const result = await client.query(
                `SELECT * FROM factories 
                 WHERE status = 'UP'
                 ORDER BY current_load ASC
                 LIMIT 1`
            );
            return result.rows[0];
        }
    }

    /**
     * Reschedule orders from one factory to others
     * @param {string} factoryId - Factory to reschedule from
     * @param {string} targetFactoryId - Optional specific target factory
     * @returns {Promise<Object>} Rescheduling result
     */
    async rescheduleOrders(factoryId, targetFactoryId = null) {
        const maxRetries = 3;
        let lastError;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await db.withTransaction(async (client) => {
                    // Get all active assignments from the factory
                    const assignmentsResult = await client.query(
                        `SELECT fa.*, o.quantity FROM factory_assignments fa
                         JOIN orders o ON fa.order_id = o.id
                         WHERE fa.factory_id = $1 AND fa.status = 'assigned'`,
                        [factoryId]
                    );
                    const assignments = assignmentsResult.rows;

                    if (assignments.length === 0) {
                        logger.info('No orders to reschedule', { factoryId });
                        return { rescheduled: 0, failed: 0 };
                    }

                    let rescheduled = 0;
                    let failed = 0;

                    for (const assignment of assignments) {
                        // Find target factory
                        let targetFactory;
                        if (targetFactoryId) {
                            const targetResult = await client.query(
                                `SELECT * FROM factories 
                                 WHERE id = $1 AND status = 'UP' AND current_load < capacity`,
                                [targetFactoryId]
                            );
                            targetFactory = targetResult.rows[0];
                        } else {
                            const targetResult = await client.query(
                                `SELECT * FROM factories 
                                 WHERE id != $1 AND status = 'UP' AND current_load < capacity 
                                 ORDER BY (capacity - current_load) DESC
                                 LIMIT 1`,
                                [factoryId]
                            );
                            targetFactory = targetResult.rows[0];
                        }

                        if (!targetFactory) {
                            failed++;
                            logger.warn('No target factory available for rescheduling', {
                                orderId: assignment.order_id
                            });
                            continue;
                        }

                        // Update assignment
                        await client.query(
                            `UPDATE factory_assignments 
                             SET factory_id = $1, assigned_at = CURRENT_TIMESTAMP
                             WHERE id = $2`,
                            [targetFactory.id, assignment.id]
                        );

                        // Update loads
                        await client.query(
                            `UPDATE factories SET current_load = current_load - 1 WHERE id = $1`,
                            [factoryId]
                        );
                        await client.query(
                            `UPDATE factories SET current_load = current_load + 1 WHERE id = $1`,
                            [targetFactory.id]
                        );

                        // Log the event
                        await client.query(
                            `INSERT INTO production_events (event_type, factory_id, order_id, details)
                             VALUES ('ORDER_RESCHEDULED', $1, $2, $3)`,
                            [targetFactory.id, assignment.order_id, JSON.stringify({
                                fromFactory: factoryId,
                                toFactory: targetFactory.id,
                                reason: 'factory_failover'
                            })]
                        );

                        rescheduled++;
                        logger.info('Order rescheduled', {
                            orderId: assignment.order_id,
                            fromFactory: factoryId,
                            toFactory: targetFactory.id
                        });
                    }

                    return { rescheduled, failed };
                });
            } catch (error) {
                lastError = error;
                logger.warn(`Reschedule attempt ${attempt}/${maxRetries} failed`, {
                    error: error.message
                });
                if (attempt < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 100));
                }
            }
        }

        logger.error('All reschedule attempts failed', { factoryId, error: lastError.message });
        throw lastError;
    }

    /**
     * Get factory capacity information
     * @param {string} factoryId - Factory ID
     * @returns {Promise<Object>} Capacity information
     */
    async getFactoryCapacity(factoryId) {
        return factoryRepository.getCapacity(factoryId);
    }

    /**
     * Get all factory capacities
     * @returns {Promise<Array>} All factory capacities
     */
    async getAllFactoryCapacities() {
        return factoryRepository.getAllWithCapacity();
    }

    /**
     * Assign order to specific factory
     * @param {number} orderId - Order ID
     * @param {string} factoryId - Factory ID
     * @returns {Promise<Object>} Assignment result
     */
    async assignOrderToFactory(orderId, factoryId) {
        const maxRetries = 3;
        let lastError;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await db.withTransaction(async (client) => {
                    // Check factory availability
                    const factoryResult = await client.query(
                        `SELECT * FROM factories WHERE id = $1`,
                        [factoryId]
                    );
                    const factory = factoryResult.rows[0];

                    if (!factory) {
                        throw new Error(`Factory ${factoryId} not found`);
                    }

                    if (factory.status !== 'UP') {
                        throw new Error(`Factory ${factoryId} is not available (status: ${factory.status})`);
                    }

                    if (factory.current_load >= factory.capacity) {
                        throw new Error(`Factory ${factoryId} is at full capacity`);
                    }

                    // Create assignment
                    const assignmentResult = await client.query(
                        `INSERT INTO factory_assignments (order_id, factory_id, status)
                         VALUES ($1, $2, 'assigned')
                         ON CONFLICT (order_id, factory_id, assigned_at) DO UPDATE SET status = 'assigned'
                         RETURNING *`,
                        [orderId, factoryId]
                    );

                    // Update factory load
                    await client.query(
                        `UPDATE factories SET current_load = current_load + 1 WHERE id = $1`,
                        [factoryId]
                    );

                    // Update order status
                    await client.query(
                        `UPDATE orders SET status = 'assigned' WHERE id = $1`,
                        [orderId]
                    );

                    return assignmentResult.rows[0];
                });
            } catch (error) {
                lastError = error;
                // Retry on deadlock errors
                if (error.code === '40P01' && attempt < maxRetries) {
                    logger.warn(`Deadlock detected, retrying (attempt ${attempt})`, { orderId, factoryId });
                    await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 100));
                    continue;
                }
                throw error;
            }
        }

        throw lastError;
    }

    /**
     * Process pending orders
     * @returns {Promise<Object>} Processing result
     */
    async processPendingOrders() {
        const pendingOrders = await orderRepository.findPending();
        let assigned = 0;
        let failed = 0;

        for (const order of pendingOrders) {
            try {
                const factory = await this.findBestFactory(db);
                if (factory) {
                    await this.assignOrderToFactory(order.id, factory.id);
                    assigned++;
                } else {
                    failed++;
                }
            } catch (error) {
                failed++;
                logger.error('Failed to assign pending order', {
                    orderId: order.order_id,
                    error: error.message
                });
            }
        }

        return { assigned, failed, total: pendingOrders.length };
    }
}

module.exports = new SchedulingService();
