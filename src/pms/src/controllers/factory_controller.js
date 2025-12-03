const express = require('express');
const factoryService = require('../services/factory_service');
const schedulingService = require('../services/scheduling_service');
const exceptionHandler = require('../services/exception_handler');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * GET /factories - Get all factories
 */
router.get('/', exceptionHandler.asyncHandler(async (req, res) => {
    const factories = await factoryService.getAllStatuses();

    res.json({
        success: true,
        data: factories,
        count: factories.length
    });
}));

/**
 * GET /factories/:id - Get factory by ID
 */
router.get('/:id', exceptionHandler.asyncHandler(async (req, res) => {
    const { id } = req.params;

    const factory = await factoryService.getStatus(id);

    if (!factory) {
        return res.status(404).json({
            success: false,
            error: 'Factory not found'
        });
    }

    res.json({
        success: true,
        data: factory
    });
}));

/**
 * GET /factories/:id/capacity - Get factory capacity
 */
router.get('/:id/capacity', exceptionHandler.asyncHandler(async (req, res) => {
    const { id } = req.params;

    const capacity = await schedulingService.getFactoryCapacity(id);

    if (!capacity) {
        return res.status(404).json({
            success: false,
            error: 'Factory not found'
        });
    }

    res.json({
        success: true,
        data: capacity
    });
}));

/**
 * PUT /factories/:id/status - Update factory status
 */
router.put('/:id/status', exceptionHandler.asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { status, reason } = req.body;

    const validStatuses = ['UP', 'DEGRADED', 'DOWN'];
    if (!validStatuses.includes(status)) {
        return res.status(400).json({
            success: false,
            error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
        });
    }

    const result = await factoryService.handleStatusUpdate(id, status, reason || 'manual update');

    res.json({
        success: true,
        data: result
    });
}));

/**
 * GET /factories/capacities - Get all factory capacities
 */
router.get('/all/capacities', exceptionHandler.asyncHandler(async (req, res) => {
    const capacities = await schedulingService.getAllFactoryCapacities();

    res.json({
        success: true,
        data: capacities,
        count: capacities.length
    });
}));

module.exports = router;
