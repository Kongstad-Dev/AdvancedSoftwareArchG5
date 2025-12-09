const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { createGrpcServer } = require('./controllers/grpc_controller');
const orderController = require('./controllers/order_controller');
const factoryController = require('./controllers/factory_controller');
const systemController = require('./controllers/system_controller');
const healthController = require('./controllers/health_controller');
const mqttListener = require('./services/mqtt_listener');
const configManager = require('./services/config_manager');
const db = require('./db/database');
const logger = require('./utils/logger');

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Request logging
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        logger.info('HTTP request', {
            method: req.method,
            path: req.path,
            status: res.statusCode,
            duration: `${duration}ms`
        });
    });
    next();
});

// Routes
app.use('/health', healthController);
app.use('/orders', orderController);
app.use('/factories', factoryController);
app.use('/system', systemController);

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        service: 'Production Management System (PMS)',
        version: '1.0.0',
        endpoints: {
            health: '/health',
            orders: '/orders',
            factories: '/factories',
            system: '/system'
        }
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    logger.error('Unhandled error', { error: err.message, stack: err.stack });
    res.status(500).json({
        success: false,
        error: 'Internal server error'
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Not found'
    });
});

// Start servers
const PORT = parseInt(process.env.PORT) || 3000;
const GRPC_PORT = parseInt(process.env.GRPC_PORT) || 50051;

// Start HTTP server
const httpServer = app.listen(PORT, async () => {
    logger.info(`PMS HTTP server running on port ${PORT}`);

    // Regenerate factory config on startup
    try {
        logger.info('Regenerating factory configuration on startup...');
        await configManager.updateConfiguration();
        logger.info('Factory configuration regenerated successfully');
    } catch (error) {
        logger.error('Failed to regenerate factory configuration on startup', { error: error.message });
    }
});

// Start gRPC server
const grpcServer = createGrpcServer(GRPC_PORT);

// Start MQTT listener for factory progress updates
mqttListener.startListener();
logger.info('MQTT listener started for factory progress tracking');

// Graceful shutdown
const shutdown = async () => {
    logger.info('Shutting down PMS...');

    // Stop MQTT listener
    mqttListener.stopListener();

    // Close HTTP server
    httpServer.close(() => {
        logger.info('HTTP server closed');
    });

    // Close gRPC server
    grpcServer.tryShutdown(() => {
        logger.info('gRPC server closed');
    });

    // Close database connection
    await db.close();

    process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = app;
