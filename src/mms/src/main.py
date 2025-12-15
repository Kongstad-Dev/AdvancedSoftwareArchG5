"""
MMS Main Application
Kafka consumer loop, heartbeat processing, fault detection, failover triggering
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

from .config import config
from .db.mongodb import mongodb_client
from .monitoring.heartbeat_monitor import heartbeat_monitor
from .monitoring.fault_detector import fault_detector
from .monitoring.factory_status import factory_status_manager, FactoryStatus
from .monitoring.sensor_health_monitor import sensor_health_monitor
from .monitoring.kafka_listener import factory_kafka_listener
from .predictive.risk_predictor import risk_predictor
from .redundancy.failover_manager import failover_manager
from .redundancy.recovery_manager import recovery_manager
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


async def monitoring_loop():
    """
    Periodic monitoring loop.
    - Check heartbeat timeouts
    - Run fault detection
    - Check for recoveries
    - Run risk prediction
    """
    logger.info("Starting monitoring loop")
    
    while not shutdown_event.is_set():
        try:
            # Check heartbeat timeouts
            heartbeat_monitor.check_timeouts()
            
            # Get all tracked factories
            all_statuses = factory_status_manager.get_all_statuses()
            
            for factory_id, status in all_statuses.items():
                # Run fault detection
                faults = fault_detector.detect_faults(factory_id)
                
                if faults:
                    logger.info(f"Detected {len(faults)} fault(s) for {factory_id}")
                    
                    # Check if we need to trigger failover
                    high_severity_faults = [f for f in faults if f.severity == "HIGH"]
                    if high_severity_faults and status != FactoryStatus.DOWN:
                        await failover_manager.trigger_failover(
                            factory_id,
                            f"High severity fault: {high_severity_faults[0].fault_type.value}"
                        )
                
                # Run risk prediction periodically
                risk_predictor.predict_factory_risk(factory_id)
                
                # Check for preemptive rebalancing
                if risk_predictor.should_preemptively_rebalance(factory_id):
                    await failover_manager.preemptive_rebalance(factory_id)
            
            # Check for recoveries
            await recovery_manager.check_all_recoveries()
            
        except Exception as e:
            logger.error(f"Error in monitoring loop: {e}")
        
        await asyncio.sleep(1)  # Run every second


def setup_callbacks():
    """Setup callbacks for status changes"""
    
    def on_timeout(factory_id: str, reason: str, count: int):
        logger.warning(f"Factory timeout: {factory_id} - {reason} ({count})")
    
    def on_recovery(factory_id: str):
        logger.info(f"Factory recovery detected: {factory_id}")
    
    def on_status_change(factory_id: str, old_status: FactoryStatus, new_status: FactoryStatus, reason: str):
        logger.info(f"Factory status changed: {factory_id} {old_status.value} -> {new_status.value} ({reason})")
    
    heartbeat_monitor.on_timeout(on_timeout)
    heartbeat_monitor.on_recovery(on_recovery)
    factory_status_manager.on_any_transition(on_status_change)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler"""
    # Startup
    logger.info("Starting MMS...")
    
    # Connect to MongoDB
    if not mongodb_client.connect():
        logger.error("Failed to connect to MongoDB")
        raise RuntimeError("MongoDB connection failed")
    
    # Connect to PMS
    pms_client.connect()
    
    # Connect to Kafka for sensor monitoring
    if not factory_kafka_listener.connect():
        logger.warning("Failed to connect to Kafka broker - sensor monitoring disabled")
    else:
        logger.info(f"Connected to Kafka broker(s): {config.kafka_brokers}")
        logger.info("Starting Kafka consumer loop")
        # Start Kafka consumer loop as background task
        kafka_listener_task = asyncio.create_task(factory_kafka_listener.start())
    
    # Setup callbacks
    setup_callbacks()
    
    # Start background tasks
    monitoring_task = asyncio.create_task(monitoring_loop())
    
    logger.info("MMS started successfully")
    
    yield
    
    # Shutdown
    logger.info("Shutting down MMS...")
    shutdown_event.set()
    
    factory_kafka_listener.stop()
    heartbeat_monitor.stop_monitoring()
    mongodb_client.close()
    pms_client.close()
    
    # Cancel background tasks
    monitoring_task.cancel()
    
    try:
        await kafka_listener_task
    except (asyncio.CancelledError, UnboundLocalError):
        pass
    
    try:
        await monitoring_task
    except asyncio.CancelledError:
        pass
    
    logger.info("MMS shutdown complete")


# Create FastAPI app
app = FastAPI(
    title="Monitoring & Maintenance System (MMS)",
    description="Factory monitoring, fault detection, and failover management",
    version="1.0.0",
    lifespan=lifespan
)

# Add CORS middleware to allow dashboard access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8080", "http://localhost:3000"],  # Dashboard and other services
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
        "version": "1.0.0",
        "endpoints": {
            "health": "/health",
            "factories": "/factories"
        }
    }


