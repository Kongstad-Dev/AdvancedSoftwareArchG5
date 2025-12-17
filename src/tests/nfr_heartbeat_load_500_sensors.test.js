const mqtt = require('mqtt');
const { MongoClient } = require('mongodb');
const { expect } = require('chai');

describe('NFR: Heartbeat Load Test - 500 Sensors', function () {
    this.timeout(120000); // 2 minutes for load test

    it('should handle 500 concurrent sensors sending heartbeats within acceptable latency', async function () {
        const mqttClient = mqtt.connect('mqtt://localhost:1883');
        await new Promise(resolve => mqttClient.on('connect', resolve));

        const mongoClient = await MongoClient.connect('mongodb://mms_user:mms_password@localhost:27018');
        const db = mongoClient.db('monitoring_db');
        const heartbeatCollection = db.collection('heartbeats');

        let latencies = [];
        const numSensors = 500;
        const factories = ['F1', 'F2', 'F3', 'F4'];

        console.log(`\n=== Load Testing with ${numSensors} Sensors ===`);
        console.log('Generating sensor heartbeats...\n');

        // Generate sensor configurations
        const sensors = [];
        for (let i = 0; i < numSensors; i++) {
            const factoryId = factories[i % factories.length];
            const sensorId = `LOAD-S${factoryId.substring(1)}-${i}`;
            sensors.push({
                sensorId,
                factoryId,
                tier: `${Math.floor(i / 100) + 1}.${(i % 100) % 3 + 1}`
            });
        }

        console.log(`Created ${sensors.length} sensor configurations across ${factories.length} factories`);

        // Send heartbeats from all sensors
        const startTime = Date.now();
        const heartbeatPromises = sensors.map(async (sensor, index) => {
            const sentTime = Date.now();
            const heartbeat = {
                sensorId: sensor.sensorId,
                factoryId: sensor.factoryId,
                tier: sensor.tier,
                timestamp: new Date(sentTime).toISOString(),
                status: 'active'
            };

            // Publish with QoS 1 for guaranteed delivery
            await new Promise((resolve, reject) => {
                mqttClient.publish(
                    `factory/${sensor.factoryId}/heartbeat`,
                    JSON.stringify(heartbeat),
                    { qos: 1 },
                    (err) => {
                        if (err) reject(err);
                        else resolve();
                    }
                );
            });

            // Wait a bit then check MongoDB
            await new Promise(resolve => setTimeout(resolve, 1500));

            const storedHeartbeat = await heartbeatCollection.findOne(
                {
                    factory_id: sensor.factoryId,
                    'metrics.sensor_id': sensor.sensorId
                },
                { sort: { recorded_at: -1 } }
            );

            if (storedHeartbeat) {
                const receivedTime = new Date(storedHeartbeat.recorded_at).getTime();
                const latency = receivedTime - sentTime;

                if (latency > 0 && latency < 30000) { // Sanity check: within 30 seconds
                    return {
                        sensorId: sensor.sensorId,
                        factoryId: sensor.factoryId,
                        latency,
                        success: true
                    };
                }
            }

            return {
                sensorId: sensor.sensorId,
                factoryId: sensor.factoryId,
                latency: null,
                success: false
            };
        });

        console.log('Waiting for all heartbeats to be processed...');
        const results = await Promise.all(heartbeatPromises);
        const totalTime = Date.now() - startTime;

        // Analyze results
        const successfulResults = results.filter(r => r.success);
        latencies = successfulResults.map(r => r.latency);

        const avgLatency = latencies.length > 0
            ? latencies.reduce((a, b) => a + b, 0) / latencies.length
            : 0;
        const maxLatency = latencies.length > 0 ? Math.max(...latencies) : 0;
        const minLatency = latencies.length > 0 ? Math.min(...latencies) : 0;
        const successRate = (successfulResults.length / numSensors) * 100;

        // Calculate percentiles
        const sortedLatencies = [...latencies].sort((a, b) => a - b);
        const p50 = sortedLatencies[Math.floor(sortedLatencies.length * 0.5)] || 0;
        const p95 = sortedLatencies[Math.floor(sortedLatencies.length * 0.95)] || 0;
        const p99 = sortedLatencies[Math.floor(sortedLatencies.length * 0.99)] || 0;

        console.log('\n=== Load Test Results ===');
        console.log(`Total sensors: ${numSensors}`);
        console.log(`Successfully processed: ${successfulResults.length} (${successRate.toFixed(1)}%)`);
        console.log(`Total test duration: ${(totalTime / 1000).toFixed(2)}s`);
        console.log('\n=== Latency Statistics ===');
        console.log(`Average latency: ${avgLatency.toFixed(2)}ms`);
        console.log(`Min latency: ${minLatency}ms`);
        console.log(`Max latency: ${maxLatency}ms`);
        console.log(`P50 (median): ${p50}ms`);
        console.log(`P95: ${p95}ms`);
        console.log(`P99: ${p99}ms`);

        // Group by factory
        const factoryStats = {};
        factories.forEach(fid => {
            const factoryResults = successfulResults.filter(r => r.factoryId === fid);
            const factoryLatencies = factoryResults.map(r => r.latency);
            const factoryAvg = factoryLatencies.length > 0
                ? factoryLatencies.reduce((a, b) => a + b, 0) / factoryLatencies.length
                : 0;

            factoryStats[fid] = {
                count: factoryResults.length,
                avgLatency: factoryAvg
            };
        });

        console.log('\n=== Per-Factory Statistics ===');
        Object.entries(factoryStats).forEach(([fid, stats]) => {
            console.log(`${fid}: ${stats.count} sensors, avg latency: ${stats.avgLatency.toFixed(2)}ms`);
        });

        // Assertions
        expect(successfulResults.length).to.be.greaterThan(0, 'Should have processed some heartbeats');
        expect(successRate).to.be.at.least(80, 'At least 80% of heartbeats should be processed successfully');
        expect(avgLatency).to.be.lessThan(5000, 'Average latency should be < 5s under load');
        expect(p95).to.be.lessThan(10000, 'P95 latency should be < 10s');

        const within3Seconds = latencies.filter(l => l < 3000).length;
        const percentageWithin3s = (within3Seconds / latencies.length) * 100;
        console.log(`\nMessages within 3s: ${percentageWithin3s.toFixed(1)}%`);

        expect(percentageWithin3s).to.be.at.least(70, 'At least 70% of heartbeats should be processed within 3s');

        // Cleanup
        mqttClient.end();
        await mongoClient.close();
    });
});
