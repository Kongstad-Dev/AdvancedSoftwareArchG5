/**
 * Test script to create orders via PMS REST API
 */

const http = require('http');

const PMS_HOST = process.env.PMS_HOST || 'localhost';
const PMS_PORT = process.env.PMS_PORT || 3000;

/**
 * Create an order
 */
function createOrder(productType, quantity, deadline, priority = 1) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({
            productType,
            quantity,
            deadline,
            priority
        });

        const options = {
            hostname: PMS_HOST,
            port: PMS_PORT,
            path: '/orders',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': data.length
            }
        };

        const req = http.request(options, (res) => {
            let responseData = '';

            res.on('data', (chunk) => {
                responseData += chunk;
            });

            res.on('end', () => {
                try {
                    const parsedData = JSON.parse(responseData);
                    resolve(parsedData);
                } catch (error) {
                    reject(new Error(`Failed to parse response: ${error.message}`));
                }
            });
        });

        req.on('error', (error) => {
            reject(error);
        });

        req.write(data);
        req.end();
    });
}

/**
 * Get all orders
 */
function getOrders() {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: PMS_HOST,
            port: PMS_PORT,
            path: '/orders',
            method: 'GET'
        };

        const req = http.request(options, (res) => {
            let responseData = '';

            res.on('data', (chunk) => {
                responseData += chunk;
            });

            res.on('end', () => {
                try {
                    const parsedData = JSON.parse(responseData);
                    resolve(parsedData);
                } catch (error) {
                    reject(new Error(`Failed to parse response: ${error.message}`));
                }
            });
        });

        req.on('error', (error) => {
            reject(error);
        });

        req.end();
    });
}

/**
 * Main test function
 */
async function main() {
    console.log('🧪 Testing Order Creation\n');

    try {
        // Create some test orders
        const orders = [
            { productType: 'Coca-Cola', quantity: 50, deadline: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), priority: 1 },
            { productType: 'Pepsi', quantity: 30, deadline: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(), priority: 2 },
            { productType: 'Sprite', quantity: 40, deadline: new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString(), priority: 1 }
        ];

        console.log('Creating orders...\n');

        for (const order of orders) {
            console.log(`Creating order: ${order.productType} x${order.quantity}`);
            const result = await createOrder(order.productType, order.quantity, order.deadline, order.priority);
            
            if (result.success) {
                console.log(`✅ Order created: ${result.data.order.order_id}`);
                if (result.data.assignment) {
                    console.log(`   → Assigned to factory: ${result.data.assignment.factory_id}`);
                }
            } else {
                console.error(`❌ Failed to create order: ${result.error}`);
            }
            console.log('');
            
            // Wait a bit between orders
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        // Get all orders
        console.log('\n📋 Fetching all orders...\n');
        const allOrders = await getOrders();
        
        if (allOrders.success) {
            console.log(`Found ${allOrders.count} orders:`);
            allOrders.data.forEach(order => {
                console.log(`  - ${order.order_id}: ${order.product_type} x${order.quantity} (${order.status})`);
            });
        }

        console.log('\n✅ Test completed!');

    } catch (error) {
        console.error('❌ Test failed:', error.message);
        process.exit(1);
    }
}

// Run
main();
