"""
MongoDB database connection and operations
Sensor-based monitoring storage
"""
import logging
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any
from pymongo import MongoClient, DESCENDING
from pymongo.errors import ConnectionFailure, ServerSelectionTimeoutError

from ..config import config

logger = logging.getLogger(__name__)


class MongoDBClient:
    """MongoDB client for MMS - Sensor monitoring"""
    
    def __init__(self):
        self._client: Optional[MongoClient] = None
        self._db = None
        
    def connect(self) -> bool:
        """Establish connection to MongoDB"""
        try:
            self._client = MongoClient(
                config.mongodb_uri,
                serverSelectionTimeoutMS=5000
            )
            # Test connection
            self._client.admin.command('ping')
            self._db = self._client[config.mongodb_database]
            logger.info("Connected to MongoDB")
            self._ensure_indexes()
            return True
        except (ConnectionFailure, ServerSelectionTimeoutError) as e:
            logger.error(f"Failed to connect to MongoDB: {e}")
            return False
    
    def _ensure_indexes(self):
        """Create indexes for better query performance"""
        # Sensor readings collection indexes
        self._db.sensor_readings.create_index([("sensor_id", 1), ("timestamp", DESCENDING)])
        self._db.sensor_readings.create_index([("factory_id", 1), ("timestamp", DESCENDING)])
        self._db.sensor_readings.create_index([("factory_id", 1), ("type", 1)])
        self._db.sensor_readings.create_index([("timestamp", DESCENDING)])
        
        # Factory health collection indexes
        self._db.factory_health.create_index([("factory_id", 1)], unique=True)
        
        # Sensor status collection indexes
        self._db.sensor_status.create_index([("sensor_id", 1)], unique=True)
        self._db.sensor_status.create_index([("factory_id", 1)])
        
        # Failover events collection indexes
        self._db.failover_events.create_index([("factory_id", 1), ("timestamp", DESCENDING)])
        
        logger.info("MongoDB indexes ensured")
    
    def health_check(self) -> bool:
        """Check MongoDB health"""
        try:
            self._client.admin.command('ping')
            return True
        except Exception as e:
            logger.error(f"MongoDB health check failed: {e}")
            return False
    
    def close(self):
        """Close MongoDB connection"""
        if self._client:
            self._client.close()
            logger.info("MongoDB connection closed")
    
    # Sensor reading operations
    def record_sensor_reading(
        self, 
        sensor_id: str, 
        factory_id: str, 
        sensor_type: str,
        value: float,
        status: str,
        timestamp: datetime,
        extra_data: Dict[str, Any] = None
    ) -> bool:
        """Record a sensor reading"""
        try:
            doc = {
                "sensor_id": sensor_id,
                "factory_id": factory_id,
                "type": sensor_type,
                "value": value,
                "status": status,
                "timestamp": timestamp,
                "recorded_at": datetime.utcnow()
            }
            if extra_data:
                doc.update(extra_data)
            
            self._db.sensor_readings.insert_one(doc)
            
            # Also update sensor status
            self._update_sensor_status(sensor_id, factory_id, sensor_type, status, timestamp)
            
            return True
        except Exception as e:
            logger.error(f"Failed to record sensor reading: {e}")
            return False
    
    def _update_sensor_status(
        self,
        sensor_id: str,
        factory_id: str,
        sensor_type: str,
        status: str,
        timestamp: datetime
    ):
        """Update current sensor status"""
        self._db.sensor_status.update_one(
            {"sensor_id": sensor_id},
            {
                "$set": {
                    "factory_id": factory_id,
                    "type": sensor_type,
                    "status": status,
                    "last_reading": timestamp,
                    "last_updated": datetime.utcnow()
                }
            },
            upsert=True
        )
    
    def get_latest_sensor_reading(self, sensor_id: str) -> Optional[Dict]:
        """Get the most recent reading for a sensor"""
        return self._db.sensor_readings.find_one(
            {"sensor_id": sensor_id},
            sort=[("timestamp", DESCENDING)]
        )
    
    def get_sensor_readings_in_window(self, sensor_id: str, window_seconds: int) -> List[Dict]:
        """Get sensor readings within a time window"""
        since = datetime.utcnow() - timedelta(seconds=window_seconds)
        return list(self._db.sensor_readings.find({
            "sensor_id": sensor_id,
            "timestamp": {"$gte": since}
        }).sort("timestamp", DESCENDING))
    
    def get_factory_sensor_readings(self, factory_id: str, limit: int = 100) -> List[Dict]:
        """Get recent sensor readings for a factory"""
        return list(self._db.sensor_readings.find(
            {"factory_id": factory_id}
        ).sort("timestamp", DESCENDING).limit(limit))
    
    def get_factory_sensors(self, factory_id: str) -> List[Dict]:
        """Get all sensors and their current status for a factory"""
        return list(self._db.sensor_status.find({"factory_id": factory_id}))
    
    def get_sensor_status(self, sensor_id: str) -> Optional[Dict]:
        """Get current sensor status"""
        return self._db.sensor_status.find_one({"sensor_id": sensor_id})
    
    # Factory health operations
    def update_factory_health(
        self,
        factory_id: str,
        health_percentage: float,
        status: str,
        ok_count: int,
        warning_count: int,
        failed_count: int,
        total_count: int
    ) -> bool:
        """Update factory health status"""
        try:
            self._db.factory_health.update_one(
                {"factory_id": factory_id},
                {
                    "$set": {
                        "health_percentage": health_percentage,
                        "status": status,
                        "sensors_ok": ok_count,
                        "sensors_warning": warning_count,
                        "sensors_failed": failed_count,
                        "sensors_total": total_count,
                        "last_updated": datetime.utcnow()
                    }
                },
                upsert=True
            )
            return True
        except Exception as e:
            logger.error(f"Failed to update factory health: {e}")
            return False
    
    def get_factory_health(self, factory_id: str) -> Optional[Dict]:
        """Get current factory health"""
        return self._db.factory_health.find_one({"factory_id": factory_id})
    
    def get_all_factory_health(self) -> List[Dict]:
        """Get health for all factories"""
        return list(self._db.factory_health.find())
    
    # Legacy methods kept for compatibility (mapped to new structure)
    def update_factory_status(self, factory_id: str, status: str, risk_level: str = "LOW") -> bool:
        """Update factory status (legacy compatibility)"""
        return self.update_factory_health(
            factory_id=factory_id,
            health_percentage=100 if status == "UP" else (50 if status == "DEGRADED" else 0),
            status=status,
            ok_count=20 if status == "UP" else (10 if status == "DEGRADED" else 0),
            warning_count=0,
            failed_count=0 if status == "UP" else (10 if status == "DEGRADED" else 20),
            total_count=20
        )
    
    def get_factory_status(self, factory_id: str) -> Optional[Dict]:
        """Get factory status (legacy compatibility)"""
        return self.get_factory_health(factory_id)
    
    # Failover event operations
    def log_failover_event(self, factory_id: str, reason: str, target_factory: Optional[str] = None) -> bool:
        """Log a failover event"""
        try:
            self._db.failover_events.insert_one({
                "factory_id": factory_id,
                "timestamp": datetime.utcnow(),
                "reason": reason,
                "target_factory": target_factory
            })
            return True
        except Exception as e:
            logger.error(f"Failed to log failover event: {e}")
            return False
    
    def get_failover_events(self, factory_id: str, limit: int = 10) -> List[Dict]:
        """Get recent failover events for a factory"""
        return list(self._db.failover_events.find(
            {"factory_id": factory_id}
        ).sort("timestamp", DESCENDING).limit(limit))


# Global instance
mongodb_client = MongoDBClient()
