/**
 * MQTT to Kafka Bridge
 * 
 * Subscribes to MQTT sensor topics and publishes to Kafka topic factory.sensors
 * Topics: factory/+/sensors/temperature/+, factory/+/sensors/level/+, factory/+/sensors/quality/+
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

// Configuration
const config = {
    mqtt: {
        brokerUrl: process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883',
        topics: [
            'factory/+/sensors/temperature/+',
            'factory/+/sensors/level/+',
            'factory/+/sensors/quality/+'
        ],
        clientId: `bridge-${Date.now()}`,
        reconnectPeriod: 5000
    },
    kafka: {
        brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
        topic: process.env.KAFKA_TOPIC || 'factory.sensors',
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
    lastMessageTime: null,
    byType: {
        temperature: 0,
        level: 0,
        quality: 0
    }
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
            
            // Subscribe to all sensor topics
            for (const topic of config.mqtt.topics) {
                mqttClient.subscribe(topic, { qos: 1 }, (err) => {
                    if (err) {
                        logger.error('Failed to subscribe to MQTT topic', { 
                            topic, 
                            error: err.message 
                        });
                    } else {
                        logger.info('Subscribed to MQTT topic', { topic });
                    }
                });
            }
            resolve();
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
 * @param {string} topic - MQTT topic (factory/{factory_id}/sensors/{type}/{sensor_id})
 * @param {Buffer} message - Message payload
 */
async function handleMqttMessage(topic, message) {
    try {
        stats.messagesReceived++;
        stats.lastMessageTime = new Date();

        // Parse topic: factory/{factory_id}/sensors/{type}/{sensor_id}
        const topicParts = topic.split('/');
        const factoryId = topicParts[1];
        const sensorType = topicParts[3]; // temperature, level, or quality

        if (!factoryId || !sensorType) {
            logger.warn('Could not parse topic', { topic });
            return;
        }

        // Track by type
        if (stats.byType[sensorType] !== undefined) {
            stats.byType[sensorType]++;
        }

        // Parse message
        let payload;
        try {
            payload = JSON.parse(message.toString());
        } catch (parseError) {
            payload = { raw: message.toString() };
        }

        // Ensure required fields are in payload
        if (!payload.factory_id) {
            payload.factory_id = factoryId;
        }
        if (!payload.timestamp) {
            payload.timestamp = new Date().toISOString();
        }

        // Forward to Kafka
        await forwardToKafka(factoryId, sensorType, payload);

        logger.debug('Message forwarded', { 
            factoryId, 
            sensorType,
            sensorId: payload.sensor_id,
            topic: config.kafka.topic 
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
 * @param {string} factoryId - Factory ID (used as key)
 * @param {string} sensorType - Sensor type (temperature, level, quality)
 * @param {Object} payload - Message payload
 */
async function forwardToKafka(factoryId, sensorType, payload) {
    try {
        await producer.send({
            topic: config.kafka.topic,
            messages: [
                {
                    key: `${factoryId}-${sensorType}`,
                    value: JSON.stringify(payload),
                    timestamp: Date.now().toString()
                }
            ]
        });
        stats.messagesForwarded++;
    } catch (error) {
        logger.error('Failed to send message to Kafka', { 
            error: error.message,
            factoryId,
            sensorType
        });
        stats.errors++;
        
        // Retry logic
        await retryKafkaSend(factoryId, sensorType, payload);
    }
}

/**
 * Retry sending to Kafka with exponential backoff
 */
async function retryKafkaSend(factoryId, sensorType, payload, attempt = 1) {
    const maxRetries = 3;
    const baseDelay = 100;

    if (attempt > maxRetries) {
        logger.error('All Kafka send retries exhausted', { factoryId, sensorType });
        return;
    }

    const delay = baseDelay * Math.pow(2, attempt - 1);
    await new Promise(resolve => setTimeout(resolve, delay));

    try {
        await producer.send({
            topic: config.kafka.topic,
            messages: [
                {
                    key: `${factoryId}-${sensorType}`,
                    value: JSON.stringify(payload),
                    timestamp: Date.now().toString()
                }
            ]
        });
        stats.messagesForwarded++;
        logger.info('Kafka send succeeded on retry', { factoryId, sensorType, attempt });
    } catch (error) {
        logger.warn(`Kafka send retry ${attempt} failed`, { 
            factoryId, 
            sensorType,
            error: error.message 
        });
        await retryKafkaSend(factoryId, sensorType, payload, attempt + 1);
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
        byType: stats.byType,
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
        mqttTopics: config.mqtt.topics,
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