@app.get("/factories")
async def get_factories():
    """Get all factory statuses"""
    statuses = factory_status_manager.get_all_statuses()
    return {
        "factories": [
            {
                "factory_id": fid,
                "status": status.value
            }
            for fid, status in statuses.items()
        ]
    }


@app.get("/factories/{factory_id}")
async def get_factory(factory_id: str):
    """Get factory status details"""
    status_sm = factory_status_manager.get(factory_id)
    if not status_sm:
        return {"error": "Factory not found"}
    
    risk = risk_predictor.predict_factory_risk(factory_id)
    mongo_status = mongodb_client.get_factory_status(factory_id)
    
    return {
        "factory_id": factory_id,
        "status": status_sm.current_status.value,
        "risk_level": risk.risk_level.value,
        "risk_factors": risk.factors,
        "missed_heartbeats": mongo_status.get("missed_heartbeats", 0) if mongo_status else 0,
        "last_updated": mongo_status.get("last_updated").isoformat() if mongo_status and mongo_status.get("last_updated") else None
    }


@app.get("/factories/{factory_id}/sensors")
async def get_factory_sensors(factory_id: str):
    """Get sensor health status for a factory"""
    sensor_summary = sensor_health_monitor.get_factory_sensor_summary(factory_id)
    return {
        "success": True,
        "data": sensor_summary
    }


@app.get("/sensors/{sensor_id}")
async def get_sensor(sensor_id: str):
    """Get specific sensor status"""
    sensor_status = sensor_health_monitor.get_sensor_status(sensor_id)
    if not sensor_status:
        return {"success": False, "error": "Sensor not found"}
    
    return {
        "success": True,
        "data": sensor_status
    }


@app.post("/factories/{factory_id}/sensors/fix-failed")
async def fix_failed_sensors(factory_id: str):
    """Fix all failed sensors for a factory (simulate recovery)"""
    try:
        failed_sensors = sensor_health_monitor.get_failed_sensors(factory_id)
        if not failed_sensors:
            return {
                "success": True,
                "message": "No failed sensors to fix",
                "recovered_count": 0
            }
        
        recovered_sensor_ids = [s.sensor_id for s in failed_sensors]
        recovered_count = sensor_health_monitor.recover_factory_sensors(factory_id, recovered_sensor_ids)
        
        logger.info(f"Fixed {recovered_count} failed sensors for factory {factory_id}")
        
        return {
            "success": True,
            "message": f"Fixed {recovered_count} failed sensors",
            "recovered_count": recovered_count,
            "recovered_sensors": recovered_sensor_ids
        }
    except Exception as e:
        logger.error(f"Failed to fix sensors for factory {factory_id}: {e}")
        return {
            "success": False,
            "error": str(e)
        }


@app.post("/factories/{factory_id}/sensors/check-at-risk")
async def check_at_risk_sensors(factory_id: str):
    """Get detailed information about at-risk sensors and reset their risk tracking"""
    try:
        at_risk_sensors = []
        sensors_reset = []
        
        # Get all sensors for this factory
        factory_sensor_ids = sensor_health_monitor._factory_sensors.get(factory_id, set())
        
        for sensor_id in factory_sensor_ids:
            risk_status = risk_predictor.get_sensor_risk_status(sensor_id)
            if risk_status and risk_status['is_at_risk']:
                at_risk_sensors.append(risk_status)
                
                # Reset the risk tracking for this sensor
                if sensor_id in risk_predictor._sensor_risk_tracking:
                    del risk_predictor._sensor_risk_tracking[sensor_id]
                    sensors_reset.append(sensor_id)
        
        logger.info(
            f"Checked and reset at-risk sensors for factory {factory_id}: "
            f"found {len(at_risk_sensors)} sensors, reset {len(sensors_reset)} sensors"
        )
        
        return {
            "success": True,
            "factory_id": factory_id,
            "at_risk_count": len(at_risk_sensors),
            "at_risk_sensors": at_risk_sensors,
            "sensors_reset": sensors_reset
        }
    except Exception as e:
        logger.error(f"Failed to check/reset at-risk sensors for factory {factory_id}: {e}")
        return {
            "success": False,
            "error": str(e)
        }


@app.post("/system/reset")
async def reset_system():
    """Reset all sensor health and risk data"""
    try:
        # Clear all sensor health data
        sensor_health_monitor._sensors.clear()
        sensor_health_monitor._factory_sensors.clear()
        sensor_health_monitor._failed_sensors.clear()
        
        # Clear all risk predictor data
        risk_predictor._sensor_risk_tracking.clear()
        risk_predictor._risk_history.clear()
        
        logger.info("MMS system reset completed - all sensor and risk data cleared")
        
        return {
            "success": True,
            "message": "MMS system reset successfully"
        }
    except Exception as e:
        logger.error(f"Failed to reset MMS system: {e}")
        return {
            "success": False,
            "error": str(e)
        }


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
