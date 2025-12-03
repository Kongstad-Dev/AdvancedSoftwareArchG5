/**
 * Factory Simulator Configuration
 */

module.exports = {
    // Default factory IDs
    defaultFactoryIds: ['factory-1', 'factory-2', 'factory-3', 'factory-4'],
    
    // MQTT settings
    mqtt: {
        brokerUrl: process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883',
        topicPrefix: 'factory',
        topicSuffix: 'heartbeat',
        reconnectPeriod: 5000,
        qos: 1
    },
    
    // Heartbeat settings
    heartbeat: {
        intervalMs: parseInt(process.env.HEARTBEAT_INTERVAL_MS) || 1000,
        jitterMs: 100  // Random jitter to add realism
    },
    
    // Simulation settings
    simulation: {
        // Whether to simulate failures
        simulateFailures: process.env.SIMULATE_FAILURES === 'true',
        
        // Probability of failure per heartbeat cycle (0.0 - 1.0)
        failureProbability: parseFloat(process.env.FAILURE_PROBABILITY) || 0.0,
        
        // Duration of simulated failure in ms
        failureDurationMs: parseInt(process.env.FAILURE_DURATION_MS) || 10000,
        
        // Whether to simulate degraded state
        simulateDegraded: process.env.SIMULATE_DEGRADED === 'true',
        
        // Probability of degraded state
        degradedProbability: parseFloat(process.env.DEGRADED_PROBABILITY) || 0.05
    },
    
    // Metrics ranges for simulation
    metrics: {
        cpu: {
            min: 20,
            max: 80,
            spike: 95
        },
        memory: {
            min: 30,
            max: 70,
            spike: 90
        },
        latency: {
            min: 10,
            max: 100,
            spike: 2000
        },
        errors: {
            normal: 0,
            degraded: 2,
            spike: 10
        }
    }
};
