import json
import os
import pathlib
import sys
import time
from urllib.parse import urlparse

import grpc
import paho.mqtt.client as mqtt
import psycopg2
from kafka import KafkaProducer
from pybreaker import CircuitBreaker, CircuitBreakerError

try:
    from grpc_tools import protoc  # type: ignore
except ImportError as exc:  # pragma: no cover
    raise SystemExit(
        "grpcio-tools is required. Install via pip install grpcio-tools before running this service."
    ) from exc


BASE_DIR = pathlib.Path(__file__).resolve().parents[2]
PROTO_DIR = BASE_DIR / "proto"
GENERATED_DIR = pathlib.Path(__file__).resolve().parent / "__generated__"
GENERATED_DIR.mkdir(exist_ok=True)


def ensure_proto_generated() -> None:
    python_file = GENERATED_DIR / "health_pb2.py"
    grpc_file = GENERATED_DIR / "health_pb2_grpc.py"
    if python_file.exists() and grpc_file.exists():
        return

    result = protoc.main(
        [
          "",  # protoc expects argv[0]
          f"-I{PROTO_DIR}",
          f"--python_out={GENERATED_DIR}",
          f"--grpc_python_out={GENERATED_DIR}",
          str(PROTO_DIR / "health.proto"),
        ]
    )
    if result != 0:  # pragma: no cover
        raise RuntimeError("Failed to generate gRPC Python modules from proto/health.proto")


ensure_proto_generated()
sys.path.insert(0, str(GENERATED_DIR))
from health_pb2 import HealthEvent  # type: ignore  # noqa: E402
from health_pb2_grpc import HealthServiceStub  # type: ignore  # noqa: E402


CONFIG = {
    "mqtt_url": os.getenv("MQTT_URL", "mqtt://localhost:1883"),
    "mqtt_topic": os.getenv("MQTT_SENSOR_TOPIC", "factory1/sensors"),
    "kafka_brokers": os.getenv("KAFKA_BROKERS", "localhost:9092"),
    "kafka_topic": os.getenv("TOPIC_SENSOR_HEALTH", "sensor-health"),
    "grpc_target": os.getenv("MMS_GRPC_TARGET", "localhost:50051"),
    "postgres_url": os.getenv("POSTGRES_URL", "postgres://demo:demo@localhost:5432/workflows"),
    "anomaly_threshold": float(os.getenv("ANOMALY_THRESHOLD", "75.0")),
}


def establish_postgres():
    conn = psycopg2.connect(CONFIG["postgres_url"])
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS health_logs (
                id SERIAL PRIMARY KEY,
                sensor_id TEXT,
                payload JSONB,
                anomaly BOOLEAN,
                recorded_at TIMESTAMPTZ DEFAULT NOW()
            )
            """
        )
    return conn


def build_producer():
    return KafkaProducer(
        bootstrap_servers=CONFIG["kafka_brokers"].split(","),
        value_serializer=lambda value: json.dumps(value).encode("utf-8"),
    )


def main():
    mqtt_client = mqtt.Client()
    postgres_conn = establish_postgres()
    kafka_producer = build_producer()
    grpc_channel = grpc.insecure_channel(CONFIG["grpc_target"])
    grpc_stub = HealthServiceStub(grpc_channel)

    breaker = CircuitBreaker(fail_max=3, reset_timeout=30)

    def on_message(_client, _userdata, message):
        payload = json.loads(message.payload.decode("utf-8"))
        status = payload.get("status", "unknown")
        is_anomaly = status != "healthy" or float(payload.get("value") or 0) > CONFIG["anomaly_threshold"]
        reason = "status" if status != "healthy" else "threshold"
        health_event = {
            "sensorId": str(payload.get("sensorId")),
            "status": status,
            "value": payload.get("value"),
            "anomaly": is_anomaly,
            "reason": reason,
            "timestamp": payload.get("timestamp", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())),
        }
        print(f"[MMS] Ingested sensor data: {health_event}")

        with postgres_conn.cursor() as cursor:
            cursor.execute(
                "INSERT INTO health_logs (sensor_id, payload, anomaly) VALUES (%s, %s, %s)",
                (health_event["sensorId"], json.dumps(health_event), is_anomaly),
            )

        kafka_producer.send(CONFIG["kafka_topic"], health_event)
        kafka_producer.flush()

        grpc_payload = HealthEvent(
            sensorId=health_event["sensorId"],
            anomaly=health_event["anomaly"],
            reason=health_event["reason"],
            timestamp=health_event["timestamp"],
        )

        try:
            response = breaker.call(grpc_stub.PublishHealth, grpc_payload)
            print(f"[MMS] gRPC PublishHealth ack={response.accepted}")
        except CircuitBreakerError as error:
            print(f"[MMS] Circuit breaker open: {error}")
        except grpc.RpcError as error:
            print(f"[MMS] gRPC error: {error}")

    def on_connect(client, _userdata, _flags, _rc):
        print(f"[MMS] Connected to MQTT broker at {CONFIG['mqtt_url']}, subscribing to {CONFIG['mqtt_topic']}")
        client.subscribe(CONFIG["mqtt_topic"])

    mqtt_client.on_connect = on_connect
    mqtt_client.on_message = on_message
    parsed = urlparse(CONFIG["mqtt_url"])
    host = parsed.hostname or "localhost"
    port = parsed.port or 1883
    mqtt_client.connect(host, port)
    mqtt_client.loop_forever()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("[MMS] Shutdown requested by user")
