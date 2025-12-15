/**
 * MQTT to Kafka Bridge
 * 
 * Subscribes to all factory MQTT topics and publishes to corresponding Kafka topics:
 * - factory/+/heartbeat -> factory.heartbeat
 * - factory/+/readings -> factory.readings
 * - factory/+/sensor-failure -> factory.sensor-failure
 * - factory/+/sensor-at-risk -> factory.sensor-at-risk
 * - factory/+/restart -> factory.restart
 */

const mqtt = require('mqtt');
const { Kafka } = require('kafkajs');
const winston = require('winston');

// Configure logger
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    defaultMeta: { service: 'mqtt-kafka-bridge' },
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ]
});

// Topic mapping: MQTT pattern -> Kafka topic
const TOPIC_MAPPINGS = [
    { mqtt: 'factory/+/heartbeat', kafka: 'factory.heartbeat' },
    { mqtt: 'factory/+/readings', kafka: 'factory.readings' },
    { mqtt: 'factory/+/sensor-failure', kafka: 'factory.sensor-failure' },
    { mqtt: 'factory/+/sensor-at-risk', kafka: 'factory.sensor-at-risk' },
    { mqtt: 'factory/+/restart', kafka: 'factory.restart' }
];

// Configuration
const config = {
    mqtt: {
        brokerUrl: process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883',
        clientId: `bridge-${Date.now()}`,
        reconnectPeriod: 5000
    },
    kafka: {
        brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
        clientId: 'mqtt-kafka-bridge'
    }
};

// Kafka producer
const kafka = new Kafka({
    clientId: config.kafka.clientId,
    brokers: config.kafka.brokers,
    retry: {
        initialRetryTime: 100,
        retries: 8
    }
});

const producer = kafka.producer();

// MQTT client
let mqttClient = null;

// Statistics
const stats = {
    messagesReceived: 0,
    messagesForwarded: 0,
    errors: 0,
    lastMessageTime: null
};

/**
 * Connect to Kafka producer
 */
async function connectKafka() {
    try {
        await producer.connect();
        logger.info('Connected to Kafka broker(s)', { brokers: config.kafka.brokers });
        return true;
    } catch (error) {
        logger.error('Failed to connect to Kafka', { error: error.message });
        return false;
    }
}

/**
 * Connect to MQTT broker
 */
function connectMqtt() {
    return new Promise((resolve, reject) => {
        logger.info('Connecting to MQTT broker', { url: config.mqtt.brokerUrl });

        mqttClient = mqtt.connect(config.mqtt.brokerUrl, {
            clientId: config.mqtt.clientId,
            reconnectPeriod: config.mqtt.reconnectPeriod,
            clean: true
        });

        mqttClient.on('connect', () => {
            logger.info('Connected to MQTT broker');

            // Subscribe to all factory topics
            const subscribePromises = TOPIC_MAPPINGS.map(mapping => {
                return new Promise((resolveSubscribe, rejectSubscribe) => {
                    mqttClient.subscribe(mapping.mqtt, { qos: 1 }, (err) => {
                        if (err) {
                            logger.error('Failed to subscribe to MQTT topic', {
                                topic: mapping.mqtt,
                                error: err.message
                            });
                            rejectSubscribe(err);
                        } else {
                            logger.info('Subscribed to MQTT topic', {
                                mqtt: mapping.mqtt,
                                kafka: mapping.kafka
                            });
                            resolveSubscribe();
                        }
                    });
                });
            });

            Promise.all(subscribePromises)
                .then(() => resolve())
                .catch(err => reject(err));
        });

        mqttClient.on('error', (error) => {
            logger.error('MQTT error', { error: error.message });
            stats.errors++;
        });

        mqttClient.on('reconnect', () => {
            logger.info('Reconnecting to MQTT broker...');
        });

        mqttClient.on('close', () => {
            logger.warn('MQTT connection closed');
        });

        mqttClient.on('message', handleMqttMessage);
    });
}

/**
 * Handle incoming MQTT message
 * @param {string} topic - MQTT topic
 * @param {Buffer} message - Message payload
 */
