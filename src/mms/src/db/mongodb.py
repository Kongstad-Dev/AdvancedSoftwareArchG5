"""
MongoDB database connection and operations
"""
import logging
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any
from pymongo import MongoClient, DESCENDING
from pymongo.errors import ConnectionFailure, ServerSelectionTimeoutError

from ..config import config

logger = logging.getLogger(__name__)


class MongoDBClient:
    """MongoDB client for MMS"""
    
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
        # Heartbeats collection indexes
        self._db.heartbeats.create_index([("factory_id", 1), ("timestamp", DESCENDING)])
        self._db.heartbeats.create_index([("timestamp", DESCENDING)])
        
        # Factory status collection indexes
        self._db.factory_status.create_index([("factory_id", 1)], unique=True)
        
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
    
    # Heartbeat operations
    def record_heartbeat(self, factory_id: str, timestamp: datetime, metrics: Dict[str, Any]) -> bool:
        """Record a heartbeat from a factory"""
        try:
            self._db.heartbeats.insert_one({
                "factory_id": factory_id,
                "timestamp": timestamp,
                "metrics": metrics,
                "recorded_at": datetime.utcnow()
            })
            return True
        except Exception as e:
            logger.error(f"Failed to record heartbeat: {e}")
            return False
    
    def get_latest_heartbeat(self, factory_id: str) -> Optional[Dict]:
        """Get the most recent heartbeat for a factory"""
        return self._db.heartbeats.find_one(
            {"factory_id": factory_id},
            sort=[("timestamp", DESCENDING)]
        )
    
    def get_heartbeats_in_window(self, factory_id: str, window_seconds: int) -> List[Dict]:
        """Get heartbeats within a time window"""
        since = datetime.utcnow() - timedelta(seconds=window_seconds)
        return list(self._db.heartbeats.find({
            "factory_id": factory_id,
            "timestamp": {"$gte": since}
        }).sort("timestamp", DESCENDING))
    
    def get_all_latest_heartbeats(self) -> Dict[str, Dict]:
        """Get the latest heartbeat for all factories"""
        pipeline = [
            {"$sort": {"timestamp": -1}},
            {"$group": {
                "_id": "$factory_id",
                "latest": {"$first": "$$ROOT"}
            }}
        ]
        result = {}
        for doc in self._db.heartbeats.aggregate(pipeline):
            result[doc["_id"]] = doc["latest"]
        return result
    
    # Factory status operations
    def update_factory_status(self, factory_id: str, status: str, risk_level: str = "LOW") -> bool:
        """Update factory status"""
        try:
            self._db.factory_status.update_one(
                {"factory_id": factory_id},
                {
                    "$set": {
                        "current_status": status,
                        "risk_level": risk_level,
                        "last_updated": datetime.utcnow()
                    }
                },
                upsert=True
            )
            return True
        except Exception as e:
            logger.error(f"Failed to update factory status: {e}")
            return False
    
    def get_factory_status(self, factory_id: str) -> Optional[Dict]:
        """Get current factory status"""
        return self._db.factory_status.find_one({"factory_id": factory_id})
    
    def get_all_factory_statuses(self) -> List[Dict]:
        """Get all factory statuses"""
        return list(self._db.factory_status.find())
    
    def increment_missed_heartbeats(self, factory_id: str) -> int:
        """Increment missed heartbeat counter and return new count"""
        result = self._db.factory_status.find_one_and_update(
            {"factory_id": factory_id},
            {
                "$inc": {"missed_heartbeats": 1},
                "$set": {"last_updated": datetime.utcnow()}
            },
            upsert=True,
            return_document=True
        )
        return result.get("missed_heartbeats", 1)
    
    def reset_missed_heartbeats(self, factory_id: str):
        """Reset missed heartbeat counter"""
        self._db.factory_status.update_one(
            {"factory_id": factory_id},
            {
                "$set": {
                    "missed_heartbeats": 0,
                    "last_updated": datetime.utcnow()
                }
            },
            upsert=True
        )
    
    def increment_consecutive_healthy(self, factory_id: str) -> int:
        """Increment consecutive healthy heartbeat counter"""
        result = self._db.factory_status.find_one_and_update(
            {"factory_id": factory_id},
            {
                "$inc": {"consecutive_healthy": 1},
                "$set": {"last_updated": datetime.utcnow()}
            },
            upsert=True,
            return_document=True
        )
        return result.get("consecutive_healthy", 1)
    
    def reset_consecutive_healthy(self, factory_id: str):
        """Reset consecutive healthy counter"""
        self._db.factory_status.update_one(
            {"factory_id": factory_id},
            {
                "$set": {
                    "consecutive_healthy": 0,
                    "last_updated": datetime.utcnow()
                }
            },
            upsert=True
        )
    
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
