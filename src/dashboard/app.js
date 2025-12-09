/**
 * Factory Management Dashboard
 * Frontend application for monitoring factories, sensors, and orders
 */

// Configuration
const API_BASE_URL = '/api';
const REFRESH_INTERVAL = 5000; // 5 seconds

// State
let selectedFactory = null;
let refreshInterval = null;
let factories = [];
let allOrders = [];

// DOM Elements
const factoryButtons = document.getElementById('factoryButtons');
const factoryOverview = document.getElementById('factoryOverview');
const sensorHealth = document.getElementById('sensorHealth');
const activeOrders = document.getElementById('activeOrders');
const productionStatus = document.getElementById('productionStatus');
const allOrdersDiv = document.getElementById('allOrders');
const createOrderModal = document.getElementById('createOrderModal');
const createOrderForm = document.getElementById('createOrderForm');
const toastContainer = document.getElementById('toastContainer');

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    await loadFactories();
    await loadAllOrders();
    setupEventListeners();
    startAutoRefresh();
});

// Setup event listeners
function setupEventListeners() {
    document.getElementById('refreshBtn').addEventListener('click', () => {
        if (selectedFactory) {
            loadFactoryData(selectedFactory);
        }
        loadAllOrders();
    });

    document.getElementById('createOrderBtn').addEventListener('click', () => {
        openCreateOrderModal();
    });

    document.getElementById('resetAllBtn').addEventListener('click', () => {
        resetAllData();
    });

    document.querySelector('.close').addEventListener('click', () => {
        closeCreateOrderModal();
    });

    document.getElementById('cancelOrderBtn').addEventListener('click', () => {
        closeCreateOrderModal();
    });

    createOrderForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        await createOrder();
    });

    // Order filter
    document.querySelectorAll('input[name="orderFilter"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            filterOrders(e.target.value);
        });
    });

    // Close modal on outside click
    window.addEventListener('click', (e) => {
        if (e.target === createOrderModal) {
            closeCreateOrderModal();
        }
    });
}

// Load factories
async function loadFactories() {
    try {
        const response = await fetch(`${API_BASE_URL}/factories`);
        const data = await response.json();

        if (data.success) {
            factories = data.data;
            renderFactoryButtons();
        }
    } catch (error) {
        console.error('Error loading factories:', error);
        showToast('Failed to load factories', 'error');
    }
}

// Render factory buttons
function renderFactoryButtons() {
    factoryButtons.innerHTML = '';

    factories.forEach(factory => {
        const button = document.createElement('button');
        button.className = 'factory-btn';
        button.dataset.factoryId = factory.factoryId || factory.id;

        const statusClass = factory.status === 'UP' ? 'status-up' :
            factory.status === 'DOWN' ? 'status-down' : 'status-degraded';

        button.innerHTML = `
            <div class="factory-name">${factory.name || factory.factoryId || factory.id}</div>
            <div class="factory-status ${statusClass}">${factory.status}</div>
            <div class="factory-load">${factory.currentLoad || factory.current_load || 0} units</div>
        `;

        button.addEventListener('click', () => {
            selectFactory(factory.factoryId || factory.id);
        });

        factoryButtons.appendChild(button);
    });
}

// Select factory
async function selectFactory(factoryId) {
    // Update button states
    document.querySelectorAll('.factory-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.factoryId === factoryId) {
            btn.classList.add('active');
        }
    });

    selectedFactory = factoryId;
    await loadFactoryData(factoryId);
}

// Load factory data
async function loadFactoryData(factoryId) {
    if (!factoryId) {
        return; // Skip if no factory selected
    }

    try {
        // Load factory details
        const factoryResponse = await fetch(`${API_BASE_URL}/factories/${factoryId}`);
        const factoryData = await factoryResponse.json();

        if (factoryData.success) {
            renderFactoryOverview(factoryData.data);
        }

        // Load factory assignments with queue information
        const assignmentsResponse = await fetch(`${API_BASE_URL}/factories/${factoryId}/assignments`);
        const assignmentsData = await assignmentsResponse.json();

        // Load factory config to get active sensor
        const configResponse = await fetch(`${API_BASE_URL}/factories/${factoryId}/config`);
        const configData = await configResponse.json();

        const activeSensorId = configData.success && configData.data.length > 0
            ? configData.data[0].sensorID
            : null;

        // Load real sensor health data from MMS
        let sensorHealthData = null;
        try {
            const sensorResponse = await fetch(`http://localhost:8000/factories/${factoryId}/sensors`);
            const sensorData = await sensorResponse.json();
            if (sensorData.success) {
                sensorHealthData = sensorData.data;
            }
        } catch (error) {
            console.warn('Could not fetch sensor data from MMS:', error);
        }

        if (assignmentsData.success) {
            renderActiveOrders(assignmentsData.data);
            renderProductionStatus(assignmentsData.data);
            // Pass active sensors to sensor health display
            const activeSensors = assignmentsData.data
                .filter(a => a.status === 'in_progress')
                .map(a => a.sensor_id);
            renderSensorHealth(factoryId, activeSensors, activeSensorId, sensorHealthData);
        } else {
            renderSensorHealth(factoryId, [], activeSensorId, sensorHealthData);
        }

    } catch (error) {
        console.error('Error loading factory data:', error);
        showToast('Failed to load factory data', 'error');
    }
}

