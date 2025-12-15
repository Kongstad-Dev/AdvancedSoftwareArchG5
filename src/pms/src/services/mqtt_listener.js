/**
 * Kafka Listener Service
 * 
 * Consumes factory messages from Kafka topics and updates order progress in real-time
 */

const { Kafka } = require('kafkajs');
const configManager = require('./config_manager');
const logger = require('../utils/logger');

const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
const KAFKA_GROUP_ID = 'pms-consumer-group';

// Kafka topics to consume
const TOPICS = [
    'factory.readings',
    'factory.sensor-failure',
    'factory.restart',
    'factory.sensor-at-risk'
];

let kafka = null;
let consumer = null;

/**
 * Start Kafka listener
 */
async function startListener() {
    if (consumer) {
        logger.warn('Kafka listener already running');
        return;
    }

    kafka = new Kafka({
        clientId: 'pms-service',
        brokers: KAFKA_BROKERS,
        retry: {
            initialRetryTime: 100,
            retries: 8
        }
    });

    consumer = kafka.consumer({ groupId: KAFKA_GROUP_ID });

    try {
        await consumer.connect();
        logger.info(`Kafka Listener connected to brokers: ${KAFKA_BROKERS.join(', ')}`);

        // Subscribe to all topics
        for (const topic of TOPICS) {
            await consumer.subscribe({ topic, fromBeginning: false });
            logger.info(`Subscribed to Kafka topic: ${topic}`);
        }

        // Start consuming messages
        await consumer.run({
            eachMessage: async ({ topic, partition, message }) => {
                try {
                    const data = JSON.parse(message.value.toString());
                    const factoryId = message.key ? message.key.toString() : data.factory_id;
                    const messageType = data.message_type;

                    // Handle factory restarts
                    if (topic === 'factory.restart' || messageType === 'restart') {
                        const { recoveredSensors, totalSensors } = data;

                        logger.info('Factory restart detected', {
                            factoryId,
                            recoveredSensors,
                            totalSensors
                        });

                        // Reset sensor assignments to first sensor
                        const resetResult = await configManager.resetFactorySensorAssignments(factoryId);
                        if (resetResult.success) {
                            logger.info('Factory sensor assignments reset to first sensor', {
                                factoryId,
                                sensorId: resetResult.sensorId,
                                assignmentsUpdated: resetResult.assignmentsUpdated
                            });
                        }

                        // Update factory status back to UP since sensors are revived
                        const result = await configManager.updateFactoryStatus(factoryId, 'UP');

                        if (result.success) {
                            logger.info('Factory status updated to UP after restart', {
                                factoryId
                            });
                        } else {
                            logger.error('Failed to update factory status', {
                                factoryId,
                                message: result.message
                            });
                        }
                        return;
                    }

                    // Handle sensor failures
                    if (topic === 'factory.sensor-failure' || messageType === 'sensor-failure') {
                        const { sensorId, reading, reason } = data;

                        logger.warn('Sensor failure detected', {
                            factoryId,
                            sensorId,
                            reading,
                            reason
                        });

                        // Replace failed sensor with a healthy one to continue incomplete order
                        const result = await configManager.replaceSensor(factoryId, sensorId);

                        if (result.success) {
                            logger.info('Sensor replaced - order will continue with healthy sensor', {
                                factoryId,
                                oldSensor: result.failedSensorId,
                                newSensor: result.replacementSensorId,
                                completedOffset: result.completedOffset
                            });
                        } else {
                            logger.warn('Could not replace sensor - no healthy sensors available', {
                                factoryId,
                                sensorId,
                                message: result.message
                            });
                        }
                        return;
                    }

                    // Handle sensor at-risk notifications
                    if (topic === 'factory.sensor-at-risk' || messageType === 'sensor-at-risk') {
                        const { sensorId, lowReadingCount, recentReadings, threshold } = data;

                        logger.warn('Sensor at-risk detected - preemptively rerouting to next sensor', {
                            factoryId,
                            sensorId,
                            lowReadingCount,
                            recentReadings,
                            threshold
                        });

                        // Reroute to next sensor proactively (before complete failure)
                        const result = await configManager.replaceSensor(factoryId, sensorId);

                        if (result.success) {
                            logger.info('At-risk sensor rerouted - order will continue with healthier sensor', {
                                factoryId,
                                oldSensor: result.failedSensorId,
                                newSensor: result.replacementSensorId,
                                reason: `Low readings detected (${lowReadingCount} consecutive below ${threshold})`
                            });
                        } else {
                            logger.warn('Could not reroute at-risk sensor - no replacement available', {
                                factoryId,
                                sensorId,
                                message: result.message
                            });
                        }
                        return;
                    }

                    // Handle factory readings
                    if (topic === 'factory.readings' || messageType === 'readings') {
                        const { sensorId, sodaName, count, total } = data;

                        logger.info('Received factory reading', {
                            factoryId,
                            sensorId,
                            sodaName,
                            progress: `${count}/${total}`
                        });

                        // Update progress in database
                        await configManager.updateProgress(factoryId, sensorId, sodaName, count, total);
                    }

                } catch (error) {
                    logger.error('Error processing Kafka message', {
                        topic,
                        partition,
                        offset: message.offset,
                        error: error.message
                    });
                }
            }
        });

        logger.info('Kafka listener started successfully');

    } catch (error) {
        logger.error('Failed to start Kafka listener', { error: error.message });
        throw error;
    }
}

/**
 * Stop Kafka listener
 */
async function stopListener() {
    if (consumer) {
        await consumer.disconnect();
        consumer = null;
        logger.info('Kafka listener stopped');
    }
}

module.exports = {
    startListener,
    stopListener
};
