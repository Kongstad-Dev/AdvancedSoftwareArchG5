/**
 * Factory Simulator
 * 
 * Simulates a factory by publishing heartbeats to MQTT.
 * Can simulate failures, degraded states, and various metrics.
 */

const mqtt = require('mqtt');
const winston = require('winston');
const config = require('./config');

// Configure logger
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    defaultMeta: { service: 'factory-simulator' },
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ]
});

// Factory configuration from environment
const factoryId = process.env.FACTORY_ID || 'factory-1';
const mqttBrokerUrl = process.env.MQTT_BROKER_URL || config.mqtt.brokerUrl;
const heartbeatIntervalMs = parseInt(process.env.HEARTBEAT_INTERVAL_MS) || config.heartbeat.intervalMs;
const simulateFailures = process.env.SIMULATE_FAILURES === 'true';
const failureProbability = parseFloat(process.env.FAILURE_PROBABILITY) || config.simulation.failureProbability;

// State
let mqttClient = null;
let heartbeatInterval = null;
let isInFailureState = false;
let isDegraded = false;
let failureEndTime = null;
let heartbeatCount = 0;

// Statistics
const stats = {
    heartbeatsSent: 0,
    failures: 0,
    reconnects: 0,
    errors: 0
};

/**
 * Generate random number in range
 */
function randomInRange(min, max) {
    return Math.random() * (max - min) + min;
}

/**
 * Generate simulated metrics
 */
function generateMetrics() {
    const metricsConfig = config.metrics;
    
    let cpuUsage, memoryUsage, latencyMs, errorCount;
    
    if (isInFailureState) {
        // During failure, don't send metrics (factory is "down")
        return null;
    } else if (isDegraded) {
        // Degraded state - elevated metrics
        cpuUsage = randomInRange(metricsConfig.cpu.max, metricsConfig.cpu.spike);
        memoryUsage = randomInRange(metricsConfig.memory.max, metricsConfig.memory.spike);
        latencyMs = randomInRange(metricsConfig.latency.max, metricsConfig.latency.spike);
        errorCount = Math.floor(randomInRange(metricsConfig.errors.degraded, metricsConfig.errors.spike));
    } else {
        // Normal state
        cpuUsage = randomInRange(metricsConfig.cpu.min, metricsConfig.cpu.max);
        memoryUsage = randomInRange(metricsConfig.memory.min, metricsConfig.memory.max);
        latencyMs = randomInRange(metricsConfig.latency.min, metricsConfig.latency.max);
        errorCount = metricsConfig.errors.normal;
    }
    
    return {
        cpu_usage: parseFloat(cpuUsage.toFixed(2)),
        memory_usage: parseFloat(memoryUsage.toFixed(2)),
        latency_ms: parseFloat(latencyMs.toFixed(2)),
        error_count: errorCount
    };
}

/**
 * Create heartbeat message
 */
function createHeartbeatMessage() {
    const metrics = generateMetrics();
    
    if (metrics === null) {
        return null;  // Factory is in failure state
    }
    
    return {
        factory_id: factoryId,
        timestamp: new Date().toISOString(),
        sequence: ++heartbeatCount,
        metrics: metrics,
        status: isDegraded ? 'DEGRADED' : 'UP'
    };
}

/**
 * Check and update failure state
 */
function updateFailureState() {
    const now = Date.now();
    
    // Check if we should exit failure state
    if (isInFailureState && failureEndTime && now >= failureEndTime) {
        isInFailureState = false;
        failureEndTime = null;
        logger.info(`Factory ${factoryId} recovered from failure`);
    }
    
    // Check if we should enter failure state
    if (!isInFailureState && simulateFailures) {
        if (Math.random() < failureProbability) {
            isInFailureState = true;
            failureEndTime = now + config.simulation.failureDurationMs;
            stats.failures++;
            logger.warn(`Factory ${factoryId} entering failure state for ${config.simulation.failureDurationMs}ms`);
        }
    }
    
    // Check for degraded state
    if (!isInFailureState && config.simulation.simulateDegraded) {
        if (Math.random() < config.simulation.degradedProbability) {
            isDegraded = !isDegraded;
            logger.info(`Factory ${factoryId} degraded state: ${isDegraded}`);
        }
    }
}

/**
 * Send heartbeat to MQTT
 */
