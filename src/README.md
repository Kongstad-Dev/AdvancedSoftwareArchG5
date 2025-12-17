# Source Code

## Factory System - Real-time Sensor Data Streaming to Kafka

A Python-based factory simulation system that generates sensor readings and streams them to Kafka topics in real-time. The system simulates multiple factories with sensors that monitor production lines and send heartbeats and sensor readings concurrently.

### Overview

The factory system consists of:
- **Factories**: Production facilities that process different products (sodas)
- **Sensors**: IoT devices attached to production lines that read measurements (0-100 range)
- **Kafka Integration**: Real-time data streaming to two topics: `SENSOR_READINGS` and `SENSOR_HEARTBEAT`

### Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Factory F1 │     │  Factory F2 │     │  Factory F3 │
│             │     │             │     │             │
│  Sensors:   │     │  Sensors:   │     │  Sensors:   │
│  - S1-1     │     │  - S2-1     │     │  - S3-1     │
│  - S1-2     │     │  - S2-2     │     │  - S3-2     │
│  - S1-3     │     │  - S2-3     │     │  - S3-3     │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       └───────────────────┴───────────────────┘
                           │
                    ┌──────▼──────┐
                    │    Kafka    │
                    │             │
                    │  Topics:    │
                    │  - SENSOR_  │
                    │    READINGS │
                    │  - SENSOR_  │
                    │    HEARTBEAT│
                    └─────────────┘
```

### How It Works

#### 1. **System Initialization**
- Creates X number of factories (default: 3)
- Each factory gets 3-5 randomly assigned sensors
- Each sensor has an ID (e.g., `S1-1`) and tier classification (e.g., `1.1`, `2.1`, `3.1`)
- Kafka producer is initialized and shared across all factories and sensors

#### 2. **Configuration Loading**
Each factory reads `factory_config.json` and extracts only its own configuration:

```json
{
  "F1": [
    {"sodaName": "Coca-Cola", "number": 10, "sensorID": "S1-1"},
    {"sodaName": "Pepsi", "number": 8, "sensorID": "S1-2"}
  ],
  "F2": [...],
  "F3": [...]
}
```

- `sodaName`: Product being produced
- `number`: Target number of readings to collect
- `sensorID`: Which sensor to use for readings

#### 3. **Concurrent Execution Flow**

```
Main Thread
    │
    ├─> Factory F1 Thread
    │       ├─> Start all sensor heartbeats (background threads)
    │       ├─> Coca-Cola Thread (S1-1)
    │       │       └─> Take 10 readings, 2-5 sec intervals
    │       └─> Pepsi Thread (S1-2)
    │               └─> Take 8 readings, 2-5 sec intervals
    │
    ├─> Factory F2 Thread
    │       ├─> Start all sensor heartbeats
    │       ├─> Sprite Thread (S2-1)
    │       └─> Fanta Thread (S2-2)
    │
    └─> Factory F3 Thread
            ├─> Start all sensor heartbeats
            ├─> Dr Pepper Thread (S3-1)
            └─> Mountain Dew Thread (S3-2)
```

All factories run **simultaneously**, and within each factory, all products are processed **concurrently**.

#### 4. **Sensor Heartbeat**
- Each sensor sends heartbeat messages every 1-2 seconds
- Runs in a background daemon thread
- Streams to `SENSOR_HEARTBEAT` topic

**Heartbeat Message Format:**
```json
{
  "sensorId": "S1-1",
  "tier": "1.1",
  "timestamp": "2025-12-03T14:30:45.123456",
  "status": "active"
}
```

#### 5. **Sensor Readings**
- Sensors take readings every 2-5 seconds (random interval)
- Each reading is a random value between 0-100
- Continues until target number is reached
- Streams to `SENSOR_READINGS` topic

**Reading Message Format:**
```json
{
  "factoryId": "F1",
  "sensorId": "S1-1",
  "tier": "1.1",
  "sodaName": "Coca-Cola",
  "reading": 42,
  "count": 5,
  "total": 10,
  "timestamp": "2025-12-03T14:30:45.123456"
}
```

#### 6. **Graceful Shutdown**
- After all readings are complete, heartbeats are stopped
- Kafka producer flushes remaining messages
- All threads are joined and resources cleaned up

### Kafka Topics

#### `SENSOR_HEARTBEAT`
- **Purpose**: Monitor sensor health and connectivity
- **Frequency**: Every 1-2 seconds per sensor
- **Use Case**: Detect sensor failures, track uptime

#### `SENSOR_READINGS`
- **Purpose**: Production line measurements
- **Frequency**: Every 2-5 seconds per active production line
- **Use Case**: Quality monitoring, production analytics

### Setup Instructions

#### Prerequisites
- Python 3.12+
- Docker & Docker Compose
- Kafka (via Docker)

#### 1. Start Kafka
```powershell
cd src
docker-compose up -d
```

Verify Kafka is running:
```powershell
docker-compose ps
```

#### 2. Install Dependencies
```powershell
pip install -r requirements.txt
```

#### 3. Run the Factory System
```powershell
python factory_system.py
```

#### 4. View Kafka Topics
List topics:
```powershell
docker exec -it kafka kafka-topics --list --bootstrap-server localhost:9092
```

Consume heartbeat messages:
```powershell
docker exec -it kafka kafka-console-consumer --bootstrap-server localhost:9092 --topic SENSOR_HEARTBEAT --from-beginning
```

Consume sensor readings:
```powershell
docker exec -it kafka kafka-console-consumer --bootstrap-server localhost:9092 --topic SENSOR_READINGS --from-beginning
```

### Configuration

Edit `factory_config.json` to customize:
- Which factories are active
- What products each factory produces
- How many readings per product
- Which sensors are assigned to each product

### Key Features

✅ **Concurrent Processing**: All factories and production lines run simultaneously  
✅ **Real-time Streaming**: Data sent to Kafka as it's generated  
✅ **Heartbeat Monitoring**: Continuous sensor health checks  
✅ **Flexible Configuration**: JSON-based factory and sensor setup  
✅ **Graceful Fallback**: Works without Kafka (console output mode)  
✅ **Type Safety**: Full type hints for better code quality  

### Error Handling

- **Missing Kafka**: Falls back to console output if Kafka unavailable
- **Missing Config**: Warns if factory has no configuration
- **Invalid Sensor**: Skips items referencing non-existent sensors
- **Malformed JSON**: Catches and reports JSON parsing errors

### Project Structure

```
src/
├── factory_system.py      # Main application
├── factory_config.json    # Factory configurations
├── requirements.txt       # Python dependencies
├── docker-compose.yml     # Kafka infrastructure
└── README.md             # This file
```

---

## Industry 4.0 Demo