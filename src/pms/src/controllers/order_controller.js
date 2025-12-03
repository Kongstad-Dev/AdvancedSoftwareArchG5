const express = require('express');
const schedulingService = require('../services/scheduling_service');
const orderRepository = require('../repositories/order_repository');
const exceptionHandler = require('../services/exception_handler');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * POST /orders - Create a new order
 */
router.post('/', exceptionHandler.asyncHandler(async (req, res) => {
    const { productType, quantity, deadline, priority } = req.body;

    // Validate required fields
    if (!productType || !quantity || !deadline) {
        return res.status(400).json({
            success: false,
            error: 'Missing required fields: productType, quantity, deadline'
        });
    }

    // Validate quantity
    if (typeof quantity !== 'number' || quantity <= 0) {
        return res.status(400).json({
            success: false,
            error: 'Quantity must be a positive number'
        });
    }

    // Validate deadline
    const deadlineDate = new Date(deadline);
    if (isNaN(deadlineDate.getTime())) {
        return res.status(400).json({
            success: false,
            error: 'Invalid deadline format'
        });
    }

    const result = await schedulingService.createOrder({
        productType,
        quantity,
        deadline: deadlineDate,
        priority: priority || 1
    });

    logger.info('Order created via REST API', { orderId: result.order.order_id });

    res.status(201).json({
        success: true,
        data: result
    });
}));

/**
 * GET /orders - Get all orders
 */
router.get('/', exceptionHandler.asyncHandler(async (req, res) => {
    const { status, factoryId, limit } = req.query;

    const filters = {};
    if (status) filters.status = status;
    if (factoryId) filters.factoryId = factoryId;
    if (limit) filters.limit = parseInt(limit);

    const orders = await orderRepository.findAll(filters);

    res.json({
        success: true,
        data: orders,
        count: orders.length
    });
}));

/**
 * GET /orders/:id - Get order by ID
 */
router.get('/:id', exceptionHandler.asyncHandler(async (req, res) => {
    const { id } = req.params;

    // Try to find by order_id first, then by numeric id
    let order = await orderRepository.findByOrderId(id);
    if (!order && !isNaN(parseInt(id))) {
        order = await orderRepository.findById(parseInt(id));
    }

    if (!order) {
        return res.status(404).json({
            success: false,
            error: 'Order not found'
        });
    }

    res.json({
        success: true,
        data: order
    });
}));

/**
 * PUT /orders/:id/status - Update order status
 */
router.put('/:id/status', exceptionHandler.asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['pending', 'assigned', 'in_progress', 'completed', 'cancelled'];
    if (!validStatuses.includes(status)) {
        return res.status(400).json({
            success: false,
            error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
        });
    }

    const order = await orderRepository.findById(parseInt(id));
    if (!order) {
        return res.status(404).json({
            success: false,
            error: 'Order not found'
        });
    }

    const updatedOrder = await orderRepository.updateStatus(parseInt(id), status);

    res.json({
        success: true,
        data: updatedOrder
    });
}));

/**
 * POST /orders/:id/assign - Assign order to a factory
 */
router.post('/:id/assign', exceptionHandler.asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { factoryId } = req.body;

    if (!factoryId) {
        return res.status(400).json({
            success: false,
            error: 'factoryId is required'
        });
    }

    const assignment = await schedulingService.assignOrderToFactory(
        parseInt(id), 
        factoryId
    );

    res.json({
        success: true,
        data: assignment
    });
}));

/**
 * POST /orders/reschedule - Reschedule orders from a factory
 */
router.post('/reschedule', exceptionHandler.asyncHandler(async (req, res) => {
    const { fromFactoryId, toFactoryId } = req.body;

    if (!fromFactoryId) {
        return res.status(400).json({
            success: false,
            error: 'fromFactoryId is required'
        });
    }

    const result = await schedulingService.rescheduleOrders(fromFactoryId, toFactoryId);

    res.json({
        success: true,
        data: result
    });
}));

module.exports = router;
