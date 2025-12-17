const mqtt = require('mqtt');
const { MongoClient } = require('mongodb');
const { expect } = require('chai');

describe('NFR3: Scalability - 8 Factories Simultaneously', function () {
    this.timeout(120000);

    it('should handle 8 factories operating concurrently with acceptable performance', async function () {
        console.log('\n=== Testing 8 Concurrent Factories ===');

        const mqttClient = mqtt.connect('mqtt://localhost:1883');
        await new Promise(resolve => mqttClient.on('connect', resolve));

        const mongoClient = await MongoClient.connect('mongodb://mms_user:mms_password@localhost:27018');
        const db = mongoClient.db('monitoring_db');
        const heartbeatCollection = db.collection('heartbeats');

        const numFactories = 8;
        const sensorsPerFactory = 10; // 10 sensors per factory for this test
        const factories = [];

        // Generate factory IDs (F1-F4 exist, add F5-F8)
        for (let i = 1; i <= numFactories; i++) {
            factories.push(`F${i}`);
        }

        console.log(`Testing ${numFactories} factories with ${sensorsPerFactory} sensors each`);
        console.log(`Total sensors: ${numFactories * sensorsPerFactory}`);

        const results = [];
        const startTime = Date.now();

        // Send heartbeats from all factories simultaneously
        for (const factoryId of factories) {
            for (let s = 1; s <= sensorsPerFactory; s++) {
                const sensorId = `S${factoryId.substring(1)}-${s}`;
                const sentTime = Date.now();

                const heartbeat = {
                    sensorId,
                    factoryId,
                    tier: `${Math.floor(s / 5) + 1}.1`,
                    timestamp: new Date(sentTime).toISOString(),
                    status: 'active'
                };

                mqttClient.publish(
                    `factory/${factoryId}/heartbeat`,
                    JSON.stringify(heartbeat),
                    { qos: 1 }
                );

                results.push({ factoryId, sensorId, sentTime });
            }
        }

        console.log('\nWaiting for processing...');
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Check how many were processed
        const processed = [];
        for (const result of results) {
            const stored = await heartbeatCollection.findOne(
                {
                    factory_id: result.factoryId,
                    'metrics.sensor_id': result.sensorId
                },
                { sort: { recorded_at: -1 } }
            );

            if (stored) {
                const latency = new Date(stored.recorded_at).getTime() - result.sentTime;
                if (latency > 0 && latency < 30000) {
                    processed.push({ ...result, latency });
                }
            }
        }

        const totalTime = Date.now() - startTime;
        const successRate = (processed.length / results.length) * 100;
        const avgLatency = processed.reduce((sum, p) => sum + p.latency, 0) / processed.length;

        // Calculate per-factory stats
        const factoryStats = {};
        factories.forEach(fid => {
            const factoryProcessed = processed.filter(p => p.factoryId === fid);
            factoryStats[fid] = {
                sent: results.filter(r => r.factoryId === fid).length,
                processed: factoryProcessed.length,
                successRate: (factoryProcessed.length / sensorsPerFactory) * 100,
                avgLatency: factoryProcessed.length > 0
                    ? factoryProcessed.reduce((sum, p) => sum + p.latency, 0) / factoryProcessed.length
                    : 0
            };
        });

        console.log('\n=== 8 Factory Load Test Results ===');
        console.log(`Total test duration: ${(totalTime / 1000).toFixed(2)}s`);
        console.log(`Total heartbeats sent: ${results.length}`);
        console.log(`Successfully processed: ${processed.length} (${successRate.toFixed(1)}%)`);
        console.log(`Average latency: ${avgLatency.toFixed(2)}ms`);

        console.log('\n=== Per-Factory Statistics ===');
        Object.entries(factoryStats).forEach(([fid, stats]) => {
            console.log(`${fid}: ${stats.processed}/${stats.sent} processed (${stats.successRate.toFixed(1)}%), avg latency: ${stats.avgLatency.toFixed(2)}ms`);
        });

        // NFR Assertions
        expect(successRate).to.be.at.least(70, 'At least 70% of heartbeats should be processed with 8 factories');
        expect(avgLatency).to.be.lessThan(8000, 'Average latency should be < 8s with 8 factories');

        // Verify all factories processed at least some heartbeats
        const factoriesWithData = Object.values(factoryStats).filter(s => s.processed > 0).length;
        expect(factoriesWithData).to.equal(numFactories, 'All 8 factories should have processed heartbeats');

        mqttClient.end();
        await mongoClient.close();
    });
});

