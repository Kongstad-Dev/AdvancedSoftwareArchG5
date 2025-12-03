/**
 * Factory Simulator
 * 
 * Simulates a factory by publishing sensor readings to MQTT.
 * Sensors: Temperature (6), Level (6), Quality (8) = 20 sensors per factory
 * Can simulate sensor failures and warning states.
 * Load affects sensor readings - more orders = higher temperatures, more wear.
 */

const mqtt = require('mqtt');
const axios = require('axios');
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
const sensorReadingIntervalMs = parseInt(process.env.SENSOR_READING_INTERVAL_MS) || config.sensorReadingIntervalMs;
const simulateFailures = process.env.SIMULATE_FAILURES === 'true';
const failureProbability = parseFloat(process.env.FAILURE_PROBABILITY) || config.simulation.failureProbability;
const pmsUrl = process.env.PMS_URL || 'http://pms:3000';

// State
let mqttClient = null;
let sensorInterval = null;

// Factory load state (affected by orders)
let currentLoad = {
    orderCount: 0,
    maxCapacity: 2,
    loadFactor: 0 // 0.0 to 1.0
};

// Initialize sensors state
const sensors = {
    temperature: [],
    level: [],
    quality: []
};

// Statistics
const stats = {
    readingsSent: 0,
    failures: 0,
    warnings: 0,
    reconnects: 0,
    errors: 0
};

/**
 * Initialize all sensors for the factory
 */
function initializeSensors() {
    // Temperature sensors
    for (let i = 0; i < config.sensors.temperature.count; i++) {
        sensors.temperature.push({
            id: `${factoryId}-temp-${i + 1}`,
            type: 'temperature',
            zone: config.sensors.temperature.zones[i],
            status: 'OK',
            failureEndTime: null
        });
    }
    
    // Level sensors
    for (let i = 0; i < config.sensors.level.count; i++) {
        sensors.level.push({
            id: `${factoryId}-level-${i + 1}`,
            type: 'level',
            zone: config.sensors.level.zones[i],
            status: 'OK',
            failureEndTime: null
        });
    }
    
    // Quality sensors
    for (const qualitySensor of config.sensors.quality.types) {
        sensors.quality.push({
            id: `${factoryId}-${qualitySensor.name}`,
            type: 'quality',
            metric: qualitySensor.metric,
            name: qualitySensor.name,
            normalRange: qualitySensor.normalRange,
            warningRange: qualitySensor.warningRange,
            unit: qualitySensor.unit,
            status: 'OK',
            failureEndTime: null
        });
    }
    
    const totalSensors = sensors.temperature.length + sensors.level.length + sensors.quality.length;
    logger.info(`Initialized ${totalSensors} sensors for ${factoryId}`);
}

/**
 * Generate random number in range
 */
function randomInRange(min, max) {
    return Math.random() * (max - min) + min;
}

/**
 * Check and update sensor failure states
 * Load affects failure probability
 */
function updateSensorStates() {
    const now = Date.now();
    
    // Calculate effective failure probability based on load
    // Higher load = higher failure probability
    const loadMultiplier = 1 + (currentLoad.loadFactor * 2); // Up to 3x failure rate at full load
    const effectiveFailureProbability = failureProbability * loadMultiplier;
    
    // Process all sensor types
    for (const sensorType of Object.values(sensors)) {
        for (const sensor of sensorType) {
            // Check if sensor should recover from failure
            if (sensor.status === 'FAILED' && sensor.failureEndTime && now >= sensor.failureEndTime) {
                sensor.status = 'OK';
                sensor.failureEndTime = null;
                logger.info(`Sensor ${sensor.id} recovered`);
            }
            
            // Check if sensor should fail (only if not already failed)
            if (sensor.status !== 'FAILED' && simulateFailures && Math.random() < effectiveFailureProbability) {
                sensor.status = 'FAILED';
                sensor.failureEndTime = now + config.simulation.failureDurationMs;
                stats.failures++;
                logger.warn(`Sensor ${sensor.id} failed (load factor: ${currentLoad.loadFactor.toFixed(2)}), will recover in ${config.simulation.failureDurationMs}ms`);
            }
        }
    }
}

/**
 * Generate temperature sensor reading
 * Load affects temperature - more orders = higher temperatures
 */
