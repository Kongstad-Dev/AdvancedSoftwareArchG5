const db = require('../db/database');
const logger = require('../utils/logger');

class OrderRepository {
    /**
     * Create a new order
     * @param {Object} orderData - Order data
     * @returns {Promise<Object>} Created order
     */
    async create(orderData) {
        const { orderId, productType, quantity, deadline, priority } = orderData;
        const result = await db.query(
            `INSERT INTO orders (order_id, product_type, quantity, deadline, priority, status)
             VALUES ($1, $2, $3, $4, $5, 'pending')
             RETURNING *`,
            [orderId, productType, quantity, deadline, priority || 1]
        );
        logger.info('Order created', { orderId: result.rows[0].order_id });
        return result.rows[0];
    }

    /**
     * Find order by ID
     * @param {number} id - Order ID
     * @returns {Promise<Object>} Order
     */
    async findById(id) {
        const result = await db.query(
            'SELECT * FROM orders WHERE id = $1',
            [id]
        );
        return result.rows[0];
    }

    /**
     * Find order by order_id
     * @param {string} orderId - Order ID string
     * @returns {Promise<Object>} Order
     */
    async findByOrderId(orderId) {
        const result = await db.query(
            'SELECT * FROM orders WHERE order_id = $1',
            [orderId]
        );
        return result.rows[0];
    }

    /**
     * Get all orders with optional filtering
     * @param {Object} filters - Filter options
     * @returns {Promise<Array>} Orders
     */
    async findAll(filters = {}) {
        let query = `
            SELECT o.*, 
                   fa.factory_id as assigned_factory_id,
                   fa.assigned_at,
                   fa.status as assignment_status
            FROM orders o
            LEFT JOIN factory_assignments fa ON o.id = fa.order_id AND fa.status = 'assigned'
            WHERE 1=1
        `;
        const params = [];
        let paramIndex = 1;

        if (filters.status) {
            query += ` AND o.status = $${paramIndex++}`;
            params.push(filters.status);
        }

        if (filters.factoryId) {
            query += ` AND fa.factory_id = $${paramIndex++}`;
            params.push(filters.factoryId);
        }

        query += ' ORDER BY o.priority DESC, o.deadline ASC';

        if (filters.limit) {
            query += ` LIMIT $${paramIndex++}`;
            params.push(filters.limit);
        }

        const result = await db.query(query, params);
        return result.rows;
    }

    /**
     * Update order status
     * @param {number} id - Order ID
     * @param {string} status - New status
     * @returns {Promise<Object>} Updated order
     */
    async updateStatus(id, status) {
        const result = await db.query(
            `UPDATE orders SET status = $1 WHERE id = $2 RETURNING *`,
            [status, id]
        );
        logger.info('Order status updated', { orderId: id, status });
        return result.rows[0];
    }

    /**
     * Get orders assigned to a factory
     * @param {string} factoryId - Factory ID
     * @returns {Promise<Array>} Orders
     */
    async findByFactoryId(factoryId) {
        const result = await db.query(
            `SELECT o.* FROM orders o
             JOIN factory_assignments fa ON o.id = fa.order_id
             WHERE fa.factory_id = $1 AND fa.status = 'assigned'
             ORDER BY o.priority DESC, o.deadline ASC`,
            [factoryId]
        );
        return result.rows;
    }

    /**
     * Get pending orders
     * @returns {Promise<Array>} Pending orders
     */
    async findPending() {
        const result = await db.query(
            `SELECT * FROM orders WHERE status = 'pending' ORDER BY priority DESC, deadline ASC`
        );
        return result.rows;
    }
}

module.exports = new OrderRepository();
