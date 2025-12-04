"""
Sensor Monitor
Processes sensor readings and tracks sensor health status
"""
import logging
from datetime import datetime, timedelta
from typing import Dict, Any, Optional, Callable, List
from enum import Enum
from dataclasses import dataclass
from ..config import config
from ..db.mongodb import mongodb_client

logger = logging.getLogger(__name__)


class SensorStatus(Enum):
    """Sensor health status"""
    OK = "OK"
    WARNING = "WARNING"
    FAILED = "FAILED"


class FactoryHealthStatus(Enum):
    """Factory health status based on sensor health percentage"""
    OPERATIONAL = "OPERATIONAL"  # >= 80% sensors OK
    DEGRADED = "DEGRADED"        # 50-79% sensors OK
    CRITICAL = "CRITICAL"        # 20-49% sensors OK
    DOWN = "DOWN"                # < 20% sensors OK


@dataclass
class SensorReading:
    """Represents a sensor reading"""
    sensor_id: str
    factory_id: str
    sensor_type: str  # temperature, level, quality
    metric: Optional[str]  # For quality: ph, color, weight
    value: float
    unit: str
    status: SensorStatus
    zone: Optional[str]
    timestamp: datetime


@dataclass
class FactoryHealth:
    """Factory health summary"""
    factory_id: str
    total_sensors: int
    ok_sensors: int
    warning_sensors: int
    failed_sensors: int
    health_percentage: float
    status: FactoryHealthStatus
    last_updated: datetime