describe('NFR3: Scalability - 500 Sensors Per Factory', function () {
    this.timeout(180000); // 3 minutes

    it('should handle 500 sensors in a single factory with acceptable performance', async function () {
        console.log('\n=== Testing 500 Sensors in One Factory ===');

        const mqttClient = mqtt.connect('mqtt://localhost:1883');
        await new Promise(resolve => mqttClient.on('connect', resolve));

        const mongoClient = await MongoClient.connect('mongodb://mms_user:mms_password@localhost:27018');
        const db = mongoClient.db('monitoring_db');
        const heartbeatCollection = db.collection('heartbeats');

        const factoryId = 'F1';
        const numSensors = 500;
        const results = [];
        const startTime = Date.now();

        console.log(`Sending ${numSensors} heartbeats for factory ${factoryId}...`);

        // Send all heartbeats
        for (let i = 1; i <= numSensors; i++) {
            const sensorId = `LOAD-${factoryId}-S${i}`;
            const sentTime = Date.now();

            const heartbeat = {
                sensorId,
                factoryId,
                tier: `${Math.floor(i / 100) + 1}.${(i % 3) + 1}`,
                timestamp: new Date(sentTime).toISOString(),
                status: 'active'
            };

            mqttClient.publish(
                `factory/${factoryId}/heartbeat`,
                JSON.stringify(heartbeat),
                { qos: 1 }
            );

            results.push({ sensorId, sentTime });

            // Small delay to avoid overwhelming the system
            if (i % 50 === 0) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        console.log('All heartbeats sent. Waiting for processing...');
        await new Promise(resolve => setTimeout(resolve, 8000));

        // Check processing
        const processed = [];
        for (const result of results) {
            const stored = await heartbeatCollection.findOne(
                {
                    factory_id: factoryId,
                    'metrics.sensor_id': result.sensorId
                },
                { sort: { recorded_at: -1 } }
            );

            if (stored) {
                const latency = new Date(stored.recorded_at).getTime() - result.sentTime;
                if (latency > 0 && latency < 60000) {
                    processed.push({ ...result, latency });
                }
            }
        }

        const totalTime = Date.now() - startTime;
        const successRate = (processed.length / numSensors) * 100;
        const latencies = processed.map(p => p.latency);
        const avgLatency = latencies.reduce((sum, l) => sum + l, 0) / latencies.length;
        const sortedLatencies = [...latencies].sort((a, b) => a - b);
        const p95 = sortedLatencies[Math.floor(sortedLatencies.length * 0.95)] || 0;

        console.log('\n=== Single Factory 500 Sensor Test Results ===');
        console.log(`Factory: ${factoryId}`);
        console.log(`Total test duration: ${(totalTime / 1000).toFixed(2)}s`);
        console.log(`Sensors tested: ${numSensors}`);
        console.log(`Successfully processed: ${processed.length} (${successRate.toFixed(1)}%)`);
        console.log(`Average latency: ${avgLatency.toFixed(2)}ms`);
        console.log(`P95 latency: ${p95}ms`);
        console.log(`Throughput: ${(processed.length / (totalTime / 1000)).toFixed(2)} heartbeats/second`);

        // NFR Assertions
        expect(successRate).to.be.at.least(65, 'At least 65% should be processed with 500 sensors per factory');
        expect(avgLatency).to.be.lessThan(10000, 'Average latency should be < 10s with heavy load');
        expect(p95).to.be.lessThan(20000, 'P95 latency should be < 20s');

        mqttClient.end();
        await mongoClient.close();
    });
});
