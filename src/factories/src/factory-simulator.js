/**
 * Factory Simulator
 * 
 * Simulates factories with sensors that:
 * - Send heartbeats to MQTT topic factory/{factoryId}/heartbeat
 * - Send sensor readings to MQTT topic factory/{factoryId}/readings
 * - Process production orders from configuration
 * - MQTT messages are bridged to Kafka topics SENSOR_HEARTBEAT and SENSOR_READINGS
 */

const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');

// Configuration
const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtt://localhost:1883';
const FACTORY_ID = process.env.FACTORY_ID || 'F1';
const CONFIG_FILE = process.env.CONFIG_FILE || '/app/config/factory_config.json';
const CONFIG_POLL_INTERVAL = parseInt(process.env.CONFIG_POLL_INTERVAL) || 3000; // 3 seconds
const HEARTBEAT_INTERVAL = parseInt(process.env.HEARTBEAT_INTERVAL) || 1000;
const READING_INTERVAL_MIN = parseInt(process.env.READING_INTERVAL_MIN) || 2000;
const READING_INTERVAL_MAX = parseInt(process.env.READING_INTERVAL_MAX) || 5000;

// MQTT setup
let mqttClient = null;

/**
 * Sensor class - handles heartbeats and readings
 */
class Sensor {
    constructor(sensorId, tier, mqttClient, factoryId) {
        this.sensorId = sensorId;
        this.tier = tier;
        this.mqttClient = mqttClient;
        this.factoryId = factoryId;
        this.heartbeatInterval = null;
        this.isRunning = false;
        this.isFailed = false;
    }

    /**
     * Start sending heartbeats
     */
    startHeartbeat() {
        this.isRunning = true;
        this.heartbeatInterval = setInterval(() => {
            if (!this.isRunning || this.isFailed) return;

            const heartbeatData = {
                sensorId: this.sensorId,
                tier: this.tier,
                factoryId: this.factoryId,
                timestamp: new Date().toISOString(),
                status: 'active'
            };

            const topic = `factory/${this.factoryId}/heartbeat`;

            this.mqttClient.publish(topic, JSON.stringify(heartbeatData), { qos: 1 }, (err) => {
                if (err) {
                    console.error(`Error sending heartbeat from ${this.sensorId}:`, err.message);
                } else {
                    console.log(`[${heartbeatData.timestamp}] Heartbeat from Sensor ${this.sensorId} -> MQTT`);
                }
            });
        }, HEARTBEAT_INTERVAL + Math.random() * 1000); // Add jitter
    }

    /**
     * Stop sending heartbeats
     */
    stopHeartbeat() {
        this.isRunning = false;
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    /**
     * Generate sensor reading (0-100)
     * Marks sensor as failed if reading < 10
     */
    generateReading() {
        if (this.isFailed) {
            return -1; // Failed sensor returns -1
        }

        const reading = Math.floor(Math.random() * 101);

        // Detect failure if reading is below threshold
        if (reading < 10) {
            this.markAsFailed(reading);
            return reading;
        }

        return reading;
    }

    /**
     * Mark sensor as failed and notify
     */
    markAsFailed(failedReading) {
        if (this.isFailed) return; // Already marked

        this.isFailed = true;
        this.isRunning = false;

        // Stop heartbeat interval
        this.stopHeartbeat();

        console.error(`❌ SENSOR FAILURE: ${this.sensorId} - Reading: ${failedReading} (below threshold < 10)`);

        // Publish failure notification
        const failureData = {
            factoryId: this.factoryId,
            sensorId: this.sensorId,
            tier: this.tier,
            reading: failedReading,
            timestamp: new Date().toISOString(),
            reason: 'Reading below threshold (< 10)'
        };

        const topic = `factory/${this.factoryId}/sensor-failure`;
        this.mqttClient.publish(topic, JSON.stringify(failureData), { qos: 1 }, (err) => {
            if (err) {
                console.error(`Error publishing sensor failure:`, err.message);
            } else {
                console.log(`🚨 Published sensor failure notification for ${this.sensorId}`);
            }
        });
    }

    /**
     * Recover sensor (used after factory restart)
     */
    recover() {
        this.isFailed = false;
        this.isRunning = true;
        console.log(`✅ Sensor ${this.sensorId} recovered`);
    }
}

/**
 * Factory class - manages sensors and processes production orders
 */
class Factory {
    constructor(factoryId, mqttClient) {
        this.factoryId = factoryId;
        this.mqttClient = mqttClient;
        this.sensors = new Map();
        this.isProcessing = false;
        this.lastConfigHash = null;
    }