function generateTemperatureReading(sensor) {
    if (sensor.status === 'FAILED') {
        return null; // Failed sensor sends no data
    }
    
    const tempConfig = config.sensors.temperature;
    let value;
    let status = 'OK';
    
    // Calculate temperature increase based on load (up to 5°C increase at full load)
    const loadTempIncrease = currentLoad.loadFactor * 5;
    
    // Higher chance of warning at higher load
    const warningChance = 0.1 + (currentLoad.loadFactor * 0.2); // 10-30% warning chance
    
    if (Math.random() < warningChance) {
        // Generate value in warning range (either low or high)
        if (Math.random() < 0.5) {
            value = randomInRange(tempConfig.warningRange.min, tempConfig.normalRange.min);
        } else {
            value = randomInRange(tempConfig.normalRange.max, tempConfig.warningRange.max) + loadTempIncrease;
        }
        status = 'WARNING';
        stats.warnings++;
    } else {
        // Normal value with load-based increase
        value = randomInRange(tempConfig.normalRange.min, tempConfig.normalRange.max) + (loadTempIncrease * 0.5);
    }
    
    return {
        sensor_id: sensor.id,
        factory_id: factoryId,
        type: 'temperature',
        zone: sensor.zone,
        value: parseFloat(value.toFixed(1)),
        unit: tempConfig.unit,
        status: status,
        timestamp: new Date().toISOString()
    };
}

/**
 * Generate level sensor reading
 * Load affects level fluctuation - more orders = more level changes
 */
function generateLevelReading(sensor) {
    if (sensor.status === 'FAILED') {
        return null;
    }
    
    const levelConfig = config.sensors.level;
    let value;
    let status = 'OK';
    
    // Higher chance of warning at higher load (tanks being used more)
    const warningChance = 0.1 + (currentLoad.loadFactor * 0.15); // 10-25% warning chance
    
    if (Math.random() < warningChance) {
        if (Math.random() < 0.5) {
            value = randomInRange(levelConfig.warningRange.min, levelConfig.normalRange.min);
        } else {
            value = randomInRange(levelConfig.normalRange.max, levelConfig.warningRange.max);
        }
        status = 'WARNING';
        stats.warnings++;
    } else {
        value = randomInRange(levelConfig.normalRange.min, levelConfig.normalRange.max);
    }
    
    return {
        sensor_id: sensor.id,
        factory_id: factoryId,
        type: 'level',
        zone: sensor.zone,
        value: parseFloat(value.toFixed(1)),
        unit: levelConfig.unit,
        status: status,
        timestamp: new Date().toISOString()
    };
}

/**
 * Generate quality sensor reading (pH, color, or weight)
 * Load affects quality - more orders = more quality variation
 */
function generateQualityReading(sensor) {
    if (sensor.status === 'FAILED') {
        return null;
    }
    
    let value;
    let status = 'OK';
    
    // Higher chance of warning at higher load (quality control harder with more production)
    const warningChance = 0.1 + (currentLoad.loadFactor * 0.15); // 10-25% warning chance
    
    if (Math.random() < warningChance) {
        if (Math.random() < 0.5) {
            value = randomInRange(sensor.warningRange.min, sensor.normalRange.min);
        } else {
            value = randomInRange(sensor.normalRange.max, sensor.warningRange.max);
        }
        status = 'WARNING';
        stats.warnings++;
    } else {
        value = randomInRange(sensor.normalRange.min, sensor.normalRange.max);
    }
    
    // Format based on metric type
    if (sensor.metric === 'ph') {
        value = parseFloat(value.toFixed(2));
    } else if (sensor.metric === 'color') {
        value = Math.round(value);
    } else if (sensor.metric === 'weight') {
        value = parseFloat(value.toFixed(1));
    }
    
    return {
        sensor_id: sensor.id,
        factory_id: factoryId,
        type: 'quality',
        metric: sensor.metric,
        value: value,
        unit: sensor.unit,
        status: status,
        timestamp: new Date().toISOString()
    };
}

/**
 * Publish sensor reading to MQTT
 */
function publishSensorReading(sensorType, reading) {
    if (!reading) return;
    
    const topic = `${config.mqtt.topicPrefix}/${factoryId}/sensors/${sensorType}/${reading.sensor_id}`;
    
    try {
        mqttClient.publish(topic, JSON.stringify(reading), { qos: config.mqtt.qos }, (err) => {
            if (err) {
                logger.error(`Failed to publish sensor reading`, { error: err.message, sensor: reading.sensor_id });
                stats.errors++;
            } else {
                stats.readingsSent++;
                logger.debug(`Sensor reading sent`, { sensor: reading.sensor_id, value: reading.value, status: reading.status });
            }
        });
    } catch (error) {
        logger.error(`Error publishing sensor reading`, { error: error.message });
        stats.errors++;
    }
}