// Render factory overview
function renderFactoryOverview(factory) {
    // Handle both camelCase and snake_case field names
    const factoryId = factory.factoryId || factory.id;
    const currentLoad = factory.currentLoad || factory.current_load || 0;
    const statusClass = factory.status === 'UP' ? 'status-up' :
        factory.status === 'DOWN' ? 'status-down' : 'status-degraded';

    factoryOverview.innerHTML = `
        <div class="overview-grid">
            <div class="overview-item">
                <div class="label">Factory ID</div>
                <div class="value">${factoryId}</div>
            </div>
            <div class="overview-item">
                <div class="label">Name</div>
                <div class="value">${factory.name || 'N/A'}</div>
            </div>
            <div class="overview-item">
                <div class="label">Status</div>
                <div class="value ${statusClass}">${factory.status}</div>
            </div>
            <div class="overview-item">
                <div class="label">Current Load</div>
                <div class="value">${currentLoad} units</div>
            </div>
        </div>
    `;
}

// Render sensor health with active sensor highlighting
function renderSensorHealth(factoryId, activeSensors = [], configActiveSensor = null, sensorHealthData = null) {
    let sensors = [];
    let healthyCount = 0;
    let failedCount = 0;
    let atRiskCount = 0;

    if (sensorHealthData) {
        // Build sensor list from MMS data (healthy + failed sensors)
        const allSensorIds = new Set([
            ...(sensorHealthData.healthy_sensors || []),
            ...((sensorHealthData.failed_sensors || []).map(fs => fs.sensor_id))
        ]);

        // Create sensor objects from actual MMS data
        allSensorIds.forEach(sensorId => {
            sensors.push({
                id: sensorId,
                tier: 'unknown', // Tier info not provided by MMS currently
                status: 'healthy',
                lastHeartbeat: new Date()
            });
        });

        // Mark failed sensors from MMS data
        if (sensorHealthData.failed_sensors && sensorHealthData.failed_sensors.length > 0) {
            sensorHealthData.failed_sensors.forEach(failedSensor => {
                const sensor = sensors.find(s => s.id === failedSensor.sensor_id);
                if (sensor) {
                    sensor.status = 'failed';
                    sensor.failureReason = failedSensor.reason;
                    sensor.failedAt = failedSensor.failed_at;
                }
            });
        }

        // Mark at-risk sensors from MMS data
        // Only show sensors as at-risk if they are currently active or were recently active
        if (sensorHealthData.at_risk_sensors && sensorHealthData.at_risk_sensors.length > 0) {
            sensorHealthData.at_risk_sensors.forEach(atRiskSensor => {
                const sensor = sensors.find(s => s.id === atRiskSensor.sensor_id);
                // Only mark as at-risk if it's the current active sensor or in the active sensors list
                const isCurrentlyActive = atRiskSensor.sensor_id === configActiveSensor || activeSensors.includes(atRiskSensor.sensor_id);
                if (sensor && sensor.status !== 'failed' && isCurrentlyActive) {
                    sensor.status = 'at-risk';
                    sensor.lowReadingCount = atRiskSensor.low_reading_count;
                    sensor.recentReadings = atRiskSensor.recent_readings;
                }
            });
        }

        healthyCount = sensors.filter(s => s.status === 'healthy').length;
        failedCount = sensors.filter(s => s.status === 'failed').length;
        atRiskCount = sensors.filter(s => s.status === 'at-risk').length;
    }

    const activeCount = configActiveSensor ? 1 : 0;

    sensorHealth.innerHTML = `
        <div class="sensor-summary">
            <div class="sensor-stat">
                <div class="sensor-count">${sensors.length}</div>
                <div class="sensor-label">Total Sensors</div>
            </div>
            <div class="sensor-stat status-up">
                <div class="sensor-count">${healthyCount}</div>
                <div class="sensor-label">Healthy</div>
            </div>
            <div class="sensor-stat sensor-active-stat">
                <div class="sensor-count">${activeCount}</div>
                <div class="sensor-label">Active</div>
            </div>
            <div class="sensor-stat status-degraded">
                <div class="sensor-count">${atRiskCount}</div>
                <div class="sensor-label">At Risk</div>
            </div>
            <div class="sensor-stat status-down">
                <div class="sensor-count">${failedCount}</div>
                <div class="sensor-label">Failed</div>
            </div>
        </div>
        <div class="sensor-actions">
            <button class="btn btn-warning" onclick="checkAtRiskSensors()" ${atRiskCount === 0 ? 'disabled' : ''}>
                🔍 Check At-Risk Sensors (${atRiskCount})
            </button>
            <button class="btn btn-success" onclick="fixFailedSensors()" ${failedCount === 0 ? 'disabled' : ''}>
                🔧 Fix Failed Sensors (${failedCount})
            </button>
        </div>
        <div class="sensor-list">
            ${sensors.map(sensor => {
        const isActive = sensor.id === configActiveSensor;
        const isProcessing = activeSensors.includes(sensor.id);
        const statusClass = sensor.status === 'healthy' ? 'sensor-healthy' :
            sensor.status === 'at-risk' ? 'sensor-at-risk' : 'sensor-failed';
        const activeClass = isActive ? 'sensor-processing' : '';
        const statusIcon = sensor.status === 'healthy' ? '✅' :
            sensor.status === 'at-risk' ? '⚠️' : '❌';

        let additionalInfo = '';
        if (sensor.status === 'failed' && sensor.failureReason) {
            additionalInfo = `<div class="sensor-failure-reason">❌ ${sensor.failureReason}</div>`;
        } else if (sensor.status === 'at-risk' && sensor.lowReadingCount) {
            const avgReading = sensor.recentReadings && sensor.recentReadings.length > 0
                ? (sensor.recentReadings.reduce((a, b) => a + b, 0) / sensor.recentReadings.length).toFixed(1)
                : 'N/A';
            additionalInfo = `<div class="sensor-risk-info">⚠️ ${sensor.lowReadingCount} consecutive low readings (avg: ${avgReading})</div>`;
        }

        return `
                <div class="sensor-item ${statusClass} ${activeClass}">
                    <div class="sensor-header">
                        <div class="sensor-id">${sensor.id}</div>
                        ${isActive ? '<div class="sensor-active-badge">🔵 ACTIVE</div>' : ''}
                    </div>
                    <div class="sensor-tier">Tier ${sensor.tier}</div>
                    <div class="sensor-status">${statusIcon} ${sensor.status}</div>
                    ${additionalInfo}
                    <div class="sensor-heartbeat">${formatTime(sensor.lastHeartbeat)}</div>
                </div>
            `}).join('')}
        </div>
    `;
}

