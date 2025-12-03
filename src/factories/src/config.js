/**
 * Factory Simulator Configuration
 * Sensor-based monitoring (Temperature, Level, Quality sensors)
 */

module.exports = {
    // Default factory IDs
    defaultFactoryIds: ['factory-1', 'factory-2', 'factory-3', 'factory-4'],
    
    // MQTT settings
    mqtt: {
        brokerUrl: process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883',
        topicPrefix: 'factory',
        reconnectPeriod: 5000,
        qos: 1
    },
    
    // Sensor reading interval
    sensorReadingIntervalMs: parseInt(process.env.SENSOR_READING_INTERVAL_MS) || 1000,
    
    // Simulation settings
    simulation: {
        // Whether to simulate sensor failures
        simulateFailures: process.env.SIMULATE_FAILURES === 'true',
        
        // Probability of sensor failure per reading cycle (0.0 - 1.0)
        failureProbability: parseFloat(process.env.FAILURE_PROBABILITY) || 0.0,
        
        // Duration of simulated failure in ms
        failureDurationMs: parseInt(process.env.FAILURE_DURATION_MS) || 15000
    },
    
    // Sensor definitions per factory
    // Each factory has: 6 temperature, 6 level, 8 quality sensors = 20 sensors total
    sensors: {
        temperature: {
            count: 6,
            zones: ['mixing-tank-1', 'mixing-tank-2', 'fermentation-1', 'fermentation-2', 'storage-1', 'storage-2'],
            normalRange: { min: 15, max: 30 },   // Normal: 15-30°C
            warningRange: { min: 10, max: 35 },  // Warning: 10-15 or 30-35°C
            unit: 'celsius'
        },
        level: {
            count: 6,
            zones: ['tank-1', 'tank-2', 'tank-3', 'tank-4', 'tank-5', 'tank-6'],
            normalRange: { min: 20, max: 80 },   // Normal: 20-80%
            warningRange: { min: 10, max: 90 },  // Warning: 10-20 or 80-90%
            unit: 'percentage'
        },
        quality: {
            count: 8,
            types: [
                { name: 'ph-1', metric: 'ph', normalRange: { min: 6.5, max: 7.5 }, warningRange: { min: 6.0, max: 8.0 }, unit: 'pH' },
                { name: 'ph-2', metric: 'ph', normalRange: { min: 6.5, max: 7.5 }, warningRange: { min: 6.0, max: 8.0 }, unit: 'pH' },
                { name: 'color-1', metric: 'color', normalRange: { min: 40, max: 60 }, warningRange: { min: 30, max: 70 }, unit: 'index' },
                { name: 'color-2', metric: 'color', normalRange: { min: 40, max: 60 }, warningRange: { min: 30, max: 70 }, unit: 'index' },
                { name: 'weight-1', metric: 'weight', normalRange: { min: 490, max: 510 }, warningRange: { min: 480, max: 520 }, unit: 'grams' },
                { name: 'weight-2', metric: 'weight', normalRange: { min: 490, max: 510 }, warningRange: { min: 480, max: 520 }, unit: 'grams' },
                { name: 'weight-3', metric: 'weight', normalRange: { min: 490, max: 510 }, warningRange: { min: 480, max: 520 }, unit: 'grams' },
                { name: 'weight-4', metric: 'weight', normalRange: { min: 490, max: 510 }, warningRange: { min: 480, max: 520 }, unit: 'grams' }
            ]
        }
    }
};
