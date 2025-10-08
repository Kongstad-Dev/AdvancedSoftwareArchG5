# Industry 4.0 Polyglot Demo

This enhanced demonstrator showcases how the architectural decisions from the course slides come together in a runnable, polyglot prototype. It validates interaction, interoperability, and dependability while adding diversity across languages, databases, messaging technologies, and patterns.

## Components & Styles
- **PMS (Node.js, layered)** – Publishes `workflow-started` events to Kafka and synchronises configuration with MMS/Redundancy over gRPC.
- **MMS Monitoring (Python, event-driven layers)** – Bridges MQTT sensor telemetry to Kafka, stores traces in PostgreSQL, and invokes gRPC with a circuit breaker.
- **MMS Redundancy (Go, microservice)** – Runs the gRPC server, persists reroute audits in MongoDB, and emits RabbitMQ alerts guarded by Hystrix-style breakers.
- **DIS Coordinator (Node.js, microservice with Visitor pattern)** – Consumes RabbitMQ alerts, traverses MongoDB configuration documents, and dispatches notifications via Nodemailer JSON transport.
- **Sensor Mock (Node.js)** – Simulates heterogeneous hardware via MQTT.

Support artefacts include Protocol Buffer definitions (`proto/`), SysML/Mermaid models (`models/`), a transformation script that materialises requirement stubs (`transformation/`), and formal verification seeds (`verification/`).

## Prerequisites
- Node.js 20+
- Python 3.12+
- Go 1.21+
- Docker & Podman (to highlight container diversity)
- `pip`, `npm`, `go` toolchains, and (optional) `grpc-tools` / `protoc`

## Setup
```bash
cd src/industry4-demo

# Install language-specific dependencies
npm install
pip install -r requirements.txt
go mod tidy

# Generate requirement stubs from SysML
python transformation/sysml_to_code.py

# (Optional) generate Node gRPC bindings if you prefer static stubs
npm run proto:generate:node
```

## Infrastructure
Two compose files keep infrastructure intentionally diverse:
- `docker-compose.yml` – Zookeeper, Kafka, PostgreSQL (Docker)
- `podman-compose.yml` – RabbitMQ, MongoDB (Podman)

```bash
npm run infra:docker:up
npm run infra:podman:up
```

Stop them with the matching `:down` scripts. Adjust URLs through environment variables when needed.

## Running the Demo
In separate terminals (order shown helps observe the flow):
```bash
# 1. Start shared infrastructure (Kafka/Postgres + RabbitMQ/Mongo)
cd src/industry4-demo
npm run infra:docker:up
npm run infra:podman:up

# Terminal A
go run services/go/mms-redundancy.go

# Terminal B
python services/python/mms-monitoring.py

# Terminal C (optional – regenerate requirements prior to start)
node services/node/dis/dis-coordinator.js

# Terminal D
node services/node/mock/sensor-mock.js --fail-after 15000 --sensors 3

# Terminal E – trigger workflow once sensors are publishing
node services/node/pms/pms-publisher.js --factory 1 --workflow bottling
```

### Observing Validation Points
- **Interaction** – Kafka events flow PMS → Monitoring → Redundancy, while RabbitMQ alerts reach DIS. gRPC bridges the synchronous gap.
- **Interoperability** – MQTT adapter + Protocol Buffers span Node, Python, Go; PostgreSQL and MongoDB mix structured/unstructured storage.
- **Dependability** – Circuit breakers (`opossum`, `pybreaker`, Hystrix-Go) guard gRPC and RabbitMQ interactions, while Nodemailer emits reroute notifications; reroute decisions reach Mongo/RabbitMQ within sub-second latency (logs include timestamps).
- **Formal Links** – SysML requirements → generated stubs → referenced in each language. Mermaid diagrams model structure/behaviour; TLA+ spec (`verification/event_flow.tla`) checks that every failure alert originates from an anomaly.

### Failure Injection
Stop the sensor mock (Ctrl+C) or launch it with `--fail-after` to trigger anomalies. Monitoring trips the breaker, Go service publishes alerts, and DIS logs visitor traversal across factories stored in MongoDB.

## Verification
- Run `python transformation/sysml_to_code.py` to regenerate requirement stubs and ensure traceability artifacts stay current.
- Execute `tla2sany verification/event_flow.tla` followed by your preferred TLC run to confirm that every failure alert correlates to an anomaly event (Availability invariant).
- Export Kafka/RabbitMQ traces and feed them into NuXmv if you wish to extend model checking for latency constraints (create additional models under `verification/`).

## Cleanup
```bash
npm run infra:docker:down
npm run infra:podman:down
```

Mongo and Postgres use named volumes; remove them manually if you require a clean slate.

## Next Extensions
- Add additional protocol buffers for asset telemetry.
- Extend TLA+ / NuXmv models for latency invariants.
- Deploy RabbitMQ and MongoDB via Kubernetes manifests to align with Exercise 4’s deployment tactics.