// Render active orders (factory assignments)
function renderActiveOrders(assignments) {
    if (!assignments || assignments.length === 0) {
        activeOrders.innerHTML = '<p class="text-muted">No active orders for this factory</p>';
        return;
    }

    activeOrders.innerHTML = `
        <div class="orders-list">
            ${assignments.map(assignment => {
        const isActive = assignment.queue_position === 1;
        const progress = ((assignment.completed_quantity || 0) / assignment.assigned_quantity * 100).toFixed(1);
        return `
                <div class="order-item ${isActive ? 'order-active' : 'order-queued'}">
                    <div class="order-header">
                        <div class="order-queue">
                            ${isActive ? '🔵 ACTIVE' : `⏸️ Queue #${assignment.queue_position}`}
                        </div>
                        <div class="order-status status-${assignment.status}">${assignment.status}</div>
                    </div>
                    <div class="order-details">
                        <div class="order-id">Order: ${assignment.order_uuid.substring(0, 8)}</div>
                        <div class="order-product"><strong>${assignment.product_type}</strong></div>
                    </div>
                    <div class="order-sensor">
                        Sensor: <span class="sensor-badge ${isActive ? 'sensor-active' : ''}">${assignment.sensor_id}</span>
                    </div>
                    <div class="order-quantity">
                        ${assignment.completed_quantity || 0} / ${assignment.assigned_quantity} units
                    </div>
                    <div class="order-progress">
                        <div class="progress-bar">
                            <div class="progress-fill" style="width: ${progress}%"></div>
                        </div>
                        <span class="progress-text">${progress}%</span>
                    </div>
                    <div class="order-deadline">Deadline: ${formatDateTime(assignment.deadline)}</div>
                </div>
            `}).join('')}
        </div>
    `;
}