function sendHeartbeat() {
    updateFailureState();
    
    const message = createHeartbeatMessage();
    
    if (message === null) {
        logger.debug(`Factory ${factoryId} in failure state, skipping heartbeat`);
        return;
    }
    
    const topic = `${config.mqtt.topicPrefix}/${factoryId}/${config.mqtt.topicSuffix}`;
    
    try {
        mqttClient.publish(topic, JSON.stringify(message), { qos: config.mqtt.qos }, (err) => {
            if (err) {
                logger.error(`Failed to publish heartbeat`, { error: err.message });
                stats.errors++;
            } else {
                stats.heartbeatsSent++;
                logger.debug(`Heartbeat sent`, { 
                    factoryId, 
                    sequence: message.sequence,
                    status: message.status
                });
            }
        });
    } catch (error) {
        logger.error(`Error sending heartbeat`, { error: error.message });
        stats.errors++;
    }
}

/**
 * Connect to MQTT broker
 */
function connectMqtt() {
    return new Promise((resolve, reject) => {
        logger.info(`Connecting to MQTT broker`, { 
            url: mqttBrokerUrl, 
            factoryId 
        });
        
        mqttClient = mqtt.connect(mqttBrokerUrl, {
            clientId: `${factoryId}-${Date.now()}`,
            reconnectPeriod: config.mqtt.reconnectPeriod,
            clean: true
        });
        
        mqttClient.on('connect', () => {
            logger.info(`Connected to MQTT broker`, { factoryId });
            resolve();
        });
        
        mqttClient.on('error', (error) => {
            logger.error(`MQTT error`, { error: error.message, factoryId });
            stats.errors++;
        });
        
        mqttClient.on('reconnect', () => {
            logger.info(`Reconnecting to MQTT broker...`, { factoryId });
            stats.reconnects++;
        });
        
        mqttClient.on('close', () => {
            logger.warn(`MQTT connection closed`, { factoryId });
        });
        
        mqttClient.on('offline', () => {
            logger.warn(`MQTT client offline`, { factoryId });
        });
        
        // Timeout for initial connection
        setTimeout(() => {
            if (!mqttClient.connected) {
                reject(new Error('MQTT connection timeout'));
            }
        }, 10000);
    });
}

/**
 * Start heartbeat sending
 */
function startHeartbeats() {
    logger.info(`Starting heartbeats`, { 
        factoryId, 
        intervalMs: heartbeatIntervalMs,
        simulateFailures,
        failureProbability
    });
    
    // Send first heartbeat immediately
    sendHeartbeat();
    
    // Add jitter to interval
    const jitteredInterval = heartbeatIntervalMs + randomInRange(-config.heartbeat.jitterMs, config.heartbeat.jitterMs);
    
    heartbeatInterval = setInterval(() => {
        sendHeartbeat();
    }, jitteredInterval);
}

/**
 * Stop heartbeats
 */
function stopHeartbeats() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
}

/**
 * Print statistics
 */
function printStats() {
    logger.info(`Factory simulator statistics`, {
        factoryId,
        heartbeatsSent: stats.heartbeatsSent,
        failures: stats.failures,
        reconnects: stats.reconnects,
        errors: stats.errors,
        isInFailureState,
        isDegraded
    });
}

/**
 * Graceful shutdown
 */
function shutdown() {
    logger.info(`Shutting down factory simulator`, { factoryId });
    
    stopHeartbeats();
    
    if (mqttClient) {
        mqttClient.end(true);
    }
    
    printStats();
    logger.info(`Factory simulator shutdown complete`, { factoryId });
    process.exit(0);
}

/**
 * Main entry point
 */
async function main() {
    logger.info(`Starting Factory Simulator`, {
        factoryId,
        mqttBroker: mqttBrokerUrl,
        heartbeatInterval: heartbeatIntervalMs,
        simulateFailures,
        failureProbability
    });
    
    try {
        await connectMqtt();
        startHeartbeats();
        
        // Print stats every 30 seconds
        setInterval(printStats, 30000);
        
        logger.info(`Factory simulator is running`, { factoryId });
    } catch (error) {
        logger.error(`Failed to start factory simulator`, { 
            error: error.message, 
            factoryId 
        });
        
        // Retry connection after delay
        setTimeout(main, 5000);
    }
}

// Handle shutdown signals
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    logger.error(`Uncaught exception`, { 
        error: error.message, 
        stack: error.stack, 
        factoryId 
    });
    shutdown();
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error(`Unhandled rejection`, { reason, factoryId });
});

// Start the simulator
main();
