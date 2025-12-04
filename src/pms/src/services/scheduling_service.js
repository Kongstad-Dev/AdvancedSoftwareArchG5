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
            // Create the order
            const orderResult = await client.query(
                `INSERT INTO orders (order_id, product_type, quantity, deadline, priority, status)
                 VALUES ($1, $2, $3, $4, $5, 'pending')
                 RETURNING *`,
                [orderId, productType, quantity, deadline, priority || 1]
            );
            const order = orderResult.rows[0];

            // Find best available factory
            const factory = await this.findBestFactory(client);
            
            if (!factory) {
                // No factory available, order stays pending
                logger.warn('No factory available for order', { orderId: order.order_id });
                return { order, assignment: null };
            }

            // Create assignment
            const assignmentResult = await client.query(
                `INSERT INTO factory_assignments (order_id, factory_id, status)
                 VALUES ($1, $2, 'assigned')
                 RETURNING *`,
                [order.id, factory.id]
            );

            // Update factory load
            await client.query(
                `UPDATE factories SET current_load = current_load + 1 WHERE id = $1`,
                [factory.id]
            );

            // Update order status
            await client.query(
                `UPDATE orders SET status = 'assigned' WHERE id = $1`,
                [order.id]
            );

            // Log the event
            await client.query(
                `INSERT INTO production_events (event_type, factory_id, order_id, details)
                 VALUES ('ORDER_ASSIGNED', $1, $2, $3)`,
                [factory.id, order.id, JSON.stringify({ productType, quantity })]
            );

            logger.info('Order created and assigned', { 
                orderId: order.order_id, 
                factoryId: factory.id 
            });

            return { 
                order: { ...order, status: 'assigned' }, 
                assignment: assignmentResult.rows[0] 
            };
        });
    }

    /**
     * Find the best available factory for an order
     * @param {Object} client - Database client
     * @returns {Promise<Object>} Best factory or null
     */
    async findBestFactory(client) {
        // Get all factories that are UP
        const factoriesResult = await client.query(
            `SELECT * FROM factories WHERE status = 'UP'`
        );
        const factories = factoriesResult.rows;

        if (factories.length === 0) {
            return null;
        }

        const MAX_CAPACITY = 5;

        // For each factory, count its real active orders
        const factoriesWithCapacity = [];
        for (const factory of factories) {
            const capacityResult = await client.query(
                `SELECT COUNT(DISTINCT fa.order_id) as active_orders 
                 FROM factory_assignments fa
                 JOIN orders o ON fa.order_id = o.id
                 WHERE fa.factory_id = $1 AND o.status IN ('assigned', 'in_progress')`,
                [factory.id]
            );
            const activeOrders = parseInt(capacityResult.rows[0].active_orders) || 0;
            
            if (activeOrders < MAX_CAPACITY) {
                factoriesWithCapacity.push({
                    ...factory,
                    activeOrders
                });
            }
        }

        // Return factory with most available capacity
        if (factoriesWithCapacity.length === 0) {
            return null;
        }

        factoriesWithCapacity.sort((a, b) => 
            (MAX_CAPACITY - a.activeOrders) - (MAX_CAPACITY - b.activeOrders)
        );
        return factoriesWithCapacity[0];
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

                    // Count actual active orders for this factory (not using stale current_load field)
                    const capacityResult = await client.query(
                        `SELECT COUNT(DISTINCT fa.order_id) as active_orders 
                         FROM factory_assignments fa
                         JOIN orders o ON fa.order_id = o.id
                         WHERE fa.factory_id = $1 AND o.status IN ('assigned', 'in_progress')`,
                        [factoryId]
                    );
                    const activeOrders = parseInt(capacityResult.rows[0].active_orders) || 0;
                    const MAX_CAPACITY = 5;
                    
                    if (activeOrders >= MAX_CAPACITY) {
                        throw new Error(`Factory ${factoryId} is at full capacity (${activeOrders}/${MAX_CAPACITY} orders)`);
                    }

                    // Create assignment
                    const assignmentResult = await client.query(
                        `INSERT INTO factory_assignments (order_id, factory_id, status)
                         VALUES ($1, $2, 'assigned')
                         ON CONFLICT (order_id, factory_id) DO NOTHING
                         RETURNING *`,
                        [orderId, factoryId]
                    );

                    // If no rows returned, the order was already assigned to this factory
                    if (assignmentResult.rows.length === 0) {
                        throw new Error(`Order ${orderId} is already assigned to factory ${factoryId}`);
                    }

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
