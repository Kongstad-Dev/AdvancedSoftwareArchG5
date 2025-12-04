"""
MMS Main Application
Sensor-based monitoring: Kafka consumer, sensor processing, factory health calculation
"""
import logging
import json
import asyncio
import signal
from datetime import datetime
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
from kafka import KafkaConsumer
from kafka.errors import KafkaError

from .config import config
from .db.mongodb import mongodb_client
from .monitoring.sensor_monitor import sensor_monitor, FactoryHealthStatus
from .grpc.pms_client import pms_client
from .health import router as health_router

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Global shutdown flag
shutdown_event = asyncio.Event()


class KafkaSensorConsumer:
    """Kafka consumer for sensor readings"""
    
    def __init__(self):
        self._consumer: Optional[KafkaConsumer] = None
        self._running = False
    
    def connect(self) -> bool:
        """Connect to Kafka"""
        try:
            self._consumer = KafkaConsumer(
                config.kafka_sensor_topic,
                bootstrap_servers=config.kafka_brokers_list,
                group_id=config.kafka_consumer_group,
                auto_offset_reset='latest',
                enable_auto_commit=True,
                value_deserializer=lambda x: json.loads(x.decode('utf-8'))
            )
            logger.info(f"Connected to Kafka broker(s): {config.kafka_brokers}")
            return True
        except KafkaError as e:
            logger.error(f"Failed to connect to Kafka: {e}")
            return False
    
    async def consume_loop(self):
        """Main consumption loop"""
        if not self._consumer:
            if not self.connect():
                logger.error("Cannot start consumer loop - not connected")
                return
        
        self._running = True
        logger.info("Starting Kafka sensor consumer loop")
        
        while self._running and not shutdown_event.is_set():
            try:
                # Poll for messages with timeout
                messages = self._consumer.poll(timeout_ms=1000)
                
                for topic_partition, records in messages.items():
                    for record in records:
                        await self._process_message(record.value)
                
                # Small delay to prevent tight loop
                await asyncio.sleep(0.1)
                
            except KafkaError as e:
                logger.error(f"Kafka consumer error: {e}")
                await asyncio.sleep(5)  # Wait before retry
                self.connect()  # Try to reconnect
            except Exception as e:
                logger.error(f"Unexpected error in consumer loop: {e}")
                await asyncio.sleep(1)
    
    async def _process_message(self, message: dict):
        """Process a sensor reading message"""
        try:
            sensor_monitor.process_sensor_reading(message)
        except Exception as e:
            logger.error(f"Error processing sensor message: {e}")
    
    def stop(self):
        """Stop the consumer"""
        self._running = False
        if self._consumer:
            self._consumer.close()
            logger.info("Kafka consumer closed")


# Create global consumer instance
kafka_consumer = KafkaSensorConsumer()


async def monitoring_loop():
    """
    Periodic monitoring loop.
    - Check sensor timeouts
    - Monitor factory health changes
    """
    logger.info("Starting monitoring loop")
    
    while not shutdown_event.is_set():
        try:
            # Check for sensor timeouts
            sensor_monitor.check_sensor_timeouts()
            
        except Exception as e:
            logger.error(f"Error in monitoring loop: {e}")
        
        await asyncio.sleep(1)  # Run every second