// Render production status
function renderProductionStatus(assignments) {
    if (!assignments || assignments.length === 0) {
        productionStatus.innerHTML = '<p class="text-muted">No production in progress</p>';
        return;
    }

    const inProgress = assignments.filter(a => a.status === 'in_progress');
    const totalProduction = assignments.reduce((sum, a) => sum + (a.completed_quantity || 0), 0);
    const totalTarget = assignments.reduce((sum, a) => sum + a.assigned_quantity, 0);
    const queuedJobs = assignments.filter(a => a.status === 'assigned').length;

    productionStatus.innerHTML = `
        <div class="production-summary">
            <div class="production-stat">
                <div class="stat-value">${inProgress.length}</div>
                <div class="stat-label">Active Jobs</div>
            </div>
            <div class="production-stat">
                <div class="stat-value">${queuedJobs}</div>
                <div class="stat-label">Queued Jobs</div>
            </div>
            <div class="production-stat">
                <div class="stat-value">${totalProduction}</div>
                <div class="stat-label">Units Produced</div>
            </div>
            <div class="production-stat">
                <div class="stat-value">${totalTarget}</div>
                <div class="stat-label">Target Units</div>
            </div>
            <div class="production-stat">
                <div class="stat-value">${totalTarget > 0 ? ((totalProduction / totalTarget) * 100).toFixed(1) : 0}%</div>
                <div class="stat-label">Progress</div>
            </div>
        </div>
    `;
}

// Load all orders
async function loadAllOrders() {
    try {
        const response = await fetch(`${API_BASE_URL}/orders`);
        const data = await response.json();

        if (data.success) {
            allOrders = data.data;
            filterOrders('all');
        }
    } catch (error) {
        console.error('Error loading orders:', error);
        showToast('Failed to load orders', 'error');
    }
}

// Filter orders
function filterOrders(status) {
    const filtered = status === 'all' ? allOrders : allOrders.filter(o => o.status === status);
    renderAllOrders(filtered);
}

// Render all orders
function renderAllOrders(orders) {
    if (orders.length === 0) {
        allOrdersDiv.innerHTML = '<p class="text-muted">No orders found</p>';
        return;
    }

    allOrdersDiv.innerHTML = `
        <table class="orders-table">
            <thead>
                <tr>
                    <th>Order ID</th>
                    <th>Product</th>
                    <th>Quantity</th>
                    <th>Progress</th>
                    <th>Status</th>
                    <th>Priority</th>
                    <th>Deadline</th>
                    <th>Created</th>
                </tr>
            </thead>
            <tbody>
                ${orders.map(order => `
                    <tr>
                        <td><strong>${order.order_id}</strong></td>
                        <td>${order.product_type}</td>
                        <td>${order.quantity}</td>
                        <td>
                            <div class="table-progress">
                                <span>${order.completed_quantity || 0}/${order.quantity}</span>
                                <div class="progress-bar mini">
                                    <div class="progress-fill" style="width: ${((order.completed_quantity || 0) / order.quantity * 100).toFixed(1)}%"></div>
                                </div>
                            </div>
                        </td>
                        <td><span class="badge status-${order.status}">${order.status}</span></td>
                        <td><span class="priority-${order.priority}">Priority ${order.priority}</span></td>
                        <td>${formatDateTime(order.deadline)}</td>
                        <td>${formatDateTime(order.created_at)}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
}

// Open create order modal
function openCreateOrderModal() {
    // Set default deadline to 24 hours from now
    const deadline = new Date();
    deadline.setHours(deadline.getHours() + 24);
    document.getElementById('deadline').value = formatDateTimeForInput(deadline);

    createOrderModal.style.display = 'block';
}

// Close create order modal
function closeCreateOrderModal() {
    createOrderModal.style.display = 'none';
    createOrderForm.reset();
}

// Create order
async function createOrder() {
    const formData = new FormData(createOrderForm);

    const orderData = {
        productType: formData.get('productType'),
        quantity: parseInt(formData.get('quantity')),
        deadline: new Date(formData.get('deadline')).toISOString(),
        priority: parseInt(formData.get('priority'))
    };

    try {
        const response = await fetch(`${API_BASE_URL}/orders`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(orderData)
        });

        const data = await response.json();

        if (data.success) {
            showToast('Order created successfully!', 'success');
            closeCreateOrderModal();
            await loadAllOrders();

            // Reload factory data if one is selected
            if (selectedFactory) {
                await loadFactoryData(selectedFactory);
            }
        } else {
            showToast(`Failed to create order: ${data.error}`, 'error');
        }
    } catch (error) {
        console.error('Error creating order:', error);
        showToast('Failed to create order', 'error');
    }
}

