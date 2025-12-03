const express = require('express');
const db = require('../db/database');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * GET /health - Health check endpoint
 */
router.get('/', async (req, res) => {
    try {
        // Check database connectivity
        const dbHealthy = await db.healthCheck();

        const health = {
            status: dbHealthy ? 'healthy' : 'unhealthy',
            timestamp: new Date().toISOString(),
            service: 'pms',
            version: process.env.npm_package_version || '1.0.0',
            checks: {
                database: dbHealthy ? 'connected' : 'disconnected'
            }
        };

        if (!dbHealthy) {
            return res.status(503).json(health);
        }

        res.json(health);
    } catch (error) {
        logger.error('Health check failed', { error: error.message });
        res.status(503).json({
            status: 'unhealthy',
            timestamp: new Date().toISOString(),
            service: 'pms',
            error: error.message
        });
    }
});

/**
 * GET /health/ready - Readiness check
 */
router.get('/ready', async (req, res) => {
    try {
        const dbHealthy = await db.healthCheck();

        if (dbHealthy) {
            res.json({ ready: true });
        } else {
            res.status(503).json({ ready: false, reason: 'Database not ready' });
        }
    } catch (error) {
        res.status(503).json({ ready: false, reason: error.message });
    }
});

/**
 * GET /health/live - Liveness check
 */
router.get('/live', (req, res) => {
    res.json({ alive: true });
});

module.exports = router;
