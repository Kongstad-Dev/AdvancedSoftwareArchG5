const factoryRepository = require('../repositories/factory_repository');
const schedulingService = require('./scheduling_service');
const logger = require('../utils/logger');

// Factory status constants
const FactoryStatus = {
    UP: 'UP',
    DEGRADED: 'DEGRADED',
    DOWN: 'DOWN'
};

class FactoryService {
    /**
     * Handle factory status update from MMS
     * @param {string} factoryId - Factory ID
     * @param {string} status - New status
     * @param {string} reason - Reason for status change
     * @returns {Promise<Object>} Update result
     */
    async handleStatusUpdate(factoryId, status, reason) {
        logger.info('Received factory status update', { factoryId, status, reason });

        // Get current factory status
        const factory = await factoryRepository.findById(factoryId);
        if (!factory) {
            logger.warn('Unknown factory ID', { factoryId });
            return { success: false, message: `Factory ${factoryId} not found` };
        }

        const previousStatus = factory.status;

        // Update factory status
        await factoryRepository.updateStatus(factoryId, status);

        // Log the event
        await factoryRepository.logEvent('STATUS_CHANGE', factoryId, null, {
            previousStatus,
            newStatus: status,
            reason
        });

        let ordersRescheduled = 0;

        // If factory is going DOWN, reschedule orders
        if (status === FactoryStatus.DOWN && previousStatus !== FactoryStatus.DOWN) {
            logger.info('Factory going DOWN, initiating order rescheduling', { factoryId });
            try {
                const result = await schedulingService.rescheduleOrders(factoryId);
                ordersRescheduled = result.rescheduled;
                logger.info('Orders rescheduled due to factory failure', { 
                    factoryId, 
                    rescheduled: result.rescheduled,
                    failed: result.failed
                });
            } catch (error) {
                logger.error('Failed to reschedule orders', { factoryId, error: error.message });
            }
        }

        // If factory is recovering (going UP from DOWN/DEGRADED)
        if (status === FactoryStatus.UP && previousStatus !== FactoryStatus.UP) {
            logger.info('Factory recovered', { factoryId, previousStatus });
            await factoryRepository.logEvent('FACTORY_RECOVERED', factoryId, null, {
                previousStatus,
                reason
            });
            
            // Try to process pending orders
            try {
                const result = await schedulingService.processPendingOrders();
                logger.info('Pending orders processed after recovery', result);
            } catch (error) {
                logger.error('Failed to process pending orders', { error: error.message });
            }
        }

        return {
            success: true,
            message: `Factory ${factoryId} status updated to ${status}`,
            ordersRescheduled
        };
    }

    /**
     * Get factory status
     * @param {string} factoryId - Factory ID
     * @returns {Promise<Object>} Factory status
     */
    async getStatus(factoryId) {
        const factory = await factoryRepository.findById(factoryId);
        if (!factory) {
            return null;
        }

        const assignments = await factoryRepository.getAssignments(factoryId);

        return {
            factoryId: factory.id,
            status: factory.status,
            capacity: factory.capacity,
            currentLoad: factory.current_load,
            availableCapacity: factory.capacity - factory.current_load,
            lastHeartbeat: factory.last_heartbeat,
            activeOrders: assignments.length
        };
    }

    /**
     * Get all factory statuses
     * @returns {Promise<Array>} All factory statuses
     */
    async getAllStatuses() {
        const factories = await factoryRepository.findAll();
        const statuses = [];

        for (const factory of factories) {
            const assignments = await factoryRepository.getAssignments(factory.id);
            statuses.push({
                factoryId: factory.id,
                name: factory.name,
                status: factory.status,
                capacity: factory.capacity,
                currentLoad: factory.current_load,
                availableCapacity: factory.capacity - factory.current_load,
                lastHeartbeat: factory.last_heartbeat,
                activeOrders: assignments.length
            });
        }

        return statuses;
    }

    /**
     * Update factory heartbeat
     * @param {string} factoryId - Factory ID
     * @returns {Promise<Object>} Updated factory
     */
    async updateHeartbeat(factoryId) {
        return factoryRepository.updateHeartbeat(factoryId);
    }

    /**
     * Mark factory as degraded
     * @param {string} factoryId - Factory ID
     * @param {string} reason - Reason for degradation
     * @returns {Promise<Object>} Update result
     */
    async markDegraded(factoryId, reason) {
        return this.handleStatusUpdate(factoryId, FactoryStatus.DEGRADED, reason);
    }

    /**
     * Mark factory as down
     * @param {string} factoryId - Factory ID
     * @param {string} reason - Reason for going down
     * @returns {Promise<Object>} Update result
     */
    async markDown(factoryId, reason) {
        return this.handleStatusUpdate(factoryId, FactoryStatus.DOWN, reason);
    }

    /**
     * Mark factory as up
     * @param {string} factoryId - Factory ID
     * @param {string} reason - Reason for recovery
     * @returns {Promise<Object>} Update result
     */
    async markUp(factoryId, reason) {
        return this.handleStatusUpdate(factoryId, FactoryStatus.UP, reason);
    }
}

module.exports = new FactoryService();
module.exports.FactoryStatus = FactoryStatus;
