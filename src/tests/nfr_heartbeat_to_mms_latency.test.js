const mqtt = require('mqtt');
const { MongoClient } = require('mongodb');
const { expect } = require('chai');

describe('NFR2: Performance - Heartbeat to MMS Detection Latency', function () {
    this.timeout(30000);

    it('should detect and store heartbeat in MMS MongoDB within 2 seconds', async function () {
        const mqttClient = mqtt.connect('mqtt://localhost:1883');
        await new Promise(resolve => mqttClient.on('connect', resolve));

        const mongoClient = await MongoClient.connect('mongodb://mms_user:mms_password@localhost:27018');
        const db = mongoClient.db('monitoring_db');
        const heartbeatCollection = db.collection('heartbeats');

        let latencies = [];
        const testFactoryId = 'F1'; // Use real factory

        console.log(`Testing heartbeat latency for factory: ${testFactoryId}`);

        // Send 10 heartbeat messages and measure latency
        for (let i = 0; i < 10; i++) {
            const sentTime = Date.now();
            const heartbeat = {
                sensorId: 'S1-1',
                factoryId: testFactoryId,
                tier: '1.1',
                timestamp: new Date(sentTime).toISOString(),
                status: 'active'
            };

            mqttClient.publish(`factory/${testFactoryId}/heartbeat`, JSON.stringify(heartbeat), { qos: 1 });

            // Wait a bit then check if it's in MongoDB
            await new Promise(resolve => setTimeout(resolve, 800));

            const storedHeartbeat = await heartbeatCollection.findOne(
                { factory_id: testFactoryId },
                { sort: { recorded_at: -1 } }
            );

            if (storedHeartbeat) {
                const receivedTime = new Date(storedHeartbeat.recorded_at).getTime();
                const latency = receivedTime - sentTime;

                if (latency > 0 && latency < 10000) { // Sanity check
                    latencies.push(latency);
                }
            }

            await new Promise(resolve => setTimeout(resolve, 200));
        }

        // Calculate statistics
        const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
        const maxLatency = Math.max(...latencies);
        const minLatency = Math.min(...latencies);

        console.log('\n=== Heartbeat → MMS MongoDB Latency Statistics ===');
        console.log(`Messages tested: ${latencies.length}`);
        console.log(`Average latency: ${avgLatency.toFixed(2)}ms`);
        console.log(`Min latency: ${minLatency}ms`);
        console.log(`Max latency: ${maxLatency}ms`);

        // NFR Assertion: Average latency should be under 2 seconds
        const within2Seconds = latencies.filter(l => l < 2000).length;
        const percentageWithin2s = (within2Seconds / latencies.length) * 100;

        console.log(`Messages within 2s: ${percentageWithin2s.toFixed(1)}%`);

        expect(latencies.length).to.be.greaterThan(0, 'Should have captured some latencies');
        expect(avgLatency).to.be.lessThan(2000, 'Average latency should be < 2s');
        expect(percentageWithin2s).to.be.at.least(90, 'At least 90% of heartbeats should be stored within 2s');

        // Cleanup
        mqttClient.end();
        await mongoClient.close();
    });
});