    /**
     * Add a sensor to the factory
     */
    addSensor(sensor) {
        this.sensors.set(sensor.sensorId, sensor);
    }

    /**
     * Get a sensor by ID
     */
    getSensor(sensorId) {
        return this.sensors.get(sensorId);
    }

    /**
     * Process a single soda production item
     */
    async processSodaItem(sodaName, number, sensorId, completedOffset = 0) {
        let sensor = this.getSensor(sensorId);

        // If assigned sensor is not found or failed, find first available healthy sensor
        if (!sensor || sensor.isFailed) {
            console.warn(`⚠️  Assigned sensor ${sensorId} is ${!sensor ? 'not found' : 'FAILED'} - finding replacement...`);

            // Find first healthy sensor
            for (const [id, s] of this.sensors.entries()) {
                if (!s.isFailed) {
                    sensor = s;
                    sensorId = id;
                    console.log(`✅ Using replacement sensor ${sensorId} instead`);
                    break;
                }
            }

            if (!sensor || sensor.isFailed) {
                console.error(`❌ No healthy sensors available in Factory ${this.factoryId}`);
                return;
            }
        }

        const totalTarget = completedOffset + number;
        console.log(`\n📊 Factory ${this.factoryId} - Processing: ${sodaName}`);
        console.log(`   Sensor: ${sensorId} (Tier ${sensor.tier})`);
        console.log(`   Remaining: ${number} (Progress: ${completedOffset}/${totalTarget})`);

        for (let count = 1; count <= number; count++) {
            const reading = sensor.generateReading();

            // Check if sensor failed during reading
            if (sensor.isFailed) {
                console.error(`   ❌ Sensor ${sensorId} FAILED during production at ${count}/${number}`);
                break; // Stop processing this order
            }

            const timestamp = new Date().toISOString();

            const absoluteCount = completedOffset + count;
            const readingData = {
                factoryId: this.factoryId,
                sensorId: sensorId,
                tier: sensor.tier,
                sodaName: sodaName,
                reading: reading,
                count: absoluteCount,
                total: totalTarget,
                timestamp: timestamp
            };

            const topic = `factory/${this.factoryId}/readings`;

            await new Promise((resolve, reject) => {
                this.mqttClient.publish(topic, JSON.stringify(readingData), { qos: 1 }, (err) => {
                    if (err) {
                        console.error(`   Error sending reading to MQTT:`, err.message);
                        reject(err);
                    } else {
                        console.log(`   Factory ${this.factoryId} [${timestamp}] Reading #${absoluteCount}/${totalTarget}: ${reading} -> MQTT`);
                        resolve();
                    }
                });
            });

            // Wait before next reading (except for last one)
            if (count < number) {
                const delay = READING_INTERVAL_MIN + Math.random() * (READING_INTERVAL_MAX - READING_INTERVAL_MIN);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        console.log(`   ✅ Factory ${this.factoryId} completed ${sodaName}`);
    }

    /**
     * Load and process configuration file
     */
    async loadAndProcessConfig(configFile) {
        try {
            // Check if config file exists
            if (!fs.existsSync(configFile)) {
                // Config file doesn't exist yet - this is normal, just wait
                return;
            }

            // Read and hash config to detect changes
            const configContent = fs.readFileSync(configFile, 'utf8');
            const configHash = require('crypto').createHash('md5').update(configContent).digest('hex');

            // Skip if same config and already processing
            if (this.lastConfigHash === configHash) {
                console.log(`   No new work for Factory ${this.factoryId}`);
                return;
            }

            const configData = JSON.parse(configContent);

            // Get configuration for this specific factory
            const factoryConfig = configData[this.factoryId];

            if (!factoryConfig || !Array.isArray(factoryConfig) || factoryConfig.length === 0) {
                console.log(`   No work assigned to Factory ${this.factoryId}`);
                this.lastConfigHash = configHash;
                return;
            }

            console.log(`\n${'='.repeat(60)}`);
            console.log(`Factory ${this.factoryId} - Processing Active Order`);
            console.log(`Items in queue: ${factoryConfig.length}`);
            console.log(`${'='.repeat(60)}`);

            this.isProcessing = true;
            this.lastConfigHash = configHash;

            // Process ONLY the first item (active order) - queue system
            const activeOrder = factoryConfig[0];
            const { sodaName, number, sensorID, completedOffset } = activeOrder;

            if (!sodaName || number == null || !sensorID) {
                console.warn(`⚠️  Invalid active order config:`, activeOrder);
            } else {
                console.log(`📦 Active Order: ${sodaName} x${number} using ${sensorID}`);
                await this.processSodaItem(sodaName, number, sensorID, completedOffset || 0);
            }

            console.log(`\n${'='.repeat(60)}`);
            console.log(`Factory ${this.factoryId} - Active Order Complete`);
            console.log(`${'='.repeat(60)}\n`);

            this.isProcessing = false;

        } catch (error) {
            this.isProcessing = false;

            if (error.code === 'ENOENT') {
                // File doesn't exist - silently continue
                return;
            } else if (error instanceof SyntaxError) {
                console.error(`❌ Error: Invalid JSON in file '${configFile}'`);
            } else {
                console.error(`❌ Error processing configuration:`, error.message);
            }
        }
    }

    /**
     * Start heartbeats for all sensors
     */
    startAllHeartbeats() {
        for (const sensor of this.sensors.values()) {
            sensor.startHeartbeat();
        }
    }

    /**
     * Stop heartbeats for all sensors
     */
    stopAllHeartbeats() {
        for (const sensor of this.sensors.values()) {
            sensor.stopHeartbeat();
        }
    }

    /**
     * Get all healthy (non-failed) sensors
     */
    getHealthySensors() {
        return Array.from(this.sensors.values()).filter(sensor => !sensor.isFailed);
    }

    /**
     * Get all failed sensors
     */
    getFailedSensors() {
        return Array.from(this.sensors.values()).filter(sensor => sensor.isFailed);
    }

    /**
     * Check if factory has any healthy sensors
     */
    hasHealthySensors() {
        return this.getHealthySensors().length > 0;
    }

    /**
     * Restart factory - recovers all sensors
     */
    restartFactory() {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`🔄 RESTARTING FACTORY ${this.factoryId}`);
        console.log(`${'='.repeat(60)}`);

        const failedSensors = this.getFailedSensors();
        console.log(`Recovering ${failedSensors.length} failed sensors...`);

        // Recover all failed sensors
        for (const sensor of failedSensors) {
            sensor.recover();
        }

        // Restart heartbeats
        this.startAllHeartbeats();

        console.log(`✅ Factory ${this.factoryId} restarted successfully`);
        console.log(`${'='.repeat(60)}\n`);

        // Publish restart notification
        const restartData = {
            factoryId: this.factoryId,
            timestamp: new Date().toISOString(),
            recoveredSensors: failedSensors.map(s => s.sensorId),
            totalSensors: this.sensors.size
        };

        const topic = `factory/${this.factoryId}/restart`;
        this.mqttClient.publish(topic, JSON.stringify(restartData), { qos: 1 }, (err) => {
            if (err) {
                console.error(`Error publishing restart notification:`, err.message);
            } else {
                console.log(`📢 Published factory restart notification`);
            }
        });
    }
}

/**
 * Create factories with sensors
 */
function createFactory(factoryId, mqttClient) {
    const factory = new Factory(factoryId, mqttClient);

    // Predefined sensor tiers
    const sensorTiers = ['1.1', '1.2', '2.1', '2.2', '3.1'];

    // Add 3-5 random sensors
    const numSensors = 3 + Math.floor(Math.random() * 3);
    for (let j = 1; j <= numSensors; j++) {
        const sensorId = `S${factoryId.replace('F', '')}-${j}`;
        const tier = sensorTiers[Math.floor(Math.random() * sensorTiers.length)];
        const sensor = new Sensor(sensorId, tier, mqttClient, factoryId);
        factory.addSensor(sensor);
    }

    const sensorIds = Array.from(factory.sensors.keys());
    console.log(`✅ Created Factory ${factoryId} with sensors: ${sensorIds.join(', ')}`);

    return factory;
}

/**
 * Main function
 */
async function main() {
    console.log('🏭 Factory System Starting...\n');

    try {
        // Connect to MQTT
        mqttClient = mqtt.connect(MQTT_BROKER, {
            clientId: `factory-${FACTORY_ID}-${Date.now()}`,
            clean: true,
            reconnectPeriod: 5000
        });

        await new Promise((resolve, reject) => {
            mqttClient.on('connect', () => {
                console.log(`✅ Connected to MQTT broker at ${MQTT_BROKER}\n`);
                resolve();
            });

            mqttClient.on('error', (error) => {
                console.error('MQTT connection error:', error.message);
                reject(error);
            });

            setTimeout(() => reject(new Error('MQTT connection timeout')), 10000);
        });

        // Create factory
        const factory = createFactory(FACTORY_ID, mqttClient);

        console.log(`\n${'='.repeat(60)}`);
        console.log(`Factory ${FACTORY_ID} initialized - RUNNING CONTINUOUSLY`);
        console.log(`Config polling interval: ${CONFIG_POLL_INTERVAL}ms`);
        console.log(`${'='.repeat(60)}\n`);

        console.log('📡 Publishing to MQTT topics:');
        console.log(`   - factory/${FACTORY_ID}/heartbeat (bridged to SENSOR_HEARTBEAT)`);
        console.log(`   - factory/${FACTORY_ID}/readings (bridged to SENSOR_READINGS)\n`);

        // Start heartbeats (continuous)
        factory.startAllHeartbeats();
        console.log('💓 Heartbeats started for all sensors\n');

        // Continuous polling loop
        console.log('🔄 Starting configuration polling...\n');

        let isShuttingDown = false;

        const pollConfig = async () => {
            if (isShuttingDown) return;

            // Check if factory needs restart (no healthy sensors)
            if (!factory.hasHealthySensors() && factory.getFailedSensors().length > 0) {
                console.warn(`⚠️  No healthy sensors available - triggering factory restart`);
                factory.restartFactory();
            }

            console.log(`[${new Date().toISOString()}] Checking for new work...`);
            await factory.loadAndProcessConfig(CONFIG_FILE);

            if (!isShuttingDown) {
                setTimeout(pollConfig, CONFIG_POLL_INTERVAL);
            }
        };

        // Start polling
        pollConfig();

        // Keep process alive indefinitely
        // The pollConfig function will reschedule itself via setTimeout
        await new Promise(() => { }); // Never resolves, keeps process running

    } catch (error) {
        console.error('❌ Fatal error:', error);
        process.exit(1);
    }
}

// Handle graceful shutdown
let isShuttingDown = false;

process.on('SIGINT', () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log('\n\n🛑 Shutting down gracefully...');
    if (mqttClient) {
        mqttClient.end();
    }
    process.exit(0);
});

process.on('SIGTERM', () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log('\n\n🛑 Shutting down gracefully...');
    if (mqttClient) {
        mqttClient.end();
    }
    process.exit(0);
});

// Run
main().catch(console.error);
