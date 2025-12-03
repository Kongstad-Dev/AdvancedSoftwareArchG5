const axios = require('axios');

const PMS_URL = process.env.PMS_URL || 'http://localhost:3000';
const MMS_URL = process.env.MMS_URL || 'http://localhost:8000';
const ORDER_INTERVAL = parseInt(process.env.ORDER_INTERVAL_MS) || 5000; // 5 seconds default
const MAX_ORDERS_PER_FACTORY = parseInt(process.env.MAX_ORDERS_PER_FACTORY) || 2;
const MIN_COMPLETION_TIME = parseInt(process.env.MIN_COMPLETION_TIME) || 5000; // 5 seconds
const MAX_COMPLETION_TIME = parseInt(process.env.MAX_COMPLETION_TIME) || 10000; // 10 seconds

const PRODUCT_TYPES = [
    { name: 'cola', baseDuration: 1.0 },
    { name: 'pepsi', baseDuration: 1.0 },
    { name: 'fanta', baseDuration: 0.8 },
    { name: 'sprite', baseDuration: 0.8 },
    { name: 'water', baseDuration: 0.5 }
];

let orderCounter = 1;

// Track active orders per factory for capacity management
const factoryOrderCounts = {};

// Track orders in progress for completion
const activeOrders = new Map();

async function getFactoriesWithHealth() {
    try {
        const response = await axios.get(`${MMS_URL}/api/factories`);
        const factories = response.data.factories || [];
        return factories;
    } catch (error) {
        console.error('Error fetching factory status:', error.message);
        return [];
    }
}

function calculateCapacity(factory) {
    // Capacity based on operational sensors
    // Full capacity (2 orders) when health >= 80%
    // Reduced capacity (1 order) when health 50-79%
    // No capacity when health < 50%
    const health = factory.health_percentage || 0;
    if (health >= 80) return MAX_ORDERS_PER_FACTORY;
    if (health >= 50) return 1;
    return 0;
}

function calculateProductionTime(productType, quantity) {
    const product = PRODUCT_TYPES.find(p => p.name === productType) || { baseDuration: 1.0 };
    const baseTime = MIN_COMPLETION_TIME + Math.random() * (MAX_COMPLETION_TIME - MIN_COMPLETION_TIME);
    // Adjust based on product type and quantity (higher quantity = longer time)
    const quantityFactor = 1 + (quantity / 1000) * 0.5; // Up to 50% longer for large orders
    return Math.round(baseTime * product.baseDuration * quantityFactor);
}

async function getOperationalFactoriesWithCapacity() {
    try {
        const factories = await getFactoriesWithHealth();
        
        // Filter and calculate available capacity
        const availableFactories = [];
        
        for (const factory of factories) {
            if (factory.status !== 'OPERATIONAL' && factory.status !== 'DEGRADED') {
                continue;
            }
            
            const maxCapacity = calculateCapacity(factory);
            const currentOrders = factoryOrderCounts[factory.factory_id] || 0;
            const availableCapacity = maxCapacity - currentOrders;
            
            if (availableCapacity > 0) {
                availableFactories.push({
                    ...factory,
                    maxCapacity,
                    currentOrders,
                    availableCapacity
                });
            }
        }
        
        // Sort by health (prefer healthier factories)
        availableFactories.sort((a, b) => b.health_percentage - a.health_percentage);
        
        return availableFactories;
    } catch (error) {
        console.error('Error getting factory capacity:', error.message);
        return [];
    }
}

async function notifyFactoryLoad(factoryId, orderCount) {
    try {
        // Notify MMS about the factory load for sensor simulation
        await axios.post(`${MMS_URL}/api/factories/${factoryId}/load`, {
            orderCount,
            maxCapacity: MAX_ORDERS_PER_FACTORY
        });
    } catch (error) {
        // Load notification is optional
    }
}

