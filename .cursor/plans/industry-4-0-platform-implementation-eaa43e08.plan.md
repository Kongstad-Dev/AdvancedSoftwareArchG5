<!-- eaa43e08-66d4-4782-923b-ce4b54181de1 98443b2a-2ac1-4eae-bf19-75665ba8eab2 -->
# Industry 4.0 Production Platform - Implementation Plan

## Project Structure

```
src/
├── pms/                          # Production Management System (Node.js)
│   ├── src/
│   │   ├── controllers/         # HTTP/gRPC controllers
│   │   ├── services/            # Business logic (scheduling, rescheduling)
│   │   ├── repositories/        # PostgreSQL data access
│   │   ├── proto/               # gRPC protobuf definitions
│   │   └── server.js            # Express + gRPC server
│   ├── Dockerfile
│   └── package.json
├── mms/                          # Monitoring & Maintenance System (Python)
│   ├── src/
│   │   ├── monitoring/          # Heartbeat monitoring, fault detection
│   │   ├── predictive/         # Predictive models for factory risk
│   │   ├── redundancy/          # Failover and reconfiguration logic
│   │   ├── proto/               # gRPC client stubs
│   │   └── main.py              # Kafka consumer + gRPC client
│   ├── Dockerfile
│   └── requirements.txt
├── bridge/                       # MQTT to Kafka bridge
│   ├── src/
│   │   └── bridge.js            # MQTT subscriber → Kafka producer
│   ├── Dockerfile
│   └── package.json
├── factories/                    # Factory simulators
│   ├── simulator/
│   │   ├── factory-simulator.js # MQTT publisher for each factory
│   │   └── config.js            # Factory IDs, heartbeat intervals
│   ├── Dockerfile
│   └── package.json
├── proto/                        # Shared protobuf definitions
│   └── factory.proto            # FactoryStatusUpdate, ReportFactoryStatus
└── docker-compose.yml           # All services + infrastructure
```

## Infrastructure Setup

### Docker Compose Services

- **PostgreSQL**: Orders, assignments, production events
- **MongoDB**: Heartbeats, anomalies, factory status
- **Mosquitto**: MQTT broker for factory heartbeats
- **Kafka + Zookeeper**: Central event backbone
- **PMS**: Node.js service (port 3000 HTTP, 50051 gRPC)
- **MMS**: Python service
- **Bridge**: MQTT→Kafka bridge service
- **Factory Simulators**: 4 instances (factory-1 through factory-4)

## Availability Tactics → Implementation Mapping

### 1. Heartbeat Monitoring (MMS)

**Location**: `src/mms/src/monitoring/heartbeat_monitor.py`

- **`HeartbeatMonitor` class**: Consumes `factory.heartbeat` Kafka topic
- **`process_heartbeat(factory_id, timestamp, metrics)`**: Records heartbeat in MongoDB
- **`check_timeouts()`**: Runs every 1s, flags factories with >3s gap since last heartbeat
- **`get_factory_status(factory_id)`**: Returns UP/DEGRADED/DOWN based on recent heartbeats

**MongoDB Schema**: `heartbeats` collection with `{factory_id, timestamp, metrics, status}`

### 2. Fault Detection (MMS)

**Location**: `src/mms/src/monitoring/fault_detector.py`

- **`FaultDetector` class**: Analyzes heartbeat patterns
- **`detect_faults()`**: Checks for 3 consecutive missed heartbeats OR timeout >3s
- **`calculate_error_rate(factory_id, window_seconds)`**: Computes error/timeout rate
- **`is_degraded(factory_id)`**: Flags factories with intermittent failures

**Integration**: Called by `HeartbeatMonitor` when timeout detected

### 3. Predictive Model (MMS)

**Location**: `src/mms/src/predictive/risk_predictor.py`

- **`RiskPredictor` class**: Simple rule-based predictive model
- **`predict_factory_risk(factory_id)`**: Returns HIGH/MEDIUM/LOW risk
  - Rules: error_rate > 0.1 → HIGH, increasing latency → MEDIUM, stable → LOW
- **`should_preemptively_rebalance(factory_id)`**: Returns true if risk is HIGH and capacity available elsewhere