/**
 * Send all sensor readings
 */
function sendSensorReadings() {
    updateSensorStates();
    
    // Temperature sensors
    for (const sensor of sensors.temperature) {
        const reading = generateTemperatureReading(sensor);
        publishSensorReading('temperature', reading);
    }
    
    // Level sensors
    for (const sensor of sensors.level) {
        const reading = generateLevelReading(sensor);
        publishSensorReading('level', reading);
    }
    
    // Quality sensors
    for (const sensor of sensors.quality) {
        const reading = generateQualityReading(sensor);
        publishSensorReading('quality', reading);
    }
}

/**
 * Connect to MQTT broker
 */
function connectMqtt() {
    return new Promise((resolve, reject) => {
        logger.info(`Connecting to MQTT broker`, { url: mqttBrokerUrl, factoryId });
        
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
        
        setTimeout(() => {
            if (!mqttClient.connected) {
                reject(new Error('MQTT connection timeout'));
            }
        }, 10000);
    });
}

/**
 * Start sensor reading loop
 */
function startSensorReadings() {
    logger.info(`Starting sensor readings`, { 
        factoryId, 
        intervalMs: sensorReadingIntervalMs,
        simulateFailures,
        failureProbability,
        totalSensors: sensors.temperature.length + sensors.level.length + sensors.quality.length
    });
    
    // Send first readings immediately
    sendSensorReadings();
    
    sensorInterval = setInterval(sendSensorReadings, sensorReadingIntervalMs);
}

/**
 * Stop sensor readings
 */
function stopSensorReadings() {
    if (sensorInterval) {
        clearInterval(sensorInterval);
        sensorInterval = null;
    }
}

/**
 * Print statistics
 */
function printStats() {
    const totalSensors = sensors.temperature.length + sensors.level.length + sensors.quality.length;
    const failedSensors = 
        sensors.temperature.filter(s => s.status === 'FAILED').length +
        sensors.level.filter(s => s.status === 'FAILED').length +
        sensors.quality.filter(s => s.status === 'FAILED').length;
    
    logger.info(`Factory simulator statistics`, {
        factoryId,
        readingsSent: stats.readingsSent,
        sensorFailures: stats.failures,
        sensorWarnings: stats.warnings,
        currentlyFailed: failedSensors,
        totalSensors: totalSensors,
        healthPercentage: Math.round(((totalSensors - failedSensors) / totalSensors) * 100),
        currentLoad: currentLoad.orderCount,
        loadFactor: currentLoad.loadFactor.toFixed(2),
        reconnects: stats.reconnects,
        errors: stats.errors
    });
}

/**
 * Fetch current load from PMS
 */
async function fetchCurrentLoad() {
    try {
        const response = await axios.get(`${pmsUrl}/orders?factoryId=${factoryId}`);
        const orders = response.data.data || [];
        
        // Count active orders (assigned or in_progress)
        const activeOrders = orders.filter(o => 
            o.status === 'assigned' || o.status === 'in_progress'
        );
        
        currentLoad.orderCount = activeOrders.length;
        currentLoad.loadFactor = Math.min(1, activeOrders.length / currentLoad.maxCapacity);
        
        logger.debug(`Load updated`, { 
            factoryId, 
            orderCount: currentLoad.orderCount, 
            loadFactor: currentLoad.loadFactor 
        });
    } catch (error) {
        // Silently fail - load fetch is optional enhancement
        logger.debug(`Failed to fetch load`, { error: error.message });
    }
}

/**
 * Start load monitoring
 */
function startLoadMonitoring() {
    // Fetch load every 2 seconds
    setInterval(fetchCurrentLoad, 2000);
    // Initial fetch
    fetchCurrentLoad();
}

/**
 * Graceful shutdown
 */
function shutdown() {
    logger.info(`Shutting down factory simulator`, { factoryId });
    
    stopSensorReadings();
    
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
        sensorReadingInterval: sensorReadingIntervalMs,
        simulateFailures,
        failureProbability,
        pmsUrl
    });
    
    // Initialize sensors
    initializeSensors();
    
    try {
        await connectMqtt();
        startSensorReadings();
        startLoadMonitoring();
        
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
