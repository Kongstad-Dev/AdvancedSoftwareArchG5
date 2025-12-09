/**
 * MQTT Listener Service
 * 
 * Subscribes to factory reading topics and updates order progress in real-time
 */

const mqtt = require('mqtt');
const configManager = require('./config_manager');
const logger = require('../utils/logger');

const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtt://localhost:1883';
const READINGS_TOPIC = 'factory/+/readings'; // Subscribe to all factory readings
const FAILURE_TOPIC = 'factory/+/sensor-failure'; // Subscribe to all sensor failures
const RESTART_TOPIC = 'factory/+/restart'; // Subscribe to all factory restarts
const AT_RISK_TOPIC = 'factory/+/sensor-at-risk'; // Subscribe to sensor at-risk notifications

let mqttClient = null;

/**
 * Start MQTT listener
 */
function startListener() {
    if (mqttClient) {
        logger.warn('MQTT listener already running');
        return;
    }

    mqttClient = mqtt.connect(MQTT_BROKER, {
        clientId: `pms-listener-${Date.now()}`,
        clean: true,
        reconnectPeriod: 5000
    });

    mqttClient.on('connect', () => {
        logger.info(`MQTT Listener connected to ${MQTT_BROKER}`);

        // Subscribe to factory readings
        mqttClient.subscribe(READINGS_TOPIC, { qos: 1 }, (err) => {
            if (err) {
                logger.error('Failed to subscribe to readings topic', { topic: READINGS_TOPIC, error: err.message });
            } else {
                logger.info(`Subscribed to MQTT topic: ${READINGS_TOPIC}`);
            }
        });

        // Subscribe to sensor failures
        mqttClient.subscribe(FAILURE_TOPIC, { qos: 1 }, (err) => {
            if (err) {
                logger.error('Failed to subscribe to failure topic', { topic: FAILURE_TOPIC, error: err.message });
            } else {
                logger.info(`Subscribed to MQTT topic: ${FAILURE_TOPIC}`);
            }
        });

        // Subscribe to factory restarts
        mqttClient.subscribe(RESTART_TOPIC, { qos: 1 }, (err) => {
            if (err) {
                logger.error('Failed to subscribe to restart topic', { topic: RESTART_TOPIC, error: err.message });
            } else {
                logger.info(`Subscribed to MQTT topic: ${RESTART_TOPIC}`);
            }
        });

        // Subscribe to sensor at-risk notifications
        mqttClient.subscribe(AT_RISK_TOPIC, { qos: 1 }, (err) => {
            if (err) {
                logger.error('Failed to subscribe to at-risk topic', { topic: AT_RISK_TOPIC, error: err.message });
            } else {
                logger.info(`Subscribed to MQTT topic: ${AT_RISK_TOPIC}`);
            }
        });
    });

    mqttClient.on('message', async (topic, message) => {
        try {
            const data = JSON.parse(message.toString());

            // Extract factory ID from topic: factory/F1/readings -> F1
            const factoryId = topic.split('/')[1];

            // Handle factory restarts
            if (topic.includes('/restart')) {
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
            if (topic.includes('/sensor-failure')) {
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
            if (topic.includes('/sensor-at-risk')) {
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
            const { sensorId, sodaName, count, total } = data;

            logger.info('Received factory reading', {
                factoryId,
                sensorId,
                sodaName,
                progress: `${count}/${total}`
            });

            // Update progress in database
            await configManager.updateProgress(factoryId, sensorId, sodaName, count, total);

        } catch (error) {
            logger.error('Error processing MQTT message', {
                topic,
                error: error.message
            });
        }
    });

    mqttClient.on('error', (error) => {
        logger.error('MQTT connection error', { error: error.message });
    });

    mqttClient.on('reconnect', () => {
        logger.info('Reconnecting to MQTT broker...');
    });

    mqttClient.on('close', () => {
        logger.info('MQTT connection closed');
    });
}

/**
 * Stop MQTT listener
 */
function stopListener() {
    if (mqttClient) {
        mqttClient.end();
        mqttClient = null;
        logger.info('MQTT listener stopped');
    }
}

module.exports = {
    startListener,
    stopListener
};