def setup_callbacks():
    """Setup callbacks for status changes"""
    
    def on_sensor_failed(sensor_id: str, factory_id: str, reason: str):
        logger.warning(f"Sensor failed: {sensor_id} in {factory_id} - {reason}")
    
    async def on_factory_status_change(
        factory_id: str, 
        old_status: Optional[FactoryHealthStatus], 
        new_status: FactoryHealthStatus,
        health_percentage: float
    ):
        logger.info(
            f"Factory {factory_id} status changed: "
            f"{old_status.value if old_status else 'NEW'} -> {new_status.value} "
            f"({health_percentage:.0f}% health)"
        )
        
        # Notify PMS if factory becomes CRITICAL or DOWN
        if new_status in [FactoryHealthStatus.CRITICAL, FactoryHealthStatus.DOWN]:
            try:
                # Map to gRPC status
                grpc_status = "DOWN" if new_status == FactoryHealthStatus.DOWN else "DEGRADED"
                pms_client.update_factory_status(factory_id, grpc_status)
                logger.info(f"Notified PMS of factory {factory_id} status: {grpc_status}")
            except Exception as e:
                logger.error(f"Failed to notify PMS: {e}")
        elif new_status == FactoryHealthStatus.OPERATIONAL:
            try:
                pms_client.update_factory_status(factory_id, "UP")
                logger.info(f"Notified PMS of factory {factory_id} recovery")
            except Exception as e:
                logger.error(f"Failed to notify PMS of recovery: {e}")
    
    sensor_monitor.on_sensor_failed(on_sensor_failed)
    sensor_monitor.on_factory_status_change(
        lambda fid, old, new, pct: asyncio.create_task(
            on_factory_status_change(fid, old, new, pct)
        )
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler"""
    # Startup
    logger.info("Starting MMS (Sensor Monitoring)...")
    
    # Connect to MongoDB
    if not mongodb_client.connect():
        logger.error("Failed to connect to MongoDB")
        raise RuntimeError("MongoDB connection failed")
    
    # Connect to PMS
    pms_client.connect()
    
    # Setup callbacks
    setup_callbacks()
    
    # Start background tasks
    consumer_task = asyncio.create_task(kafka_consumer.consume_loop())
    monitoring_task = asyncio.create_task(monitoring_loop())
    
    logger.info("MMS started successfully")
    
    yield
    
    # Shutdown
    logger.info("Shutting down MMS...")
    shutdown_event.set()
    
    kafka_consumer.stop()
    mongodb_client.close()
    pms_client.close()
    
    # Cancel background tasks
    consumer_task.cancel()
    monitoring_task.cancel()
    
    try:
        await consumer_task
    except asyncio.CancelledError:
        pass
    
    try:
        await monitoring_task
    except asyncio.CancelledError:
        pass
    
    logger.info("MMS shutdown complete")


# Create FastAPI app
app = FastAPI(
    title="Monitoring & Maintenance System (MMS)",
    description="Sensor-based factory monitoring and health management",
    version="2.0.0",
    lifespan=lifespan
)

# Add CORS middleware for dashboard access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include health router
app.include_router(health_router)


@app.get("/")
async def root():
    """Root endpoint"""
    return {
        "service": "Monitoring & Maintenance System (MMS)",
        "version": "2.0.0",
        "description": "Sensor-based factory health monitoring",
        "endpoints": {
            "health": "/health",
            "factories": "/api/factories",
            "sensors": "/api/sensors/{factory_id}"
        }
    }


@app.get("/api/factories")
async def get_all_factories():
    """Get health status of all factories"""
    all_health = sensor_monitor.get_all_factory_health()
    
    return {
        "factories": [
            {
                "factory_id": fid,
                "status": health.status.value,
                "health_percentage": round(health.health_percentage, 1),
                "sensors": {
                    "total": health.total_sensors,
                    "ok": health.ok_sensors,
                    "warning": health.warning_sensors,
                    "failed": health.failed_sensors
                },
                "last_updated": health.last_updated.isoformat()
            }
            for fid, health in all_health.items()
        ]
    }


@app.get("/api/factories/{factory_id}")
async def get_factory(factory_id: str):
    """Get detailed factory health"""
    health = sensor_monitor.get_factory_health(factory_id)
    
    if not health:
        return {"error": "Factory not found", "factory_id": factory_id}
    
    sensors = sensor_monitor.get_factory_sensors(factory_id)
    
    # Group sensors by type
    sensors_by_type = {"temperature": [], "level": [], "quality": []}
    for sensor_id, status in sensors.items():
        # Extract type from sensor_id (e.g., factory-1-temp-1 -> temp)
        if "-temp-" in sensor_id:
            sensors_by_type["temperature"].append({"id": sensor_id, "status": status.value})
        elif "-level-" in sensor_id:
            sensors_by_type["level"].append({"id": sensor_id, "status": status.value})
        else:
            sensors_by_type["quality"].append({"id": sensor_id, "status": status.value})
    
    return {
        "factory_id": factory_id,
        "status": health.status.value,
        "health_percentage": round(health.health_percentage, 1),
        "sensors_summary": {
            "total": health.total_sensors,
            "ok": health.ok_sensors,
            "warning": health.warning_sensors,
            "failed": health.failed_sensors
        },
        "sensors_by_type": sensors_by_type,
        "last_updated": health.last_updated.isoformat()
    }


@app.get("/api/sensors/{factory_id}")
async def get_factory_sensors(factory_id: str):
    """Get all sensors for a factory"""
    sensors = sensor_monitor.get_factory_sensors(factory_id)
    
    if not sensors:
        return {"error": "No sensors found for factory", "factory_id": factory_id}
    
    return {
        "factory_id": factory_id,
        "sensor_count": len(sensors),
        "sensors": [
            {"sensor_id": sid, "status": status.value}
            for sid, status in sensors.items()
        ]
    }


@app.get("/api/status")
async def get_status():
    """Get overall system status (legacy compatibility)"""
    all_health = sensor_monitor.get_all_factory_health()
    
    return {
        "factories": [
            {
                "factory_id": fid,
                "status": health.status.value,
                "health_percentage": round(health.health_percentage, 1)
            }
            for fid, health in all_health.items()
        ]
    }


@app.post("/api/factories/trigger-failure")
async def trigger_random_failure():
    """Trigger a random sensor failure on a random factory"""
    import random
    
    all_health = sensor_monitor.get_all_factory_health()
    factory_ids = list(all_health.keys())
    
    if not factory_ids:
        return {"error": "No factories available"}
    
    # Pick a random factory
    factory_id = random.choice(factory_ids)
    
    # Get factory sensors
    sensors = sensor_monitor.get_factory_sensors(factory_id)
    ok_sensors = [sid for sid, status in sensors.items() if status.value == "OK"]
    
    if not ok_sensors:
        return {"error": "No healthy sensors to fail", "factory_id": factory_id}
    
    # Pick random sensors to fail (1-3 sensors)
    num_to_fail = min(random.randint(1, 3), len(ok_sensors))
    sensors_to_fail = random.sample(ok_sensors, num_to_fail)
    
    # Mark sensors as failed (persist for 60 seconds)
    from .monitoring.sensor_monitor import SensorStatus
    for sensor_id in sensors_to_fail:
        sensor_monitor.update_sensor_status(factory_id, sensor_id, SensorStatus.FAILED, duration_seconds=60)
    
    logger.info(f"Triggered failure on {factory_id}: {sensors_to_fail}")
    
    return {
        "success": True,
        "factory_id": factory_id,
        "failed_sensors": sensors_to_fail,
        "message": f"Failed {num_to_fail} sensors on {factory_id} (60s duration)"
    }


@app.post("/api/factories/{factory_id}/trigger-failure")
async def trigger_specific_failure(factory_id: str):
    """Trigger a sensor failure on a specific factory"""
    import random
    
    all_health = sensor_monitor.get_all_factory_health()
    
    if factory_id not in all_health:
        return {"error": f"Factory {factory_id} not found", "success": False}
    
    # Get factory sensors
    sensors = sensor_monitor.get_factory_sensors(factory_id)
    ok_sensors = [sid for sid, status in sensors.items() if status.value == "OK"]
    
    if not ok_sensors:
        return {"error": "No healthy sensors to fail", "factory_id": factory_id, "success": False}
    
    # Pick random sensors to fail (1-2 sensors)
    num_to_fail = min(random.randint(1, 2), len(ok_sensors))
    sensors_to_fail = random.sample(ok_sensors, num_to_fail)
    
    # Mark sensors as failed (persist for 60 seconds)
    from .monitoring.sensor_monitor import SensorStatus
    for sensor_id in sensors_to_fail:
        sensor_monitor.update_sensor_status(factory_id, sensor_id, SensorStatus.FAILED, duration_seconds=60)
    
    logger.info(f"Triggered failure on {factory_id}: {sensors_to_fail} (60s duration)")
    
    return {
        "success": True,
        "factory_id": factory_id,
        "failed_sensors": sensors_to_fail,
        "message": f"Failed {num_to_fail} sensors on {factory_id} (60s duration)"
    }


@app.post("/api/factories/{factory_id}/trigger-warning")
async def trigger_specific_warning(factory_id: str):
    """Trigger a sensor warning on a specific factory"""
    import random
    
    all_health = sensor_monitor.get_all_factory_health()
    
    if factory_id not in all_health:
        return {"error": f"Factory {factory_id} not found", "success": False}
    
    # Get factory sensors
    sensors = sensor_monitor.get_factory_sensors(factory_id)
    ok_sensors = [sid for sid, status in sensors.items() if status.value == "OK"]
    
    if not ok_sensors:
        return {"error": "No healthy sensors to warn", "factory_id": factory_id, "success": False}
    
    # Pick random sensors to warn (1-2 sensors)
    num_to_warn = min(random.randint(1, 2), len(ok_sensors))
    sensors_to_warn = random.sample(ok_sensors, num_to_warn)
    
    # Mark sensors as warning (persist for 30 seconds)
    from .monitoring.sensor_monitor import SensorStatus
    for sensor_id in sensors_to_warn:
        sensor_monitor.update_sensor_status(factory_id, sensor_id, SensorStatus.WARNING, duration_seconds=30)
    
    logger.info(f"Triggered warning on {factory_id}: {sensors_to_warn} (30s duration)")
    
    return {
        "success": True,
        "factory_id": factory_id,
        "warned_sensors": sensors_to_warn,
        "message": f"Warned {num_to_warn} sensors on {factory_id} (30s duration)"
    }


@app.post("/api/factories/{factory_id}/load")
async def update_factory_load(factory_id: str, load_data: dict = None):
    """Receive factory load updates from order-generator"""
    # This is a notification endpoint - just acknowledge it
    return {"success": True, "factory_id": factory_id}


def main():
    """Main entry point"""
    uvicorn.run(
        "src.main:app",
        host="0.0.0.0",
        port=config.health_check_port,
        log_level="info"
    )


if __name__ == "__main__":
    main()