**Data Source**: MongoDB heartbeats collection (last 5 minutes)

### 4. Reconfiguration / Failover (MMS → PMS)

**Location**: `src/mms/src/redundancy/failover_manager.py`

- **`FailoverManager` class**: Orchestrates failover when factory fails
- **`trigger_failover(factory_id, reason)`**: 
  - Queries MongoDB for backup factory capacity
  - Calls PMS gRPC `ReportFactoryStatus(factory_id=id, status=DOWN)`
  - Logs failover event
- **`handle_recovery(factory_id)`**: When factory recovers (5 consecutive healthy checks), calls PMS to rebalance

**gRPC Client**: `src/mms/src/grpc/pms_client.py` - gRPC stub for PMS `ReportFactoryStatus` RPC

### 5. Exception Handling (PMS & MMS)

**PMS Location**: `src/pms/src/services/exception_handler.js`

- **`handle_reschedule_error(order_id, error)`**: Retries rescheduling with exponential backoff
- **`handle_database_error(error)`**: Logs and returns graceful error response

**MMS Location**: `src/mms/src/monitoring/exception_handler.py`

- **`handle_kafka_consumer_error(error)`**: Retries connection, logs to MongoDB
- **`handle_grpc_error(error)`**: Retries gRPC call to PMS with backoff

### 6. Retry Logic (PMS)

**Location**: `src/pms/src/services/scheduling_service.js`

- **`rescheduleOrders(factory_id, target_factory_id)`**: 
  - Wraps database transaction in retry loop (max 3 attempts)
  - Uses PostgreSQL transactions to ensure atomicity
- **`assignOrderToFactory(order_id, factory_id)`**: Retries on database deadlock

### 7. Graceful Software Upgrade

**Docker Compose Strategy**:

- Services support health check endpoints (`/health`)
- `docker-compose up --no-deps <service>` restarts individual services
- Health checks ensure service is ready before accepting traffic

**Implementation**:

- **PMS**: `src/pms/src/controllers/health_controller.js` - `/health` endpoint
- **MMS**: `src/mms/src/health.py` - Health check that verifies Kafka/MongoDB connectivity

## Core Service Implementations

### PMS (Node.js)

**Controller Layer** (`src/pms/src/controllers/`):

- **`order_controller.js`**: REST endpoints - `POST /orders`, `GET /orders`, `GET /orders/:id`
- **`grpc_controller.js`**: gRPC service implementing `ReportFactoryStatus` RPC

**Service Layer** (`src/pms/src/services/`):

- **`scheduling_service.js`**: 
  - `createOrder(order_data)` - Creates order and assigns to factory
  - `rescheduleOrders(from_factory_id, to_factory_id)` - **Reconfiguration tactic**
  - `getFactoryCapacity(factory_id)` - Returns available capacity
- **`factory_service.js`**: Manages factory status updates from MMS

**Repository Layer** (`src/pms/src/repositories/`):

- **`order_repository.js`**: PostgreSQL queries for orders table
- **`factory_repository.js`**: PostgreSQL queries for factory_assignments table

**Database Schema** (PostgreSQL):

```sql
CREATE TABLE orders (id SERIAL PRIMARY KEY, product_type VARCHAR, quantity INT, deadline TIMESTAMP, status VARCHAR);
CREATE TABLE factory_assignments (order_id INT, factory_id VARCHAR, assigned_at TIMESTAMP);
CREATE TABLE factories (id VARCHAR PRIMARY KEY, capacity INT, status VARCHAR);
```

### MMS (Python)

**Main Loop** (`src/mms/src/main.py`):

- Kafka consumer for `factory.heartbeat` topic
- Calls `HeartbeatMonitor.process_heartbeat()` for each message
- Periodic `check_timeouts()` every 1 second
- On fault detection, calls `FailoverManager.trigger_failover()`

**Monitoring Module** (`src/mms/src/monitoring/`):

- **`heartbeat_monitor.py`**: Core heartbeat processing
- **`fault_detector.py`**: Fault detection logic
- **`factory_status.py`**: Factory status state machine (UP → DEGRADED → DOWN)

**Predictive Module** (`src/mms/src/predictive/`):

