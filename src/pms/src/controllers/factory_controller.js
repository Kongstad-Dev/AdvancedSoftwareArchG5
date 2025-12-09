const express = require('express');
const factoryService = require('../services/factory_service');
const schedulingService = require('../services/scheduling_service');
const configManager = require('../services/config_manager');
const exceptionHandler = require('../services/exception_handler');
const logger = require('../utils/logger');
const db = require('../db/database');

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

/**
 * POST /factories/:id/replace-sensor - Replace a failed sensor
 */
router.post('/:id/replace-sensor', exceptionHandler.asyncHandler(async (req, res) => {
    const { id: factoryId } = req.params;
    const { failedSensorId, replacementSensorId } = req.body;

    if (!failedSensorId || !replacementSensorId) {
        return res.status(400).json({
            success: false,
            error: 'Both failedSensorId and replacementSensorId are required'
        });
    }

    const result = await configManager.replaceSensor(factoryId, failedSensorId, replacementSensorId);

    logger.info('Sensor replaced via API', {
        factoryId,
        failedSensorId,
        replacementSensorId,
        rowsUpdated: result.rowsUpdated
    });

    res.json({
        success: true,
        data: result
    });
}));

/**
 * GET /factories/:id/assignments - Get factory assignments with queue
 */
router.get('/:id/assignments', exceptionHandler.asyncHandler(async (req, res) => {
    const { id } = req.params;

    const result = await db.query(`
        WITH ranked_assignments AS (
            SELECT 
                fa.id as assignment_id,
                fa.order_id,
                fa.factory_id,
                fa.product_type,
                fa.assigned_quantity,
                fa.completed_quantity,
                fa.sensor_id,
                fa.status,
                fa.assigned_at,
                o.order_id as order_uuid,
                o.deadline,
                o.priority,
                ROW_NUMBER() OVER (PARTITION BY fa.factory_id ORDER BY fa.assigned_at) as queue_position
            FROM factory_assignments fa
            JOIN orders o ON fa.order_id = o.id
            WHERE fa.factory_id = $1 AND fa.status IN ('assigned', 'in_progress')
        )
        SELECT * FROM ranked_assignments
        ORDER BY queue_position
    `, [id]);

    res.json({
        success: true,
        data: result.rows
    });
}));

/**
 * GET /factories/:id/config - Get factory configuration
 */
router.get('/:id/config', exceptionHandler.asyncHandler(async (req, res) => {
    const { id } = req.params;

    const config = await configManager.generateFactoryConfig();

    res.json({
        success: true,
        data: config[id] || []
    });
}));

module.exports = router;
