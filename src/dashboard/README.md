# Factory Management Dashboard

A real-time web dashboard for monitoring factories, sensor health, production orders, and system status.

![Dashboard Screenshot](../../images/dashboard-preview.png)

## Features

### 🏭 Factory Monitoring
- **Real-time Factory Status**: View all factories with UP/DOWN/DEGRADED status
- **Load Monitoring**: See current load vs capacity for each factory
- **Interactive Selection**: Click on any factory to view detailed information

### 📊 Sensor Health Tracking
- **Sensor Status**: Monitor health of all sensors in selected factory
- **Heartbeat Tracking**: See last heartbeat time for each sensor
- **Failure Detection**: Visual indication of failed sensors
- **Health Summary**: Quick view of healthy vs failed sensors

### 📦 Order Management
- **Create Orders**: Simple form to create new production orders
- **Order Tracking**: Monitor all orders with real-time progress updates
- **Status Filtering**: Filter orders by status (pending, assigned, in_progress, completed)
- **Progress Visualization**: Visual progress bars showing completion percentage
- **Priority Levels**: Color-coded priority indicators

### 🔄 Production Monitoring
- **Active Jobs**: See current production jobs for selected factory
- **Production Statistics**: Total units produced, target units, progress percentage
- **Real-time Updates**: Auto-refresh every 5 seconds

## Quick Start

### Prerequisites

- Node.js 18+ installed
- PMS (Production Management System) running on port 3000

### Installation

```bash
cd src/dashboard
npm install
```

### Running the Dashboard

```bash
npm start
```

The dashboard will be available at: **http://localhost:8080**

### Using a Simple HTTP Server (Alternative)

If you prefer not to use Node.js:

```bash
# Python 3
python -m http.server 8080

# Python 2
python -m SimpleHTTPServer 8080

# PHP
php -S localhost:8080
```

Then open: **http://localhost:8080**

## Configuration

### API Endpoint

The dashboard connects to PMS at `http://localhost:3000` by default.

To change this, edit `app.js`:

```javascript
const API_BASE_URL = 'http://your-pms-host:3000';
```

### Auto-Refresh Interval

Default refresh interval is 5 seconds. To change:

```javascript
const REFRESH_INTERVAL = 10000; // 10 seconds
```

## Usage Guide

### Viewing Factory Details

1. **Select a Factory**: Click on any factory card in the "Select Factory" section
2. **View Overview**: See factory status, capacity, and current load
3. **Check Sensors**: View health status of all sensors
4. **Monitor Orders**: See active production orders
5. **Track Production**: View real-time production statistics

### Creating an Order

1. Click the **"➕ Create Order"** button in the header
2. Fill in the order details:
   - **Product Type**: Name of the product (e.g., Coca-Cola, Pepsi)
   - **Quantity**: Number of units to produce
   - **Deadline**: Due date and time
   - **Priority**: Order priority (1-5)
3. Click **"Create Order"**
4. Order will be automatically assigned to the factory with lowest workload

### Filtering Orders

Use the radio buttons in the "All Orders" section to filter by status:
- **All**: Show all orders
- **Pending**: Orders waiting for assignment
- **Assigned**: Orders assigned to factories
- **In Progress**: Orders currently being produced
- **Completed**: Finished orders

### Understanding Status Colors

**Factory Status:**
- 🟢 **Green (UP)**: Factory operational and healthy
- 🟡 **Yellow (DEGRADED)**: Factory experiencing issues
- 🔴 **Red (DOWN)**: Factory offline or failed

**Order Status:**
- 🔵 **Blue (Pending)**: Waiting for factory assignment
- 🟦 **Light Blue (Assigned)**: Assigned but not started
- 🟡 **Yellow (In Progress)**: Currently being produced
- 🟢 **Green (Completed)**: Production finished

**Sensor Status:**
- ✅ **Healthy**: Sensor operational, sending heartbeats
- ❌ **Failed**: Sensor not responding or failed

## Features in Detail