// Show toast notification
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;

    toastContainer.appendChild(toast);

    // Trigger animation
    setTimeout(() => toast.classList.add('show'), 10);

    // Remove after 3 seconds
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// Reset all data
async function resetAllData() {
    const confirmed = confirm(
        '⚠️ WARNING: This will delete ALL orders and reset all factory configurations.\n\n' +
        'This action cannot be undone. Are you sure you want to continue?'
    );

    if (!confirmed) {
        return;
    }

    try {
        const response = await fetch(`${API_BASE_URL}/system/reset`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();

        if (data.success) {
            showToast('System reset successfully! All orders cleared.', 'success');

            // Clear selected factory
            selectedFactory = null;
            document.querySelectorAll('.factory-btn').forEach(btn => {
                btn.classList.remove('active');
            });

            // Refresh all data
            await loadFactories();
            await loadAllOrders();

            // Clear factory details
            factoryOverview.innerHTML = '<p class="text-muted">Select a factory to view details</p>';
            sensorHealth.innerHTML = '<p class="text-muted">No sensor data available</p>';
            activeOrders.innerHTML = '<p class="text-muted">No active orders</p>';
            productionStatus.innerHTML = '<p class="text-muted">No production data</p>';
        } else {
            showToast(`Failed to reset system: ${data.error}`, 'error');
        }
    } catch (error) {
        console.error('Error resetting system:', error);
        showToast('Failed to reset system', 'error');
    }
}

// Auto refresh
function startAutoRefresh() {
    refreshInterval = setInterval(() => {
        if (selectedFactory) {
            loadFactoryData(selectedFactory);
        }
        loadAllOrders();
        loadFactories();
    }, REFRESH_INTERVAL);
}

// Check and reset at-risk sensors
async function checkAtRiskSensors() {
    if (!selectedFactory) return;

    if (!confirm('This will reset the risk tracking for all at-risk sensors. Continue?')) {
        return;
    }

    try {
        const response = await fetch(`http://localhost:8000/factories/${selectedFactory}/sensors/check-at-risk`, {
            method: 'POST'
        });

        const result = await response.json();

        if (result.success) {
            const sensors = result.at_risk_sensors || [];
            let message = `Reset ${result.sensors_reset?.length || 0} at-risk sensor(s):\n\n`;

            sensors.forEach(sensor => {
                const avgReading = sensor.recent_readings && sensor.recent_readings.length > 0
                    ? (sensor.recent_readings.reduce((a, b) => a + b, 0) / sensor.recent_readings.length).toFixed(1)
                    : 'N/A';
                message += `• ${sensor.sensor_id}: ${sensor.low_reading_count} consecutive low readings (avg: ${avgReading})\n`;
            });

            if (sensors.length === 0) {
                message = 'No sensors are currently at risk.';
            } else {
                message += '\nRisk tracking has been reset for these sensors.';
            }

            alert(message);
        } else {
            alert('Failed to reset at-risk sensors: ' + (result.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('Error resetting at-risk sensors:', error);
        alert('Error resetting at-risk sensors: ' + error.message);
    }
}

// Fix failed sensors
async function fixFailedSensors() {
    if (!selectedFactory) return;

    if (!confirm('This will recover all failed sensors. Continue?')) {
        return;
    }

    try {
        const response = await fetch(`http://localhost:8000/factories/${selectedFactory}/sensors/fix-failed`, {
            method: 'POST'
        });

        const result = await response.json();

        if (result.success) {
            alert(`Successfully fixed ${result.recovered_count} sensor(s)!\n\nRecovered sensors:\n${result.recovered_sensors.join('\n')}`);
            loadFactoryData(selectedFactory); // Refresh the display
        } else {
            alert('Failed to fix sensors: ' + (result.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('Error fixing sensors:', error);
        alert('Error fixing sensors: ' + error.message);
    }
}

// Utility functions
function formatDateTime(dateString) {
    const date = new Date(dateString);
    return date.toLocaleString();
}

function formatTime(date) {
    return date.toLocaleTimeString();
}

function formatDateTimeForInput(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');

    return `${year}-${month}-${day}T${hours}:${minutes}`;
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    if (refreshInterval) {
        clearInterval(refreshInterval);
    }
});
