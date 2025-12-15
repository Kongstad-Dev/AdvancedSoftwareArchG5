# NFR Testing Suite

This directory contains automated tests to validate Non-Functional Requirements (NFRs) related to communication latency and fault tolerance.

## Test Files

### 1. `nfr_mqtt_kafka_latency.test.js`
**NFR:** MQTT → Kafka message propagation should complete within 1 second

**What it tests:**
- Sends 10 sensor readings via MQTT
- Measures time for messages to arrive in Kafka
- Validates 95% of messages arrive within 1 second

**Run:**
```bash
cd src/pms
npm run test:latency
```

### 2. `nfr_sensor_failure_detection.test.js`
**NFR:** Sensor failure detection and replacement should complete within 35 seconds

**What it tests:**
- Creates an order and waits for sensor assignment
- Simulates sensor failure (reading < 10)
- Measures time for MMS to detect failure
- Measures time for PMS to replace sensor
- Validates total latency < 35 seconds

**Run:**
```bash
cd src/pms
npm run test:failure
```

### 3. `nfr_communication_latency.test.js`
**NFR:** MMS should detect sensor heartbeat timeout within 5 seconds

**What it tests:**
- Sends healthy heartbeat via MQTT
- Stops sending heartbeats (simulates failure)
- Measures time for MMS to detect missing heartbeat
- Validates detection latency < 6 seconds (5s timeout + 1s buffer)

**Run:**
```bash
cd src/pms
npm run test:nfr
```

## Prerequisites

Before running tests, ensure:
1. System is running: `docker-compose up -d`
2. All services are healthy: `docker-compose ps`
3. Dependencies installed: `cd src/pms && npm install`

## Expected Results

### MQTT → Kafka Latency Test
```
=== MQTT → Kafka Latency Statistics ===
Messages tested: 10
Average latency: 234.56ms
Min latency: 187ms
Max latency: 412ms
Messages within 1s: 100.0%

✓ should propagate sensor reading from MQTT to Kafka within 1 second
```

### Sensor Failure Detection Test
```
Order 123 created at 2025-12-14T10:15:30.000Z
Initial sensor: S1-2
Failure simulated at 2025-12-14T10:15:32.000Z
MMS detected failure at 2025-12-14T10:15:37.000Z
Sensor replaced to S1-1 at 2025-12-14T10:15:42.000Z

=== Latency Results ===
Detection latency: 5.00s
Total replacement latency: 10.00s

✓ should detect failure, replace sensor, and resume production within 35 seconds
```

### Communication Latency Test
```
=== Communication Latency Breakdown ===
Heartbeat sent: 2025-12-14T10:15:30.000Z
Failure simulated: 2025-12-14T10:15:31.000Z
MMS detection: 2025-12-14T10:15:36.000Z
PMS notified: 2025-12-14T10:15:37.000Z

Detection latency: 5000ms (5.00s)
End-to-end latency: 6000ms (6.00s)

✓ should detect sensor failure and notify PMS within 5 seconds
```

## NFR Assertions

| NFR | Requirement | Assertion |
|-----|-------------|-----------|
| Message Latency | MQTT → Kafka < 1s | `expect(avgLatency).to.be.lessThan(1000)` |
| Detection Latency | Heartbeat timeout detection < 6s | `expect(detectionLatency).to.be.lessThan(6000)` |
| Recovery Latency | Sensor replacement < 35s | `expect(replacementLatency).to.be.lessThan(35)` |
| Message Reliability | 95% messages arrive within 1s | `expect(percentageWithin1s).to.be.at.least(95)` |

## Troubleshooting

**Tests timeout:**
- Ensure Docker services are running: `docker-compose ps`
- Check service logs: `docker-compose logs mms pms`

**Connection errors:**
- Verify ports are accessible: `curl http://localhost:3000/health`
- Check MQTT broker: `docker-compose logs mosquitto`
- Check Kafka: `docker-compose logs kafka`

**Tests fail intermittently:**
- Network latency may vary - increase timeout in test if needed
- System may be under load - run tests on idle system
- Check for port conflicts with other applications
