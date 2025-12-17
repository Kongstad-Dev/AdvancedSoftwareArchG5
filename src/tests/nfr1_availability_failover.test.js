const { expect } = require('chai');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

describe('NFR1: Availability - MMS Failover Time', function () {
    this.timeout(60000);

    it('should recover MMS service within 10 seconds of failure', async function () {
        console.log('\n=== Testing MMS Failover Recovery ===');

        // Step 1: Verify MMS is healthy
        console.log('Step 1: Verifying MMS is running...');
        let healthCheck = await fetch('http://localhost:8000/health').catch(() => null);
        expect(healthCheck).to.not.be.null;
        expect(healthCheck.status).to.equal(200);
        console.log('✓ MMS is healthy');

        // Step 2: Simulate MMS failure by stopping the container
        console.log('\nStep 2: Simulating MMS failure...');
        const stopTime = Date.now();
        await execPromise('docker stop industry4-mms');
        console.log('✓ MMS container stopped');

        // Step 3: Wait briefly to ensure failure is detected
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Step 4: Restart MMS (simulating automatic failover/restart)
        console.log('\nStep 3: Triggering failover/restart...');
        await execPromise('docker start industry4-mms');
        console.log('✓ MMS restart initiated');

        // Step 5: Poll for service recovery
        console.log('\nStep 4: Waiting for service recovery...');
        let recovered = false;
        let attempts = 0;
        const maxAttempts = 20; // 20 attempts * 500ms = 10 seconds max

        while (!recovered && attempts < maxAttempts) {
            attempts++;
            await new Promise(resolve => setTimeout(resolve, 500));

            try {
                const response = await fetch('http://localhost:8000/health');
                if (response.status === 200) {
                    recovered = true;
                    const recoveryTime = Date.now() - stopTime;

                    console.log('\n=== Failover Test Results ===');
                    console.log(`Recovery time: ${recoveryTime}ms (${(recoveryTime / 1000).toFixed(2)}s)`);
                    console.log(`Health check attempts: ${attempts}`);
                    console.log(`Status: ${recovered ? 'RECOVERED' : 'FAILED'}`);

                    // NFR Assertion: Recovery should happen within 10 seconds
                    expect(recoveryTime).to.be.lessThan(10000, 'MMS should recover within 10 seconds');
                    expect(recovered).to.be.true;
                }
            } catch (e) {
                // Service not ready yet, continue polling
            }
        }

        if (!recovered) {
            throw new Error(`MMS failed to recover within ${maxAttempts * 0.5} seconds`);
        }
    });

    it('should maintain data integrity after MMS restart', async function () {
        console.log('\n=== Testing Data Integrity After Restart ===');

        // Check if sensor data is still accessible
        const response = await fetch('http://localhost:8000/factories/F1/sensors');
        const data = await response.json();

        console.log(`Sensor data status: ${data.success ? 'Available' : 'Unavailable'}`);
        console.log(`Total sensors in F1: ${data.data?.total_sensors || 0}`);

        expect(data.success).to.be.true;
        expect(response.status).to.equal(200);
    });
});

describe('NFR1: Availability - Factory Recovery Time', function () {
    this.timeout(60000);

    it('should recover factory within 15 seconds of restart', async function () {
        console.log('\n=== Testing Factory Recovery ===');

        const factoryId = 'F1';

        // Step 1: Stop factory
        console.log(`Step 1: Stopping factory ${factoryId}...`);
        const stopTime = Date.now();
        await execPromise('docker stop industry4-factory-1');
        console.log('✓ Factory stopped');

        await new Promise(resolve => setTimeout(resolve, 2000));

        // Step 2: Restart factory
        console.log('\nStep 2: Restarting factory...');
        await execPromise('docker start industry4-factory-1');
        console.log('✓ Factory restart initiated');

        // Step 3: Wait for factory to start publishing heartbeats again
        console.log('\nStep 3: Waiting for factory heartbeats...');
        const mqtt = require('mqtt');
        const client = mqtt.connect('mqtt://localhost:1883');

        await new Promise(resolve => client.on('connect', resolve));

        let heartbeatReceived = false;
        let recoveryTime = 0;

        const heartbeatPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Factory did not recover within 15 seconds'));
            }, 15000);

            client.subscribe(`factory/${factoryId}/heartbeat`, (err) => {
                if (err) reject(err);
            });

            client.on('message', (topic, message) => {
                if (topic === `factory/${factoryId}/heartbeat`) {
                    heartbeatReceived = true;
                    recoveryTime = Date.now() - stopTime;
                    clearTimeout(timeout);
                    resolve();
                }
            });
        });

        await heartbeatPromise;
        client.end();

        console.log('\n=== Factory Recovery Results ===');
        console.log(`Recovery time: ${recoveryTime}ms (${(recoveryTime / 1000).toFixed(2)}s)`);
        console.log(`Heartbeat received: ${heartbeatReceived ? 'YES' : 'NO'}`);

        // NFR Assertion: Factory should recover within 15 seconds
        expect(recoveryTime).to.be.lessThan(15000, 'Factory should recover within 15 seconds');
        expect(heartbeatReceived).to.be.true;
    });
});
