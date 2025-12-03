const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');
const factoryService = require('../services/factory_service');
const schedulingService = require('../services/scheduling_service');
const logger = require('../utils/logger');

// Load protobuf definition - works both locally and in Docker
const PROTO_PATH = process.env.NODE_ENV === 'production' 
    ? '/app/proto/factory.proto'
    : path.join(__dirname, '../../..', 'proto', 'factory.proto');

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
});

const factoryProto = grpc.loadPackageDefinition(packageDefinition).factory;

// Map proto status to string
const statusMap = {
    'UP': 'UP',
    'DEGRADED': 'DEGRADED',
    'DOWN': 'DOWN',
    0: 'UP',
    1: 'DEGRADED',
    2: 'DOWN'
};

/**
 * gRPC Service Implementation
 */
const grpcServiceImplementation = {
    /**
     * Report factory status - called by MMS
     * @param {Object} call - gRPC call object
     * @param {Function} callback - Callback function
     */
    ReportFactoryStatus: async (call, callback) => {
        try {
            const { factory_id, status, reason, timestamp } = call.request;
            
            logger.info('gRPC: ReportFactoryStatus received', { 
                factoryId: factory_id, 
                status, 
                reason 
            });

            // Convert proto status to string
            const statusString = statusMap[status] || 'UP';

            // Handle the status update
            const result = await factoryService.handleStatusUpdate(
                factory_id, 
                statusString, 
                reason || 'Status reported by MMS'
            );

            callback(null, {
                success: result.success,
                message: result.message,
                orders_rescheduled: result.ordersRescheduled || 0
            });
        } catch (error) {
            logger.error('gRPC: ReportFactoryStatus error', { error: error.message });
            callback({
                code: grpc.status.INTERNAL,
                message: error.message
            });
        }
    },

    /**
     * Get factory status - called by MMS or other services
     * @param {Object} call - gRPC call object
     * @param {Function} callback - Callback function
     */
    GetFactoryStatus: async (call, callback) => {
        try {
            const { factory_id } = call.request;

            logger.info('gRPC: GetFactoryStatus received', { factoryId: factory_id });

            const status = await factoryService.getStatus(factory_id);

            if (!status) {
                callback({
                    code: grpc.status.NOT_FOUND,
                    message: `Factory ${factory_id} not found`
                });
                return;
            }

            // Convert status string to proto enum value
            const statusEnumMap = {
                'UP': 'UP',
                'DEGRADED': 'DEGRADED',
                'DOWN': 'DOWN'
            };

            callback(null, {
                factory_id: status.factoryId,
                status: statusEnumMap[status.status],
                capacity: status.capacity,
                active_orders: status.activeOrders,
                last_heartbeat: status.lastHeartbeat ? new Date(status.lastHeartbeat).getTime() : 0
            });
        } catch (error) {
            logger.error('gRPC: GetFactoryStatus error', { error: error.message });
            callback({
                code: grpc.status.INTERNAL,
                message: error.message
            });
        }
    }
};

/**
 * Create and start gRPC server
 * @param {number} port - Port to listen on
 * @returns {Object} gRPC server instance
 */
function createGrpcServer(port) {
    const server = new grpc.Server();
    
    server.addService(
        factoryProto.FactoryStatusService.service, 
        grpcServiceImplementation
    );

    server.bindAsync(
        `0.0.0.0:${port}`,
        grpc.ServerCredentials.createInsecure(),
        (error, boundPort) => {
            if (error) {
                logger.error('Failed to bind gRPC server', { error: error.message });
                return;
            }
            logger.info(`gRPC server running on port ${boundPort}`);
        }
    );

    return server;
}

module.exports = {
    createGrpcServer,
    grpcServiceImplementation
};