async function createOrder() {
    try {
        // Get available factories with capacity
        const availableFactories = await getOperationalFactoriesWithCapacity();
        
        if (availableFactories.length === 0) {
            console.log('⏸️  All factories at capacity or unavailable - waiting...');
            return;
        }

        // Pick the healthiest factory with capacity
        const bestFactory = availableFactories[0];
        
        const productInfo = PRODUCT_TYPES[Math.floor(Math.random() * PRODUCT_TYPES.length)];
        const quantity = Math.floor(Math.random() * 900) + 100; // 100-1000
        
        const order = {
            productType: productInfo.name,
            quantity,
            deadline: new Date(Date.now() + 3600000).toISOString(),
            priority: Math.floor(Math.random() * 3) + 1
        };

        const productionTime = calculateProductionTime(productInfo.name, quantity);

        console.log(`\n📦 Creating order #${orderCounter}:`);
        console.log(`   Product: ${order.productType}`);
        console.log(`   Quantity: ${order.quantity}`);
        console.log(`   Priority: ${order.priority}`);
        console.log(`   Est. Time: ${(productionTime / 1000).toFixed(1)}s`);
        console.log(`   Assigning to: ${bestFactory.factory_id} (Health: ${bestFactory.health_percentage.toFixed(1)}%, Load: ${bestFactory.currentOrders}/${bestFactory.maxCapacity})`);

        // Create the order
        const createResponse = await axios.post(`${PMS_URL}/orders`, order);
        const orderId = createResponse.data.data.order.id;

        // Assign to the best factory
        await axios.post(`${PMS_URL}/orders/${orderId}/assign`, {
            factoryId: bestFactory.factory_id
        });

        // Track the order locally
        factoryOrderCounts[bestFactory.factory_id] = (factoryOrderCounts[bestFactory.factory_id] || 0) + 1;
        
        // Notify factory of load change
        await notifyFactoryLoad(bestFactory.factory_id, factoryOrderCounts[bestFactory.factory_id]);

        console.log(`   ✅ Order ${orderId} created and assigned to ${bestFactory.factory_id}`);

        // Schedule order progression: assigned -> in_progress -> completed
        scheduleOrderProgression(orderId, bestFactory.factory_id, productionTime, order);
        
        orderCounter++;

    } catch (error) {
        console.error('❌ Error creating order:', error.response?.data || error.message);
    }
}

function scheduleOrderProgression(orderId, factoryId, productionTime, orderDetails) {
    // Move to in_progress after 1 second
    setTimeout(async () => {
        try {
            await axios.put(`${PMS_URL}/orders/${orderId}/status`, { status: 'in_progress' });
            console.log(`   🔄 Order ${orderId} now IN_PROGRESS at ${factoryId}`);
            
            // Store active order info
            activeOrders.set(orderId, {
                factoryId,
                startTime: Date.now(),
                productionTime,
                orderDetails
            });
        } catch (error) {
            console.error(`   ❌ Failed to update order ${orderId} to in_progress:`, error.message);
        }
    }, 1000);

    // Complete the order after production time
    setTimeout(async () => {
        try {
            await axios.put(`${PMS_URL}/orders/${orderId}/status`, { status: 'completed' });
            console.log(`   ✅ Order ${orderId} COMPLETED at ${factoryId}`);
            
            // Update local tracking
            factoryOrderCounts[factoryId] = Math.max(0, (factoryOrderCounts[factoryId] || 1) - 1);
            activeOrders.delete(orderId);
            
            // Notify factory of reduced load
            await notifyFactoryLoad(factoryId, factoryOrderCounts[factoryId]);
            
        } catch (error) {
            console.error(`   ❌ Failed to complete order ${orderId}:`, error.message);
        }
    }, productionTime);
}