- **`risk_predictor.py`**: Risk calculation based on error rates and latency trends

**Redundancy Module** (`src/mms/src/redundancy/`):

- **`failover_manager.py`**: Failover orchestration
- **`recovery_manager.py`**: Recovery detection and rebalancing

**MongoDB Schema**:

```python
heartbeats: {factory_id, timestamp, metrics: {cpu, memory, errors}, status}
factory_status: {factory_id, current_status, last_updated, risk_level}
failover_events: {factory_id, timestamp, reason, target_factory}
```

### MQTT-Kafka Bridge

**Location**: `src/bridge/src/bridge.js`

- Subscribes to MQTT topic `factory/+/heartbeat` (wildcard for all factories)
- Publishes to Kafka topic `factory.heartbeat` with factory ID extracted from MQTT topic
- Handles MQTT reconnection and Kafka producer errors

### Factory Simulators

**Location**: `src/factories/simulator/factory-simulator.js`

- **4 instances** (factory-1, factory-2, factory-3, factory-4)
- Publishes heartbeat to MQTT topic `factory/<id>/heartbeat` every 1 second
- Can simulate failures (stop publishing) or degraded state (publish with delays)
- Configurable via environment variables

## gRPC Communication

**Protobuf Definition** (`src/proto/factory.proto`):

```protobuf
service FactoryStatusService {
  rpc ReportFactoryStatus(FactoryStatusUpdate) returns (StatusResponse);
}

message FactoryStatusUpdate {
  string factory_id = 1;
  FactoryStatus status = 2;
  string reason = 3;
}

enum FactoryStatus {
  UP = 0;
  DEGRADED = 1;
  DOWN = 2;
}
```

**PMS Implementation**: `src/pms/src/controllers/grpc_controller.js` implements the service

**MMS Client**: `src/mms/src/grpc/pms_client.py` calls the service

## Testing Strategy

- **Unit Tests**: Each service layer (scheduling logic, fault detection)
- **Integration Tests**: PMS ↔ PostgreSQL, MMS ↔ MongoDB, MMS ↔ PMS (gRPC)
- **End-to-End**: Full flow from factory heartbeat → MMS → PMS rescheduling

## Deployment

- Single `docker-compose up` starts entire system
- Individual service restarts: `docker-compose restart pms` (demonstrates graceful upgrade)
- Health checks ensure services are ready before accepting traffic

### To-dos

- [ ] Create project structure with directories for PMS, MMS, bridge, factories, and proto
- [ ] Create docker-compose.yml with all infrastructure (PostgreSQL, MongoDB, Kafka, Mosquitto) and services
- [ ] Define gRPC protobuf schema for FactoryStatusService (factory.proto)
- [ ] Create PostgreSQL schema and repository layer for orders, factory_assignments, factories
- [ ] Implement PMS service layer: scheduling_service.js (createOrder, rescheduleOrders, getFactoryCapacity)
- [ ] Implement PMS controllers: REST order_controller.js and gRPC grpc_controller.js
- [ ] Create PMS server.js with Express (REST) and gRPC server, health check endpoint
- [ ] Create MongoDB schema and data access layer for heartbeats, factory_status, failover_events
- [ ] Implement MMS monitoring: heartbeat_monitor.py, fault_detector.py, factory_status.py
- [ ] Implement MMS predictive module: risk_predictor.py with rule-based risk calculation
- [ ] Implement MMS redundancy: failover_manager.py and recovery_manager.py
- [ ] Create MMS gRPC client (pms_client.py) to call PMS ReportFactoryStatus
- [ ] Create MMS main.py: Kafka consumer loop, heartbeat processing, fault detection, failover triggering
- [ ] Implement MQTT to Kafka bridge: subscribe to factory/+/heartbeat, publish to factory.heartbeat
- [ ] Create 4 factory simulator instances that publish MQTT heartbeats with configurable failure modes
- [ ] Add exception handling and retry logic to PMS (rescheduling) and MMS (Kafka, gRPC)
- [ ] Add health check endpoints to PMS and MMS for graceful software upgrade demonstrations
- [ ] Create Dockerfiles for PMS, MMS, bridge, and factory simulators