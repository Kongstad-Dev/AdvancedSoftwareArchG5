/**
 * System Controller
 * Handles system-wide operations like reset
 */

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const configManager = require('../services/config_manager');
const exceptionHandler = require('../services/exception_handler');
const logger = require('../utils/logger');

/**
 * POST /system/reset - Reset all orders and factory configurations
 */
router.post('/reset', exceptionHandler.asyncHandler(async (req, res) => {
    logger.info('System reset requested');

    await db.withTransaction(async (client) => {
        // Delete all factory assignments
        const assignmentsResult = await client.query('DELETE FROM factory_assignments');
        logger.info('Deleted factory assignments', { count: assignmentsResult.rowCount });

        // Delete all orders
        const ordersResult = await client.query('DELETE FROM orders');
        logger.info('Deleted orders', { count: ordersResult.rowCount });

        // Reset factory loads and status to UP
        await client.query("UPDATE factories SET current_load = 0, status = 'UP', updated_at = CURRENT_TIMESTAMP");
        logger.info('Reset factory loads and status to UP');

        // Clear factory configuration file
        await configManager.writeFactoryConfig({});
        logger.info('Cleared factory configuration file');
    });

    // Reset MMS sensor data
    try {
        const mmsResponse = await fetch('http://mms:8000/system/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        const mmsData = await mmsResponse.json();
        if (mmsData.success) {
            logger.info('MMS sensor data reset successfully');
        } else {
            logger.warn('MMS reset returned error', { error: mmsData.error });
        }
    } catch (error) {
        logger.warn('Failed to reset MMS data', { error: error.message });
    }

    logger.info('System reset completed successfully');

    res.json({
        success: true,
        message: 'System reset successfully. All orders, assignments, and sensor data cleared.'
    });
}));

/**
 * GET /system/status - Get system status
 */
router.get('/status', exceptionHandler.asyncHandler(async (req, res) => {
    const stats = await db.query(`
        SELECT 
            (SELECT COUNT(*) FROM orders) as total_orders,
            (SELECT COUNT(*) FROM orders WHERE status = 'pending') as pending_orders,
            (SELECT COUNT(*) FROM orders WHERE status = 'in_progress') as active_orders,
            (SELECT COUNT(*) FROM orders WHERE status = 'completed') as completed_orders,
            (SELECT COUNT(*) FROM factory_assignments) as total_assignments,
            (SELECT COUNT(*) FROM factories WHERE status = 'UP') as factories_up,
            (SELECT COUNT(*) FROM factories WHERE status = 'DOWN') as factories_down
    `);

    res.json({
        success: true,
        data: stats.rows[0]
    });
}));

module.exports = router;
