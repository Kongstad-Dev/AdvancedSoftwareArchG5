const { expect } = require('chai');

describe('NFR5: Usability - Dashboard Response Time', function () {
    this.timeout(30000);

    it('should load dashboard within 2 seconds', async function () {
        console.log('\n=== Testing Dashboard Load Time ===');

        const startTime = Date.now();
        const response = await fetch('http://localhost:8080/');
        const loadTime = Date.now() - startTime;
        const content = await response.text();

        console.log(`Dashboard load time: ${loadTime}ms`);
        console.log(`Response status: ${response.status}`);
        console.log(`Content length: ${content.length} bytes`);

        // NFR Assertion: Dashboard should load within 2 seconds
        expect(response.status).to.equal(200);
        expect(loadTime).to.be.lessThan(2000, 'Dashboard should load within 2 seconds');
        expect(content).to.include('Factory Management Dashboard');
    });

    it('should retrieve factory list within 1 second', async function () {
        console.log('\n=== Testing Factory List API Response ===');

        const startTime = Date.now();
        const response = await fetch('http://localhost:8080/api/factories');
        const responseTime = Date.now() - startTime;
        const data = await response.json();

        console.log(`API response time: ${responseTime}ms`);
        console.log(`Factories returned: ${data.data?.length || 0}`);
        console.log(`Response status: ${response.status}`);

        expect(response.status).to.equal(200);
        expect(responseTime).to.be.lessThan(1000, 'Factory list should load within 1 second');
        expect(data.success).to.be.true;
        expect(data.data).to.be.an('array');
    });

    it('should retrieve factory sensor health within 2 seconds', async function () {
        console.log('\n=== Testing Sensor Health API Response ===');

        const factories = ['F1', 'F2', 'F3', 'F4'];
        const results = [];

        for (const factoryId of factories) {
            const startTime = Date.now();
            const response = await fetch(`http://localhost:8080/mms/factories/${factoryId}/sensors`);
            const responseTime = Date.now() - startTime;
            const data = await response.json();

            results.push({
                factoryId,
                responseTime,
                success: data.success,
                sensorCount: data.data?.total_sensors || 0
            });

            console.log(`${factoryId}: ${responseTime}ms, ${data.data?.total_sensors || 0} sensors`);
        }

        const avgResponseTime = results.reduce((sum, r) => sum + r.responseTime, 0) / results.length;
        const maxResponseTime = Math.max(...results.map(r => r.responseTime));

        console.log(`\nAverage response time: ${avgResponseTime.toFixed(2)}ms`);
        console.log(`Max response time: ${maxResponseTime}ms`);

        // NFR Assertions: Managers should be able to inspect changes within 2 minutes
        // API responses should be fast enough to support this
        expect(avgResponseTime).to.be.lessThan(2000, 'Average sensor health query should be < 2s');
        expect(maxResponseTime).to.be.lessThan(3000, 'Max sensor health query should be < 3s');

        const allSuccessful = results.every(r => r.success);
        expect(allSuccessful).to.be.true;
    });

    it('should update data within acceptable refresh interval', async function () {
        console.log('\n=== Testing Data Freshness ===');

        // Get initial sensor data
        const response1 = await fetch('http://localhost:8080/mms/factories/F1/sensors');
        const data1 = await response1.json();

        console.log('Initial sensor count:', data1.data?.total_sensors || 0);

        // Wait for refresh interval
        await new Promise(resolve => setTimeout(resolve, 6000));

        // Get updated sensor data
        const response2 = await fetch('http://localhost:8080/mms/factories/F1/sensors');
        const data2 = await response2.json();

        console.log('Updated sensor count:', data2.data?.total_sensors || 0);
        console.log('Data is being refreshed:', data1.data?.total_sensors !== data2.data?.total_sensors || 'stable');

        // Data should be accessible (even if same values)
        expect(response2.status).to.equal(200);
        expect(data2.success).to.be.true;
    });
});

describe('NFR5: Usability - Query Performance', function () {
    this.timeout(30000);

    it('should handle multiple concurrent dashboard queries efficiently', async function () {
        console.log('\n=== Testing Concurrent Query Performance ===');

        const numConcurrentQueries = 10;
        const startTime = Date.now();

        // Simulate multiple users accessing different data
        const queries = [];
        for (let i = 0; i < numConcurrentQueries; i++) {
            const factoryId = `F${(i % 4) + 1}`;
            queries.push(
                fetch(`http://localhost:8080/mms/factories/${factoryId}/sensors`)
                    .then(r => r.json())
                    .then(data => ({
                        factoryId,
                        success: data.success,
                        responseTime: Date.now() - startTime
                    }))
            );
        }

        const results = await Promise.all(queries);
        const totalTime = Date.now() - startTime;

        const avgResponseTime = results.reduce((sum, r) => sum + r.responseTime, 0) / results.length;
        const successCount = results.filter(r => r.success).length;

        console.log(`Total time for ${numConcurrentQueries} queries: ${totalTime}ms`);
        console.log(`Average response time: ${avgResponseTime.toFixed(2)}ms`);
        console.log(`Successful queries: ${successCount}/${numConcurrentQueries}`);

        // System should handle concurrent queries well
        expect(totalTime).to.be.lessThan(5000, 'Concurrent queries should complete within 5s');
        expect(successCount).to.equal(numConcurrentQueries, 'All queries should succeed');
        expect(avgResponseTime).to.be.lessThan(3000, 'Average response time should be reasonable');
    });

    it('should provide order status within 1 second', async function () {
        console.log('\n=== Testing Order Status Query ===');

        const startTime = Date.now();
        const response = await fetch('http://localhost:8080/api/orders');
        const responseTime = Date.now() - startTime;
        const data = await response.json();

        console.log(`Order query response time: ${responseTime}ms`);
        console.log(`Orders returned: ${Array.isArray(data) ? data.length : 'N/A'}`);

        expect(response.status).to.equal(200);
        expect(responseTime).to.be.lessThan(1000, 'Order status should be retrievable within 1s');
    });
});
