"""
Sensor Health Monitor
Tracks individual sensor heartbeats, detects failures, and finds healthy replacements
"""
import logging
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Set
from collections import defaultdict

logger = logging.getLogger(__name__)


class SensorHealth:
    """Tracks health status of a single sensor"""
    
    def __init__(self, sensor_id: str, factory_id: str, tier: str):
        self.sensor_id = sensor_id
        self.factory_id = factory_id
        self.tier = tier
        self.last_heartbeat: Optional[datetime] = None
        self.is_healthy = True
        self.failure_reason: Optional[str] = None
        self.failure_timestamp: Optional[datetime] = None


class SensorHealthMonitor:
    """
    Monitors sensor heartbeats and manages sensor health status.
    
    Responsibilities:
    - Track individual sensor heartbeats
    - Detect sensor failures
    - Find healthy replacement sensors from same factory
    - Notify when factory has no healthy sensors
    """
    
    def __init__(self, heartbeat_timeout_seconds: int = 10):
        self._sensors: Dict[str, SensorHealth] = {}  # sensor_id -> SensorHealth
        self._factory_sensors: Dict[str, Set[str]] = defaultdict(set)  # factory_id -> set of sensor_ids
        self._heartbeat_timeout = timedelta(seconds=heartbeat_timeout_seconds)
        self._failed_sensors: Set[str] = set()
        
    def register_sensor(self, sensor_id: str, factory_id: str, tier: str = "unknown"):
        """Register a sensor for monitoring"""
        if sensor_id not in self._sensors:
            self._sensors[sensor_id] = SensorHealth(sensor_id, factory_id, tier)
            self._factory_sensors[factory_id].add(sensor_id)
            logger.info(f"Registered sensor {sensor_id} for factory {factory_id}")
    
    def process_heartbeat(self, sensor_id: str, factory_id: str, tier: str = "unknown", timestamp: Optional[datetime] = None):
        """Process a sensor heartbeat (does NOT auto-recover failed sensors)"""
        if timestamp is None:
            timestamp = datetime.utcnow()
        
        # Register if not already registered
        if sensor_id not in self._sensors:
            self.register_sensor(sensor_id, factory_id, tier)
        
        sensor = self._sensors[sensor_id]
        sensor.last_heartbeat = timestamp
        
        # Note: Failed sensors are NOT automatically recovered on heartbeat
        # They only recover when factory explicitly restarts all sensors
        
        logger.debug(f"Heartbeat from sensor {sensor_id} at {timestamp}")
    
    def mark_sensor_failed(self, sensor_id: str, reason: str):
        """Mark a sensor as failed"""
        if sensor_id not in self._sensors:
            logger.warning(f"Attempted to mark unknown sensor as failed: {sensor_id}")
            return
        
        sensor = self._sensors[sensor_id]
        if sensor.is_healthy:
            sensor.is_healthy = False
            sensor.failure_reason = reason
            sensor.failure_timestamp = datetime.utcnow()
            self._failed_sensors.add(sensor_id)
            
            logger.warning(f"Sensor {sensor_id} marked as FAILED: {reason}")
    
    def check_timeouts(self) -> List[str]:
        """
        Check for sensors that haven't sent heartbeats within timeout period.
        Returns list of timed-out sensor IDs.
        """
        now = datetime.utcnow()
        timed_out = []
        
        for sensor_id, sensor in self._sensors.items():
            if sensor.last_heartbeat is None:
                continue  # Never sent heartbeat yet
            
            if sensor.is_healthy:
                time_since_heartbeat = now - sensor.last_heartbeat
                if time_since_heartbeat > self._heartbeat_timeout:
                    self.mark_sensor_failed(sensor_id, f"Heartbeat timeout ({time_since_heartbeat.total_seconds():.1f}s)")
                    timed_out.append(sensor_id)
        
        return timed_out
    
    def get_healthy_sensors(self, factory_id: str) -> List[SensorHealth]:
        """Get all healthy sensors for a factory"""
        sensor_ids = self._factory_sensors.get(factory_id, set())
        healthy = []
        
        for sensor_id in sensor_ids:
            sensor = self._sensors.get(sensor_id)
            if sensor and sensor.is_healthy:
                healthy.append(sensor)
        
        return healthy
    
    def get_failed_sensors(self, factory_id: str) -> List[SensorHealth]:
        """Get all failed sensors for a factory"""
        sensor_ids = self._factory_sensors.get(factory_id, set())
        failed = []
        
        for sensor_id in sensor_ids:
            sensor = self._sensors.get(sensor_id)
            if sensor and not sensor.is_healthy:
                failed.append(sensor)
        
        return failed
    
    def find_replacement_sensor(self, factory_id: str, failed_sensor_id: str) -> Optional[str]:
        """
        Find a healthy replacement sensor from the same factory.
        Returns sensor_id of healthy replacement, or None if no healthy sensors available.
        """
        healthy_sensors = self.get_healthy_sensors(factory_id)
        
        # Filter out the failed sensor itself
        healthy_sensors = [s for s in healthy_sensors if s.sensor_id != failed_sensor_id]
        
        if not healthy_sensors:
            logger.warning(f"No healthy replacement sensors available in factory {factory_id}")
            return None
        
        # Return first healthy sensor (could implement more sophisticated selection)
        replacement = healthy_sensors[0]
        logger.info(f"Found replacement sensor {replacement.sensor_id} for failed sensor {failed_sensor_id}")
        return replacement.sensor_id
    
    def has_healthy_sensors(self, factory_id: str) -> bool:
        """Check if factory has any healthy sensors"""
        return len(self.get_healthy_sensors(factory_id)) > 0
    
    def get_sensor_status(self, sensor_id: str) -> Optional[Dict]:
        """Get status of a specific sensor"""
        sensor = self._sensors.get(sensor_id)
        if not sensor:
            return None
        
        return {
            'sensor_id': sensor.sensor_id,
            'factory_id': sensor.factory_id,
            'tier': sensor.tier,
            'is_healthy': sensor.is_healthy,
            'last_heartbeat': sensor.last_heartbeat.isoformat() if sensor.last_heartbeat else None,
            'failure_reason': sensor.failure_reason,
            'failure_timestamp': sensor.failure_timestamp.isoformat() if sensor.failure_timestamp else None
        }
    
    def get_factory_sensor_summary(self, factory_id: str, include_risk_data: bool = True) -> dict:
        """Get summary of all sensors in a factory with optional risk data"""
        healthy = self.get_healthy_sensors(factory_id)
        failed = self.get_failed_sensors(factory_id)
        
        result = {
            "factory_id": factory_id,
            "total_sensors": len(self._factory_sensors.get(factory_id, set())),
            "healthy_count": len(healthy),
            "failed_count": len(failed),
            "healthy_sensors": [s.sensor_id for s in healthy],
            "failed_sensors": [
                {
                    "sensor_id": s.sensor_id,
                    "reason": s.failure_reason,
                    "failed_at": s.failure_timestamp.isoformat() if s.failure_timestamp else None
                }
                for s in failed
            ]
        }
        
        # Add risk data if requested
        if include_risk_data:
            # Import here to avoid circular dependency
            from ..predictive.risk_predictor import risk_predictor
            
            at_risk_sensors = []
            for sensor_id in self._factory_sensors.get(factory_id, set()):
                risk_status = risk_predictor.get_sensor_risk_status(sensor_id)
                if risk_status and risk_status['is_at_risk']:
                    at_risk_sensors.append(risk_status)
            
            result["at_risk_count"] = len(at_risk_sensors)
            result["at_risk_sensors"] = at_risk_sensors
        
        return result
    
    def recover_factory_sensors(self, factory_id: str, recovered_sensors: List[str]):
        """
        Recover all sensors in a factory after restart.
        Called when factory restarts and brings all sensors back online.
        """
        recovered_count = 0
        
        for sensor_id in recovered_sensors:
            if sensor_id in self._sensors:
                sensor = self._sensors[sensor_id]
                if not sensor.is_healthy:
                    sensor.is_healthy = True
                    sensor.failure_reason = None
                    sensor.failure_timestamp = None
                    self._failed_sensors.discard(sensor_id)
                    recovered_count += 1
                    logger.info(f"Sensor {sensor_id} recovered after factory restart")
        
        logger.info(f"Factory {factory_id} restart: recovered {recovered_count} sensors")
        return recovered_count


# Global instance
sensor_health_monitor = SensorHealthMonitor()
