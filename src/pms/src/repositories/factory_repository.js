const db = require('../db/database');
const logger = require('../utils/logger');

class FactoryRepository {
    /**
     * Get all factories
     * @returns {Promise<Array>} Factories
     */
    async findAll() {
        const result = await db.query('SELECT * FROM factories ORDER BY id');
        return result.rows;
    }

    /**
     * Find factory by ID
     * @param {string} factoryId - Factory ID
     * @returns {Promise<Object>} Factory
     */
    async findById(factoryId) {
        const result = await db.query(
            'SELECT * FROM factories WHERE id = $1',
            [factoryId]
        );
        return result.rows[0];
    }

    /**
     * Update factory status
     * @param {string} factoryId - Factory ID
     * @param {string} status - New status (UP, DEGRADED, DOWN)
     * @returns {Promise<Object>} Updated factory
     */
    async updateStatus(factoryId, status) {
        const result = await db.query(
            `UPDATE factories SET status = $1 WHERE id = $2 RETURNING *`,
            [status, factoryId]
        );
        logger.info('Factory status updated', { factoryId, status });
        return result.rows[0];
    }

    /**
     * Update factory heartbeat timestamp
     * @param {string} factoryId - Factory ID
     * @returns {Promise<Object>} Updated factory
     */
    async updateHeartbeat(factoryId) {
        const result = await db.query(
            `UPDATE factories SET last_heartbeat = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`,
            [factoryId]
        );
        return result.rows[0];
    }

    /**
     * Update factory load
     * @param {string} factoryId - Factory ID
     * @param {number} load - New load value
     * @returns {Promise<Object>} Updated factory
     */
    async updateLoad(factoryId, load) {
        const result = await db.query(
            `UPDATE factories SET current_load = $1 WHERE id = $2 RETURNING *`,
            [load, factoryId]
        );
        return result.rows[0];
    }

    /**
     * Increment factory load
     * @param {string} factoryId - Factory ID
     * @param {number} amount - Amount to increment
     * @returns {Promise<Object>} Updated factory
     */
    async incrementLoad(factoryId, amount) {
        const result = await db.query(
            `UPDATE factories SET current_load = current_load + $1 WHERE id = $2 RETURNING *`,
            [amount, factoryId]
        );
        return result.rows[0];
    }

    /**
     * Decrement factory load
     * @param {string} factoryId - Factory ID
     * @param {number} amount - Amount to decrement
     * @returns {Promise<Object>} Updated factory
     */
    async decrementLoad(factoryId, amount) {
        const result = await db.query(
            `UPDATE factories SET current_load = GREATEST(0, current_load - $1) WHERE id = $2 RETURNING *`,
            [amount, factoryId]
        );
        return result.rows[0];
    }

    /**
     * Get available factories (UP status with capacity)
     * @returns {Promise<Array>} Available factories
     */
    async findAvailable() {
        const result = await db.query(
            `SELECT * FROM factories 
             WHERE status = 'UP' AND current_load < capacity 
             ORDER BY (capacity - current_load) DESC`
        );
        return result.rows;
    }

    /**
     * Get factory capacity info
     * @param {string} factoryId - Factory ID
     * @returns {Promise<Object>} Capacity info
     */
    async getCapacity(factoryId) {
        const result = await db.query(
            `SELECT id, capacity, current_load, (capacity - current_load) as available_capacity, status
             FROM factories WHERE id = $1`,
            [factoryId]
        );
        return result.rows[0];
    }

    /**
     * Get all factories with capacity info
     * @returns {Promise<Array>} Factories with capacity
     */
    async getAllWithCapacity() {
        const result = await db.query(
            `SELECT id, name, capacity, current_load, 
                    (capacity - current_load) as available_capacity, 
                    status, last_heartbeat
             FROM factories ORDER BY available_capacity DESC`
        );
        return result.rows;
    }

    /**
     * Create factory assignment
     * @param {number} orderId - Order ID
     * @param {string} factoryId - Factory ID
     * @returns {Promise<Object>} Assignment
     */
    async createAssignment(orderId, factoryId) {
        const result = await db.query(
            `INSERT INTO factory_assignments (order_id, factory_id, status)
             VALUES ($1, $2, 'assigned')
             RETURNING *`,
            [orderId, factoryId]
        );
        logger.info('Order assigned to factory', { orderId, factoryId });
        return result.rows[0];
    }

    /**
     * Get assignments for a factory
     * @param {string} factoryId - Factory ID
     * @returns {Promise<Array>} Assignments
     */
    async getAssignments(factoryId) {
        const result = await db.query(
            `SELECT fa.*, o.order_id as order_ref, o.product_type, o.quantity, o.deadline
             FROM factory_assignments fa
             JOIN orders o ON fa.order_id = o.id
             WHERE fa.factory_id = $1 AND fa.status = 'assigned'
             ORDER BY o.deadline ASC`,
            [factoryId]
        );
        return result.rows;
    }

    /**
     * Update assignment status
     * @param {number} orderId - Order ID
     * @param {string} factoryId - Factory ID
     * @param {string} status - New status
     * @returns {Promise<Object>} Updated assignment
     */
    async updateAssignmentStatus(orderId, factoryId, status) {
        const result = await db.query(
            `UPDATE factory_assignments 
             SET status = $3, completed_at = CASE WHEN $3 = 'completed' THEN CURRENT_TIMESTAMP ELSE NULL END
             WHERE order_id = $1 AND factory_id = $2
             RETURNING *`,
            [orderId, factoryId, status]
        );
        return result.rows[0];
    }

    /**
     * Reassign orders from one factory to another
     * @param {string} fromFactoryId - Source factory ID
     * @param {string} toFactoryId - Target factory ID
     * @param {Object} client - Database client for transaction
     * @returns {Promise<number>} Number of reassigned orders
     */
    async reassignOrders(fromFactoryId, toFactoryId, client) {
        // Get all active assignments from source factory
        const assignmentsResult = await client.query(
            `SELECT * FROM factory_assignments 
             WHERE factory_id = $1 AND status = 'assigned'`,
            [fromFactoryId]
        );

        const assignments = assignmentsResult.rows;
        
        for (const assignment of assignments) {
            // Update assignment to new factory
            await client.query(
                `UPDATE factory_assignments 
                 SET factory_id = $1, assigned_at = CURRENT_TIMESTAMP
                 WHERE id = $2`,
                [toFactoryId, assignment.id]
            );
        }

        // Update load for both factories
        const totalLoad = assignments.length;
        await client.query(
            `UPDATE factories SET current_load = current_load - $1 WHERE id = $2`,
            [totalLoad, fromFactoryId]
        );
        await client.query(
            `UPDATE factories SET current_load = current_load + $1 WHERE id = $2`,
            [totalLoad, toFactoryId]
        );

        logger.info('Orders reassigned', { fromFactoryId, toFactoryId, count: totalLoad });
        return totalLoad;
    }

    /**
     * Log production event
     * @param {string} eventType - Event type
     * @param {string} factoryId - Factory ID
     * @param {number} orderId - Order ID (optional)
     * @param {Object} details - Event details
     * @returns {Promise<Object>} Event record
     */
    async logEvent(eventType, factoryId, orderId, details) {
        const result = await db.query(
            `INSERT INTO production_events (event_type, factory_id, order_id, details)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [eventType, factoryId, orderId, JSON.stringify(details)]
        );
        return result.rows[0];
    }
}

module.exports = new FactoryRepository();
