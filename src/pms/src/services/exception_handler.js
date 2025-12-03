const logger = require('../utils/logger');

/**
 * Exception handler for PMS services
 */
class ExceptionHandler {
    /**
     * Handle reschedule errors with exponential backoff retry
     * @param {number} orderId - Order ID
     * @param {Error} error - The error
     * @param {Function} retryFn - Function to retry
     * @param {number} maxRetries - Maximum retries
     * @returns {Promise<any>} Result or throws
     */
    async handleRescheduleError(orderId, error, retryFn, maxRetries = 3) {
        logger.warn('Reschedule error occurred', { orderId, error: error.message });

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                // Exponential backoff
                const delay = Math.pow(2, attempt) * 100;
                await new Promise(resolve => setTimeout(resolve, delay));
                
                logger.info(`Retry attempt ${attempt}/${maxRetries}`, { orderId });
                return await retryFn();
            } catch (retryError) {
                logger.warn(`Retry ${attempt} failed`, { orderId, error: retryError.message });
                if (attempt === maxRetries) {
                    logger.error('All retry attempts exhausted', { orderId, error: retryError.message });
                    throw retryError;
                }
            }
        }
    }

    /**
     * Handle database errors gracefully
     * @param {Error} error - The error
     * @param {Object} context - Additional context
     * @returns {Object} Error response
     */
    handleDatabaseError(error, context = {}) {
        logger.error('Database error', { error: error.message, ...context });

        // Map PostgreSQL error codes to user-friendly messages
        const errorMap = {
            '23505': 'Duplicate entry exists',
            '23503': 'Referenced record not found',
            '40P01': 'Database deadlock detected',
            '53300': 'Too many connections',
            'ECONNREFUSED': 'Database connection refused',
            'ETIMEDOUT': 'Database connection timeout'
        };

        const message = errorMap[error.code] || 'Database operation failed';

        return {
            success: false,
            error: message,
            code: error.code || 'UNKNOWN',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        };
    }

    /**
     * Handle gRPC errors
     * @param {Error} error - The error
     * @param {Object} context - Additional context
     * @returns {Object} gRPC error response
     */
    handleGrpcError(error, context = {}) {
        logger.error('gRPC error', { error: error.message, ...context });

        return {
            code: error.code || 'INTERNAL',
            message: error.message || 'Internal server error',
            details: context
        };
    }

    /**
     * Handle HTTP request errors
     * @param {Error} error - The error
     * @param {Object} res - Express response object
     * @param {Object} context - Additional context
     */
    handleHttpError(error, res, context = {}) {
        logger.error('HTTP error', { error: error.message, ...context });

        const statusCode = error.statusCode || 500;
        const message = error.message || 'Internal server error';

        res.status(statusCode).json({
            success: false,
            error: message,
            ...(process.env.NODE_ENV === 'development' && { stack: error.stack })
        });
    }

    /**
     * Wrap async route handlers to catch errors
     * @param {Function} fn - Async function to wrap
     * @returns {Function} Wrapped function
     */
    asyncHandler(fn) {
        return (req, res, next) => {
            Promise.resolve(fn(req, res, next)).catch(error => {
                this.handleHttpError(error, res, { 
                    path: req.path, 
                    method: req.method 
                });
            });
        };
    }
}

module.exports = new ExceptionHandler();
