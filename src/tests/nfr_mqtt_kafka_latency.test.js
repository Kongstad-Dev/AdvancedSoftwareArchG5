const mqtt = require('mqtt');
const { Kafka } = require('kafkajs');
const { expect } = require('chai');

describe('NFR2: Performance - MQTT → Kafka Communication Latency', function () {
    this.timeout(30000);

    it('should propagate sensor reading from MQTT to Kafka within 1 second', async function () {
        const kafka = new Kafka({
            clientId: 'latency-test',
            brokers: ['localhost:9092']
        });

        const consumer = kafka.consumer({ groupId: 'latency-test-group-' + Date.now() });
        await consumer.connect();
        await consumer.subscribe({ topic: 'factory.heartbeat', fromBeginning: false });

        const mqttClient = mqtt.connect('mqtt://localhost:1883');
        await new Promise(resolve => mqttClient.on('connect', resolve));

        let latencies = [];
        let mqttMessages = new Map(); // timestamp by sensorId

        // Listen to MQTT to capture send times
        mqttClient.subscribe('factory/+/heartbeat', { qos: 1 });
        mqttClient.on('message', (topic, message) => {
            try {
                const payload = JSON.parse(message.toString());
                const key = `${payload.factoryId}-${payload.sensorId}`;
                const timestamp = new Date(payload.timestamp).getTime();
                mqttMessages.set(key, { timestamp, received: Date.now() });
            } catch (e) {
                // Ignore parse errors
            }
        });

        // Consumer listens for messages from Kafka
        const messagePromise = new Promise((resolve) => {
            consumer.run({
                eachMessage: async ({ topic, partition, message }) => {
                    try {
                        const payload = JSON.parse(message.value.toString());
                        const key = `${payload.factory_id}-${payload.sensorId}`;
                        const kafkaReceivedTime = Date.now();

                        const mqttData = mqttMessages.get(key);
                        if (mqttData) {
                            // Calculate latency from original message timestamp
                            const originalTime = mqttData.timestamp;
                            const latency = kafkaReceivedTime - originalTime;

                            if (latency > 0 && latency < 10000) { // Sanity check
                                latencies.push(latency);

                                if (latencies.length >= 20) {
                                    resolve();
                                }
                            }
                        }
                    } catch (e) {
                        // Ignore parse errors
                    }
                }
            });
        });

        // Wait for consumer to be ready and collect messages
        console.log('Collecting heartbeat latency data...');
        await messagePromise;

        // Calculate statistics
        const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
        const maxLatency = Math.max(...latencies);
        const minLatency = Math.min(...latencies);

        console.log('\n=== MQTT → Kafka Latency Statistics (Heartbeats) ===');
        console.log(`Messages tested: ${latencies.length}`);
        console.log(`Average latency: ${avgLatency.toFixed(2)}ms`);
        console.log(`Min latency: ${minLatency}ms`);
        console.log(`Max latency: ${maxLatency}ms`);

        // NFR Assertion: 95% of messages should arrive within 1 second
        const within1Second = latencies.filter(l => l < 1000).length;
        const percentageWithin1s = (within1Second / latencies.length) * 100;

        console.log(`Messages within 1s: ${percentageWithin1s.toFixed(1)}%`);

        expect(avgLatency).to.be.lessThan(1000, 'Average latency should be < 1s');
        expect(percentageWithin1s).to.be.at.least(95, 'At least 95% of messages should arrive within 1s');

        // Cleanup
        mqttClient.end();
        await consumer.disconnect();
    });
});