async function handleMqttMessage(topic, message) {
    try {
        stats.messagesReceived++;
        stats.lastMessageTime = new Date();

        // Extract factory ID from topic (factory/{factory_id}/{message_type})
        const topicParts = topic.split('/');
        const factoryId = topicParts[1];
        const messageType = topicParts[2];

        if (!factoryId || !messageType) {
            logger.warn('Could not extract factory ID or message type from topic', { topic });
            return;
        }

        // Find corresponding Kafka topic
        const mapping = TOPIC_MAPPINGS.find(m => {
            const mqttPattern = m.mqtt.replace('+', factoryId);
            return mqttPattern === topic;
        });

        if (!mapping) {
            logger.warn('No Kafka topic mapping found for MQTT topic', { topic });
            return;
        }

        // Parse message
        let payload;
        try {
            payload = JSON.parse(message.toString());
        } catch (parseError) {
            // If not JSON, create wrapper object
            payload = { raw: message.toString() };
        }

        // Ensure factory_id is in payload
        if (!payload.factory_id) {
            payload.factory_id = factoryId;
        }

        // Ensure timestamp is in payload
        if (!payload.timestamp) {
            payload.timestamp = new Date().toISOString();
        }

        // Add message type to payload
        payload.message_type = messageType;

        // Forward to Kafka
        await forwardToKafka(mapping.kafka, factoryId, payload);

        logger.debug('Message forwarded', {
            factoryId,
            messageType,
            mqttTopic: topic,
            kafkaTopic: mapping.kafka
        });

    } catch (error) {
        logger.error('Error handling MQTT message', {
            error: error.message,
            topic
        });
        stats.errors++;
    }
}

/**
 * Forward message to Kafka
 * @param {string} kafkaTopic - Kafka topic name
 * @param {string} factoryId - Factory ID (used as key)
 * @param {Object} payload - Message payload
 */
async function forwardToKafka(kafkaTopic, factoryId, payload) {
    try {
        await producer.send({
            topic: kafkaTopic,
            messages: [
                {
                    key: factoryId,
                    value: JSON.stringify(payload),
                    timestamp: Date.now().toString()
                }
            ]
        });
        stats.messagesForwarded++;
    } catch (error) {
        logger.error('Failed to send message to Kafka', {
            error: error.message,
            factoryId
        });
        stats.errors++;

        // Retry logic
        await retryKafkaSend(factoryId, payload);
    }
}

/**
 * Retry sending to Kafka with exponential backoff
 * @param {string} factoryId - Factory ID
 * @param {Object} payload - Message payload
 * @param {number} attempt - Current attempt number
 */
async function retryKafkaSend(factoryId, payload, attempt = 1) {
    const maxRetries = 3;
    const baseDelay = 100;

    if (attempt > maxRetries) {
        logger.error('All Kafka send retries exhausted', { factoryId });
        return;
    }

    const delay = baseDelay * Math.pow(2, attempt - 1);
    await new Promise(resolve => setTimeout(resolve, delay));

    try {
        await producer.send({
            topic: config.kafka.topic,
            messages: [
                {
                    key: factoryId,
                    value: JSON.stringify(payload),
                    timestamp: Date.now().toString()
                }
            ]
        });
        stats.messagesForwarded++;
        logger.info('Kafka send succeeded on retry', { factoryId, attempt });
    } catch (error) {
        logger.warn(`Kafka send retry ${attempt} failed`, {
            factoryId,
            error: error.message
        });
        await retryKafkaSend(factoryId, payload, attempt + 1);
    }
}

/**
 * Print statistics periodically
 */
function printStats() {
    logger.info('Bridge statistics', {
        messagesReceived: stats.messagesReceived,
        messagesForwarded: stats.messagesForwarded,
        errors: stats.errors,
        lastMessageTime: stats.lastMessageTime
    });
}

/**
 * Graceful shutdown
 */
async function shutdown() {
    logger.info('Shutting down bridge...');

    if (mqttClient) {
        mqttClient.end(true);
    }

    await producer.disconnect();

    logger.info('Bridge shutdown complete');
    process.exit(0);
}

/**
 * Main entry point
 */
async function main() {
    logger.info('Starting MQTT-Kafka Bridge', {
        mqttBroker: config.mqtt.brokerUrl,
        mqttTopic: config.mqtt.topic,
        kafkaBrokers: config.kafka.brokers,
        kafkaTopic: config.kafka.topic
    });

    // Connect to Kafka
    const kafkaConnected = await connectKafka();
    if (!kafkaConnected) {
        logger.error('Failed to connect to Kafka, retrying in 5 seconds...');
        setTimeout(main, 5000);
        return;
    }

    // Connect to MQTT
    try {
        await connectMqtt();
    } catch (error) {
        logger.error('Failed to connect to MQTT', { error: error.message });
        setTimeout(main, 5000);
        return;
    }

    // Print stats every 30 seconds
    setInterval(printStats, 30000);

    logger.info('Bridge is running');
}

// Handle shutdown signals
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error: error.message, stack: error.stack });
    shutdown();
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled rejection', { reason });
});

// Start the bridge
main().catch((error) => {
    logger.error('Failed to start bridge', { error: error.message });
    process.exit(1);
});