### Real-time Updates

The dashboard automatically refreshes data every 5 seconds:
- Factory statuses
- Sensor health
- Order progress
- Production statistics

You can also manually refresh using the 🔄 **Refresh** button.

### Progress Tracking

Order progress is displayed in multiple ways:
- **Progress Bars**: Visual representation of completion percentage
- **Numeric Progress**: "X/Y" format showing completed vs total units
- **Percentage**: Exact completion percentage

### Toast Notifications

Success and error messages appear in the top-right corner:
- 🟢 **Green**: Success messages
- 🔴 **Red**: Error messages
- 🔵 **Blue**: Information messages

### Responsive Design

The dashboard is fully responsive and works on:
- Desktop computers
- Tablets
- Mobile devices

## API Integration

The dashboard integrates with these PMS endpoints:

### Factory Endpoints
```
GET /factories           - List all factories
GET /factories/:id       - Get factory details
POST /factories/:id/replace-sensor - Replace failed sensor
```

### Order Endpoints
```
GET /orders              - List all orders
GET /orders?factoryId=X  - Get orders for specific factory
POST /orders             - Create new order
```

## Troubleshooting

### Dashboard shows "Failed to load factories"

**Cause**: Cannot connect to PMS API

**Solution**:
1. Ensure PMS is running: `cd src/pms && npm start`
2. Check PMS is on port 3000: `curl http://localhost:3000/health`
3. Verify CORS is enabled in PMS (it should be by default)

### Data not updating

**Cause**: Auto-refresh stopped

**Solution**:
1. Check browser console for errors (F12)
2. Click the manual 🔄 Refresh button
3. Reload the page (F5)

### Create Order fails

**Cause**: Invalid data or PMS connection issue

**Solution**:
1. Check all required fields are filled
2. Ensure deadline is in the future
3. Verify PMS is running and accessible

### Sensor data shows "No sensor data available"

**Note**: Sensor health data is currently simulated. In production, this would connect to MMS (Monitoring & Maintenance System) for real sensor heartbeat data.

## Architecture

```
┌──────────────┐
│   Browser    │
│  Dashboard   │
└──────┬───────┘
       │ HTTP REST API
       v
┌──────────────┐      ┌──────────────┐
│     PMS      │◄────►│  PostgreSQL  │
│   (Node.js)  │      │   (Orders)   │
└──────┬───────┘      └──────────────┘
       │
       │ MQTT
       v
┌──────────────┐
│  Factories   │
│ (Simulators) │
└──────────────┘
```

## File Structure

```
src/dashboard/
├── index.html          # Main HTML structure
├── app.js              # Application logic
├── styles.css          # Styling and layout
├── server.js           # Simple HTTP server
├── package.json        # Node.js dependencies
└── README.md           # This file
```

## Browser Compatibility

- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+

## Development

### Making Changes

1. Edit HTML structure in `index.html`
2. Modify styles in `styles.css`
3. Update logic in `app.js`
4. Refresh browser to see changes (no build step required!)

### Adding New Features

The dashboard uses vanilla JavaScript - no framework required. Key functions:

- `loadFactories()` - Fetch and display factories
- `loadFactoryData(factoryId)` - Load data for selected factory
- `loadAllOrders()` - Fetch all orders
- `createOrder()` - Submit new order
- `showToast(message, type)` - Show notification

## Future Enhancements

Potential features to add:

- [ ] Real-time WebSocket updates instead of polling
- [ ] Historical production charts and analytics
- [ ] Export data to CSV/Excel
- [ ] Dark mode toggle
- [ ] User authentication and roles
- [ ] Advanced filtering and search
- [ ] Sensor failure alert notifications
- [ ] Factory performance metrics and KPIs

## License

MIT

## Support

For issues or questions, please check:
- Main project README: `../../README.md`
- System Guide: `../../SYSTEM_GUIDE.md`
- Sensor Failure Recovery: `../../SENSOR_FAILURE_RECOVERY.md`
