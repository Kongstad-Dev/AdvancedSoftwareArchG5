# Industry 4.0 Production System - Demo Implementation

A comprehensive event-driven Industry 4.0 production management system demonstrating quality attributes including availability, performance, scalability, modifiability, usability, and interoperability.

## Table of Contents

- [System Overview](#system-overview)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Running Tests](#running-tests)
- [Accessing Services](#accessing-services)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## System Overview

This system simulates an Industry 4.0 production environment with multiple factories producing soda beverages. The architecture includes:

- **4 Factory Simulators** - Generate sensor readings and heartbeats
- **Production Management System (PMS)** - Manages orders and production workflows
- **Monitoring & Maintenance System (MMS)** - Monitors sensor health and factory status
- **Web Dashboard** - Real-time visualization of factory status and orders
- **Event-Driven Architecture** - MQTT → Kafka message broker pipeline
- **Multi-Protocol Support** - MQTT, Kafka, HTTP/REST, gRPC

## Architecture

```
┌─────────────┐     MQTT      ┌─────────┐     Kafka     ┌─────┐
│  Factories  │──────────────→│  Bridge │──────────────→│ PMS │
│  (F1-F4)    │               └─────────┘               └─────┘
│  Sensors    │                    │                       ↓
└─────────────┘             kafka  │                  PostgreSQL
                                   ↓
                              ┌─────────┐
                              │   MMS   │
                              └─────────┘
                                   ↓
                               MongoDB

┌──────────────┐
│  Dashboard   │──→ HTTP Proxy ──→ PMS & MMS
└──────────────┘
```

**Key Components:**

- **Mosquitto MQTT Broker** - Factory sensor communication
- **Kafka** - Event streaming (5 topics: heartbeat, readings, sensor-failure, sensor-at-risk, restart)
- **Bridge Service** - Translates MQTT messages to Kafka events
- **PMS (Node.js)** - Production order management
- **MMS (Python/FastAPI)** - Factory health monitoring
- **Dashboard (Node.js/Express)** - Web UI with dual API proxy

## Prerequisites

- **Docker** (version 20.10+) and **Docker Compose** (version 2.0+)
- **Node.js** (version 18+) - for running tests
- **npm** or **yarn** - for test dependencies
- **Windows/Linux/macOS** with at least 4GB RAM available for containers

### Install Test Dependencies

```powershell
# Navigate to src directory
cd src

# Install test dependencies
npm install
```

Required packages:

- `mocha` - Test framework
- `chai` - Assertion library
- `mqtt` - MQTT client for tests
- `kafkajs` - Kafka client for tests
- `mongodb` - MongoDB client for tests
- `pg` - PostgreSQL client for tests

## Quick Start

### 1. Start All Services

```powershell
# Navigate to src directory
cd src

# Start all services with Docker Compose
docker-compose up -d

# Check service health
docker-compose ps
```

**Expected output:** All services should show "healthy" status after 30-60 seconds.

### 2. Verify System is Running

```powershell
# Check Docker containers
docker ps

# View logs (optional)
docker-compose logs -f --tail=50
```

**Services and Ports:**

- Dashboard: http://localhost:8080
- PMS API: http://localhost:3000
- MMS API: http://localhost:8000
- MQTT Broker: localhost:1883
- Kafka Broker: localhost:9092
- PostgreSQL: localhost:5432
- MongoDB: localhost:27018

### 3. Access the Dashboard

Open your browser and navigate to:

```
http://localhost:8080
```

You should see:

- Factory status overview (F1, F2, F3, F4)
- Active orders and production progress
- Sensor health indicators (healthy/failed counts)
- Real-time updates

### 4. Stop the System

```powershell
# Stop all services
docker-compose down

# Stop and remove volumes (clean slate)
docker-compose down -v
```

## Running Tests

The system includes comprehensive Non-Functional Requirement (NFR) tests covering all 6 quality attributes.

### Run All NFR Tests

```powershell
# Run all NFR tests
npm test -- --grep "NFR"

# Run specific NFR category
npm test -- --grep "NFR1"  # Availability tests
npm test -- --grep "NFR2"  # Performance tests
npm test -- --grep "NFR3"  # Scalability tests
npm test -- --grep "NFR4"  # Modifiability tests
npm test -- --grep "NFR5"  # Usability tests
npm test -- --grep "NFR6"  # Interoperability tests
```

### NFR Test Suite Overview

**NFR1 - Availability (2 tests)**

- `nfr1_availability_failover.test.js`
  - MMS service recovery within 10 seconds
  - Factory recovery within 15 seconds
  - Data integrity after restart

**NFR2 - Performance (4 tests)**

- `nfr_mqtt_kafka_latency.test.js` - MQTT→Kafka propagation < 1s
- `nfr_heartbeat_to_mms_latency.test.js` - Heartbeat persistence < 2s
- `nfr_failure_and_reading_latency.test.js` - Sensor failure/reading processing
- `nfr_heartbeat_load_500_sensors.test.js` - 500 concurrent sensors load test

**NFR3 - Scalability (2 tests)**

- `nfr3_scalability_factories.test.js`
  - 8 factories operating simultaneously
  - 500 sensors per single factory

**NFR4 - Modifiability (3 tests)**

- `nfr4_modifiability_integration.test.js`
  - Configuration change detection
  - Service availability during updates
  - Loose coupling verification

**NFR5 - Usability (2 tests)**

- `nfr5_usability_dashboard.test.js`
  - Dashboard load time < 2s
  - API response times < 1-2s
  - Concurrent query performance

**NFR6 - Interoperability (2 tests)**

- `nfr6_interoperability_protocols.test.js`
  - Multi-protocol support (MQTT, Kafka, HTTP, gRPC)
  - Protocol adapter validation
  - Vendor independence verification

### Run Individual Test Files

```powershell
# Run specific test file
npm test tests/nfr1_availability_failover.test.js

# Run with verbose output
npm test -- --reporter spec tests/nfr2_performance_latency.test.js
```

### Expected Test Results

- **NFR2 Performance Tests:**

  - MQTT→Kafka: ~5-10ms average
  - Heartbeat→MMS: ~400-600ms average (includes 800ms polling delay in test)
  - Sensor processing: 2-5s (includes realistic production simulation delays)

- **NFR3 Scalability Tests:**

  - 500 sensors: >80% success rate, avg latency <5s
  - 8 factories: >70% success rate per factory

- **NFR1 Availability Tests:**
  - MMS recovery: <10s
  - Factory recovery: <15s

## Accessing Services

### Dashboard Web UI

```
http://localhost:8080
```

Features:

- Factory overview with sensor counts
- Active production orders
- Real-time sensor health status
- Order progress tracking

### PMS REST API

```
Base URL: http://localhost:3000

GET  /factories          - List all factories
GET  /factories/:id      - Get factory details
POST /factories          - Create factory
GET  /orders             - List all orders
POST /orders             - Create production order
GET  /sensors            - List all sensors
```

### MMS REST API

```
Base URL: http://localhost:8000

GET  /health                        - Service health check
GET  /factories/:id/sensors         - Get factory sensor status
GET  /factories/:id/heartbeats      - Get recent heartbeats
GET  /factories/:id/anomalies       - Get detected anomalies
```

### MQTT Topics

```
factory/{factoryId}/heartbeat       - Sensor heartbeats
factory/{factoryId}/readings        - Sensor readings
factory/{factoryId}/sensor-failure  - Failure notifications
factory/{factoryId}/sensor-at-risk  - At-risk warnings
factory/{factoryId}/restart         - Factory restart events
```

### Kafka Topics

```
factory.heartbeat       - Heartbeat events
factory.readings        - Sensor reading events
factory.sensor-failure  - Sensor failure events
factory.sensor-at-risk  - Sensor at-risk events
factory.restart         - Factory restart events
```