async function checkForFailedFactories() {
    try {
        const factories = await getFactoriesWithHealth();
        
        // Find factories that are CRITICAL or DOWN
        const failedFactories = factories.filter(f => 
            f.status === 'CRITICAL' || f.status === 'DOWN'
        );

        if (failedFactories.length > 0) {
            console.log(`\n⚠️  Detected ${failedFactories.length} failed/critical factories:`);
            
            for (const factory of failedFactories) {
                console.log(`   - ${factory.factory_id}: ${factory.status} (${factory.health_percentage.toFixed(1)}%)`);
                
                // Get operational factories for rescheduling
                const availableFactories = await getOperationalFactoriesWithCapacity();
                
                if (availableFactories.length > 0) {
                    const targetFactory = availableFactories[0];
                    
                    try {
                        const rescheduleResponse = await axios.post(`${PMS_URL}/orders/reschedule`, {
                            fromFactoryId: factory.factory_id,
                            toFactoryId: targetFactory.factory_id
                        });
                        
                        const rescheduled = rescheduleResponse.data.data?.rescheduled || 0;
                        if (rescheduled > 0) {
                            // Update local tracking
                            factoryOrderCounts[factory.factory_id] = 0;
                            factoryOrderCounts[targetFactory.factory_id] = (factoryOrderCounts[targetFactory.factory_id] || 0) + rescheduled;
                            
                            console.log(`   ✅ Rescheduled ${rescheduled} orders from ${factory.factory_id} → ${targetFactory.factory_id}`);
                        }
                    } catch (error) {
                        if (error.response?.status !== 404) {
                            console.error(`   ❌ Failed to reschedule from ${factory.factory_id}:`, error.message);
                        }
                    }
                } else {
                    console.log(`   ⚠️  No healthy factories available to reschedule orders from ${factory.factory_id}`);
                }
            }
        }
    } catch (error) {
        console.error('Error checking for failed factories:', error.message);
    }
}

async function syncFactoryOrderCounts() {
    // Sync local tracking with actual database state periodically
    try {
        const response = await axios.get(`${PMS_URL}/orders`);
        const orders = response.data.data || [];
        
        // Reset counts
        for (const key in factoryOrderCounts) {
            factoryOrderCounts[key] = 0;
        }
        
        // Count active orders per factory
        for (const order of orders) {
            if (order.status === 'assigned' || order.status === 'in_progress') {
                const factoryId = order.assigned_factory_id;
                if (factoryId) {
                    factoryOrderCounts[factoryId] = (factoryOrderCounts[factoryId] || 0) + 1;
                }
            }
        }
    } catch (error) {
        // Ignore sync errors
    }
}

function printStatus() {
    console.log('\n📊 Current Factory Load:');
    for (const [factoryId, count] of Object.entries(factoryOrderCounts)) {
        console.log(`   ${factoryId}: ${count}/${MAX_ORDERS_PER_FACTORY} orders`);
    }
    console.log(`   Active tracked orders: ${activeOrders.size}`);
}

async function main() {
    console.log('🚀 Order Generator Started');
    console.log(`   PMS: ${PMS_URL}`);
    console.log(`   MMS: ${MMS_URL}`);
    console.log(`   Order Interval: ${ORDER_INTERVAL}ms`);
    console.log(`   Max Orders/Factory: ${MAX_ORDERS_PER_FACTORY}`);
    console.log(`   Completion Time: ${MIN_COMPLETION_TIME/1000}-${MAX_COMPLETION_TIME/1000}s`);
    console.log('');

    // Wait for services to be ready
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Initial sync
    await syncFactoryOrderCounts();

    // Create orders periodically
    setInterval(async () => {
        await createOrder();
    }, ORDER_INTERVAL);

    // Check for failed factories every 10 seconds
    setInterval(async () => {
        await checkForFailedFactories();
    }, 10000);

    // Sync order counts every 30 seconds
    setInterval(async () => {
        await syncFactoryOrderCounts();
    }, 30000);

    // Print status every 15 seconds
    setInterval(printStatus, 15000);

    // Create first order immediately
    await createOrder();
}

main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
