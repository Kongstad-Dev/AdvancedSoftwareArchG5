"""
Fault Detector
Analyzes heartbeat patterns to detect faults and anomalies
"""
import logging
from datetime import datetime, timedelta
from typing import Dict, List, Optional
from dataclasses import dataclass
from enum import Enum

from ..config import config
from ..db.mongodb import mongodb_client
from .factory_status import factory_status_manager, FactoryStatus

logger = logging.getLogger(__name__)


class FaultType(Enum):
    """Types of faults that can be detected"""
    HEARTBEAT_TIMEOUT = "heartbeat_timeout"
    HIGH_ERROR_RATE = "high_error_rate"
    HIGH_LATENCY = "high_latency"
    RESOURCE_EXHAUSTION = "resource_exhaustion"


@dataclass
class FaultDetection:
    """Represents a detected fault"""
    factory_id: str
    fault_type: FaultType
    severity: str  # LOW, MEDIUM, HIGH
    timestamp: datetime
    details: Dict


class FaultDetector:
    """
    Analyzes heartbeat patterns to detect faults.
    
    Detection methods:
    - Consecutive missed heartbeats
    - High error rate over time window
    - Latency anomalies
    - Resource usage anomalies
    """
    
    def __init__(self):
        self._fault_history: Dict[str, List[FaultDetection]] = {}
    
    def detect_faults(self, factory_id: str) -> List[FaultDetection]:
        """
        Run all fault detection checks for a factory.
        
        Args:
            factory_id: Factory to check
            
        Returns:
            List of detected faults
        """
        faults = []
        
        # Check for missed heartbeats
        heartbeat_fault = self._check_missed_heartbeats(factory_id)
        if heartbeat_fault:
            faults.append(heartbeat_fault)
        
        # Check error rate
        error_fault = self._check_error_rate(factory_id)
        if error_fault:
            faults.append(error_fault)
        
        # Check latency
        latency_fault = self._check_latency(factory_id)
        if latency_fault:
            faults.append(latency_fault)
        
        # Check resource usage
        resource_fault = self._check_resource_usage(factory_id)
        if resource_fault:
            faults.append(resource_fault)
        
        # Store in history
        if faults:
            if factory_id not in self._fault_history:
                self._fault_history[factory_id] = []
            self._fault_history[factory_id].extend(faults)
            # Keep only last 100 faults per factory
            self._fault_history[factory_id] = self._fault_history[factory_id][-100:]
        
        return faults
    
    def _check_missed_heartbeats(self, factory_id: str) -> Optional[FaultDetection]:
        """Check for missed heartbeats"""
        status = mongodb_client.get_factory_status(factory_id)
        if not status:
            return None
        
        missed = status.get("missed_heartbeats", 0)
        
        if missed >= config.missed_heartbeats_threshold:
            return FaultDetection(
                factory_id=factory_id,
                fault_type=FaultType.HEARTBEAT_TIMEOUT,
                severity="HIGH",
                timestamp=datetime.utcnow(),
                details={"missed_heartbeats": missed}
            )
        elif missed > 0:
            return FaultDetection(
                factory_id=factory_id,
                fault_type=FaultType.HEARTBEAT_TIMEOUT,
                severity="MEDIUM",
                timestamp=datetime.utcnow(),
                details={"missed_heartbeats": missed}
            )
        
        return None
    
    def _check_error_rate(self, factory_id: str, window_seconds: int = 300) -> Optional[FaultDetection]:
        """Check error rate over a time window"""
        error_rate = self.calculate_error_rate(factory_id, window_seconds)
        
        if error_rate >= config.high_risk_error_rate_threshold:
            return FaultDetection(
                factory_id=factory_id,
                fault_type=FaultType.HIGH_ERROR_RATE,
                severity="HIGH",
                timestamp=datetime.utcnow(),
                details={"error_rate": error_rate, "window_seconds": window_seconds}
            )
        elif error_rate >= config.degraded_error_rate_threshold:
            return FaultDetection(
                factory_id=factory_id,
                fault_type=FaultType.HIGH_ERROR_RATE,
                severity="MEDIUM",
                timestamp=datetime.utcnow(),
                details={"error_rate": error_rate, "window_seconds": window_seconds}
            )
        
        return None
    
    def _check_latency(self, factory_id: str, window_seconds: int = 60) -> Optional[FaultDetection]:
        """Check for latency anomalies"""
        heartbeats = mongodb_client.get_heartbeats_in_window(factory_id, window_seconds)
        
        if len(heartbeats) < 2:
            return None
        
        latencies = [
            hb.get("metrics", {}).get("latency_ms", 0) 
            for hb in heartbeats 
            if hb.get("metrics", {}).get("latency_ms")
        ]
        
        if not latencies:
            return None
        
        avg_latency = sum(latencies) / len(latencies)
        max_latency = max(latencies)
        
        # High latency threshold (e.g., > 1000ms average)
        if avg_latency > 1000:
            return FaultDetection(
                factory_id=factory_id,
                fault_type=FaultType.HIGH_LATENCY,
                severity="HIGH" if avg_latency > 2000 else "MEDIUM",
                timestamp=datetime.utcnow(),
                details={
                    "avg_latency_ms": avg_latency,
                    "max_latency_ms": max_latency,
                    "sample_count": len(latencies)
                }
            )
        
        return None
    
    def _check_resource_usage(self, factory_id: str) -> Optional[FaultDetection]:
        """Check for resource exhaustion"""
        latest = mongodb_client.get_latest_heartbeat(factory_id)
        
        if not latest:
            return None
        
        metrics = latest.get("metrics", {})
        cpu_usage = metrics.get("cpu_usage", 0)
        memory_usage = metrics.get("memory_usage", 0)
        
        # Check for high resource usage
        if cpu_usage > 95 or memory_usage > 95:
            return FaultDetection(
                factory_id=factory_id,
                fault_type=FaultType.RESOURCE_EXHAUSTION,
                severity="HIGH",
                timestamp=datetime.utcnow(),
                details={
                    "cpu_usage": cpu_usage,
                    "memory_usage": memory_usage
                }
            )
        elif cpu_usage > 80 or memory_usage > 80:
            return FaultDetection(
                factory_id=factory_id,
                fault_type=FaultType.RESOURCE_EXHAUSTION,
                severity="MEDIUM",
                timestamp=datetime.utcnow(),
                details={
                    "cpu_usage": cpu_usage,
                    "memory_usage": memory_usage
                }
            )
        
        return None
    
    def calculate_error_rate(self, factory_id: str, window_seconds: int = 300) -> float:
        """
        Calculate error rate for a factory over a time window.
        
        Args:
            factory_id: Factory to check
            window_seconds: Time window in seconds
            
        Returns:
            Error rate (0.0 to 1.0)
        """
        heartbeats = mongodb_client.get_heartbeats_in_window(factory_id, window_seconds)
        
        if not heartbeats:
            return 0.0
        
        total_errors = sum(
            hb.get("metrics", {}).get("error_count", 0) 
            for hb in heartbeats
        )
        
        # Error rate = errors per heartbeat
        return total_errors / len(heartbeats) if heartbeats else 0.0
    
    def is_degraded(self, factory_id: str) -> bool:
        """
        Check if factory is in degraded state.
        
        A factory is degraded if:
        - Has intermittent heartbeat failures
        - Error rate is elevated but not critical
        - Has resource usage concerns
        """
        status_sm = factory_status_manager.get(factory_id)
        if status_sm and status_sm.current_status == FactoryStatus.DEGRADED:
            return True
        
        # Check error rate
        error_rate = self.calculate_error_rate(factory_id)
        if config.degraded_error_rate_threshold <= error_rate < config.high_risk_error_rate_threshold:
            return True
        
        # Check missed heartbeats
        status = mongodb_client.get_factory_status(factory_id)
        if status:
            missed = status.get("missed_heartbeats", 0)
            if 0 < missed < config.missed_heartbeats_threshold:
                return True
        
        return False
    
    def get_fault_history(self, factory_id: str, limit: int = 10) -> List[FaultDetection]:
        """Get recent fault history for a factory"""
        history = self._fault_history.get(factory_id, [])
        return history[-limit:]


# Global instance
fault_detector = FaultDetector()