class SensorMonitor:
    """
    Monitors sensor readings and calculates factory health.
    
    Responsibilities:
    - Process incoming sensor readings
    - Track sensor status (OK, WARNING, FAILED)
    - Calculate factory health based on sensor status percentage
    - Detect sensor timeouts (no reading = FAILED)
    """
    
    def __init__(self):
        # Track last reading time per sensor
        self._last_reading_times: Dict[str, datetime] = {}
        # Track current sensor status
        self._sensor_statuses: Dict[str, SensorStatus] = {}
        # Track sensors per factory
        self._factory_sensors: Dict[str, set] = {}
        # Track manually failed sensors with recovery time
        self._manual_failures: Dict[str, datetime] = {}  # sensor_id -> recovery_time
        # Callbacks
        self._on_sensor_failed_callbacks: List[Callable] = []
        self._on_factory_status_change_callbacks: List[Callable] = []
        # Previous factory statuses for change detection
        self._previous_factory_statuses: Dict[str, FactoryHealthStatus] = {}
    
    def on_sensor_failed(self, callback: Callable):
        """Register callback for sensor failure"""
        self._on_sensor_failed_callbacks.append(callback)
    
    def on_factory_status_change(self, callback: Callable):
        """Register callback for factory status change"""
        self._on_factory_status_change_callbacks.append(callback)
    
    def process_sensor_reading(self, reading_data: Dict[str, Any]):
        """
        Process a sensor reading from Kafka.
        
        Args:
            reading_data: Sensor reading dictionary from Kafka
        """
        try:
            sensor_id = reading_data.get("sensor_id")
            factory_id = reading_data.get("factory_id")
            sensor_type = reading_data.get("type")
            value = reading_data.get("value")
            status_str = reading_data.get("status", "OK")
            timestamp_str = reading_data.get("timestamp")
            
            if not sensor_id or not factory_id:
                logger.warning("Received sensor reading without sensor_id or factory_id")
                return
            
            # Parse timestamp
            if timestamp_str:
                try:
                    timestamp = datetime.fromisoformat(timestamp_str.replace('Z', '+00:00'))
                except ValueError:
                    timestamp = datetime.utcnow()
            else:
                timestamp = datetime.utcnow()
            
            # Determine sensor status
            status = SensorStatus(status_str) if status_str in [s.value for s in SensorStatus] else SensorStatus.OK
            
            # Track sensor for factory
            if factory_id not in self._factory_sensors:
                self._factory_sensors[factory_id] = set()
            self._factory_sensors[factory_id].add(sensor_id)
            
            # Check if this sensor is manually failed and shouldn't recover yet
            now = datetime.utcnow()
            if sensor_id in self._manual_failures:
                recovery_time = self._manual_failures[sensor_id]
                if now < recovery_time:
                    # Check if this is a manual WARNING or FAILED
                    current_status = self._sensor_statuses.get(sensor_id)
                    # Override status to keep it at the last set status (FAILED or WARNING)
                    status = current_status if current_status else SensorStatus.FAILED
                    logger.debug(f"Sensor {sensor_id} kept {status.value} (manual trigger, recovers at {recovery_time})")
                else:
                    # Recovery time passed, remove from manual failures
                    del self._manual_failures[sensor_id]
                    logger.info(f"Sensor {sensor_id} manual status expired, allowing recovery")
            
            # Update tracking
            previous_status = self._sensor_statuses.get(sensor_id)
            self._last_reading_times[sensor_id] = datetime.utcnow()
            self._sensor_statuses[sensor_id] = status
            
            # Record in MongoDB
            mongodb_client.record_sensor_reading(
                sensor_id=sensor_id,
                factory_id=factory_id,
                sensor_type=sensor_type,
                value=value,
                status=status.value,
                timestamp=timestamp,
                extra_data={
                    "unit": reading_data.get("unit"),
                    "zone": reading_data.get("zone"),
                    "metric": reading_data.get("metric")
                }
            )
            
            # Check for status change to FAILED
            if status == SensorStatus.FAILED and previous_status != SensorStatus.FAILED:
                self._notify_sensor_failed(sensor_id, factory_id, "Sensor reported FAILED status")
            
            # Update factory health
            self._update_factory_health(factory_id)
            
            logger.debug(f"Processed sensor reading: {sensor_id} = {value} ({status.value})")
            
        except Exception as e:
            logger.error(f"Error processing sensor reading: {e}")
    
    def check_sensor_timeouts(self):
        """
        Check for sensors that haven't sent readings within timeout period.
        Should be called periodically.
        """
        now = datetime.utcnow()
        timeout_threshold = timedelta(seconds=config.sensor_timeout_seconds)
        
        factories_to_update = set()
        
        for sensor_id, last_reading in list(self._last_reading_times.items()):
            time_since_reading = now - last_reading
            
            if time_since_reading > timeout_threshold:
                previous_status = self._sensor_statuses.get(sensor_id)
                
                if previous_status != SensorStatus.FAILED:
                    self._sensor_statuses[sensor_id] = SensorStatus.FAILED
                    
                    # Find factory for this sensor
                    factory_id = self._get_factory_for_sensor(sensor_id)
                    if factory_id:
                        factories_to_update.add(factory_id)
                        self._notify_sensor_failed(
                            sensor_id, 
                            factory_id, 
                            f"No reading for {time_since_reading.total_seconds():.1f}s"
                        )
                    
                    logger.warning(f"Sensor timeout: {sensor_id} ({time_since_reading.total_seconds():.1f}s)")
        
        # Update factory health for affected factories
        for factory_id in factories_to_update:
            self._update_factory_health(factory_id)
    
    def _get_factory_for_sensor(self, sensor_id: str) -> Optional[str]:
        """Get factory ID for a sensor"""
        for factory_id, sensors in self._factory_sensors.items():
            if sensor_id in sensors:
                return factory_id
        # Try to extract from sensor_id (e.g., factory-1-temp-1)
        parts = sensor_id.split('-')
        if len(parts) >= 2:
            return f"{parts[0]}-{parts[1]}"
        return None
    
    def _notify_sensor_failed(self, sensor_id: str, factory_id: str, reason: str):
        """Notify callbacks of sensor failure"""
        for callback in self._on_sensor_failed_callbacks:
            try:
                callback(sensor_id, factory_id, reason)
            except Exception as e:
                logger.error(f"Error in sensor failure callback: {e}")
    
    def _update_factory_health(self, factory_id: str):
        """Update factory health based on current sensor statuses"""
        health = self.get_factory_health(factory_id)
        
        if health:
            # Check for status change
            previous_status = self._previous_factory_statuses.get(factory_id)
            
            if previous_status != health.status:
                self._previous_factory_statuses[factory_id] = health.status
                
                # Update MongoDB
                mongodb_client.update_factory_health(
                    factory_id=factory_id,
                    health_percentage=health.health_percentage,
                    status=health.status.value,
                    ok_count=health.ok_sensors,
                    warning_count=health.warning_sensors,
                    failed_count=health.failed_sensors,
                    total_count=health.total_sensors
                )
                
                # Notify callbacks
                for callback in self._on_factory_status_change_callbacks:
                    try:
                        callback(factory_id, previous_status, health.status, health.health_percentage)
                    except Exception as e:
                        logger.error(f"Error in factory status change callback: {e}")
                
                logger.info(
                    f"Factory {factory_id} health changed: "
                    f"{previous_status.value if previous_status else 'NEW'} -> {health.status.value} "
                    f"({health.health_percentage:.0f}%)"
                )
    
    def get_factory_health(self, factory_id: str) -> Optional[FactoryHealth]:
        """Calculate factory health based on sensor statuses"""
        sensors = self._factory_sensors.get(factory_id, set())
        
        if not sensors:
            return None
        
        ok_count = 0
        warning_count = 0
        failed_count = 0
        
        for sensor_id in sensors:
            status = self._sensor_statuses.get(sensor_id, SensorStatus.OK)
            if status == SensorStatus.OK:
                ok_count += 1
            elif status == SensorStatus.WARNING:
                warning_count += 1
            else:
                failed_count += 1
        
        total = len(sensors)
        health_percentage = (ok_count / total) * 100 if total > 0 else 0
        
        # Determine factory status based on percentage
        if health_percentage >= config.factory_health_operational:
            status = FactoryHealthStatus.OPERATIONAL
        elif health_percentage >= config.factory_health_degraded:
            status = FactoryHealthStatus.DEGRADED
        elif health_percentage >= config.factory_health_critical:
            status = FactoryHealthStatus.CRITICAL
        else:
            status = FactoryHealthStatus.DOWN
        
        return FactoryHealth(
            factory_id=factory_id,
            total_sensors=total,
            ok_sensors=ok_count,
            warning_sensors=warning_count,
            failed_sensors=failed_count,
            health_percentage=health_percentage,
            status=status,
            last_updated=datetime.utcnow()
        )
    
    def get_all_factory_health(self) -> Dict[str, FactoryHealth]:
        """Get health for all tracked factories"""
        result = {}
        for factory_id in self._factory_sensors.keys():
            health = self.get_factory_health(factory_id)
            if health:
                result[factory_id] = health
        return result
    
    def get_sensor_status(self, sensor_id: str) -> SensorStatus:
        """Get current status of a sensor"""
        return self._sensor_statuses.get(sensor_id, SensorStatus.OK)
    
    def get_factory_sensors(self, factory_id: str) -> Dict[str, SensorStatus]:
        """Get all sensors and their statuses for a factory"""
        sensors = self._factory_sensors.get(factory_id, set())
        return {
            sensor_id: self._sensor_statuses.get(sensor_id, SensorStatus.OK)
            for sensor_id in sensors
        }
    
    def update_sensor_status(self, factory_id: str, sensor_id: str, new_status: SensorStatus, duration_seconds: int = 30):
        """
        Manually update sensor status (for triggering failures via API).
        
        Args:
            factory_id: The factory ID
            sensor_id: The sensor ID to update
            new_status: The new status to set
            duration_seconds: How long the manual status should persist (default 30 seconds)
        """
        previous_status = self._sensor_statuses.get(sensor_id)
        self._sensor_statuses[sensor_id] = new_status
        
        recovery_time = datetime.utcnow() + timedelta(seconds=duration_seconds)
        
        # If setting to FAILED, prevent recovery for duration_seconds
        if new_status == SensorStatus.FAILED:
            self._manual_failures[sensor_id] = recovery_time
            logger.info(f"Sensor {sensor_id} manually failed, will recover after {duration_seconds}s")
            
            if previous_status != SensorStatus.FAILED:
                self._notify_sensor_failed(sensor_id, factory_id, f"Manual failure trigger ({duration_seconds}s)")
        
        # If setting to WARNING, persist it for duration_seconds
        elif new_status == SensorStatus.WARNING:
            self._manual_failures[sensor_id] = recovery_time
            logger.info(f"Sensor {sensor_id} manually warned, will recover after {duration_seconds}s")
        
        # Recalculate factory health
        self._update_factory_health(factory_id)
        
        logger.info(f"Sensor {sensor_id} status updated: {previous_status} -> {new_status}")


# Global instance
sensor_monitor = SensorMonitor()
