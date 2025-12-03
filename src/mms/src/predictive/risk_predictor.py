"""
Risk Predictor
Simple rule-based predictive model for factory risk assessment
"""
import logging
from datetime import datetime, timedelta
from typing import Dict, Optional, List
from dataclasses import dataclass
from enum import Enum

from ..config import config
from ..db.mongodb import mongodb_client
from ..monitoring.fault_detector import fault_detector
from ..monitoring.factory_status import factory_status_manager, FactoryStatus

logger = logging.getLogger(__name__)


class RiskLevel(Enum):
    """Risk level enumeration"""
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"


@dataclass
class RiskAssessment:
    """Represents a risk assessment for a factory"""
    factory_id: str
    risk_level: RiskLevel
    timestamp: datetime
    factors: Dict[str, float]  # Contributing factors and their weights
    recommendation: str


class RiskPredictor:
    """
    Simple rule-based predictive model for factory risk assessment.
    
    Risk factors:
    - Error rate (last 5 minutes)
    - Latency trends
    - Missed heartbeats history
    - Resource usage trends
    """
    
    def __init__(self):
        self._risk_history: Dict[str, List[RiskAssessment]] = {}
    
    def predict_factory_risk(self, factory_id: str) -> RiskAssessment:
        """
        Predict risk level for a factory based on recent metrics.
        
        Args:
            factory_id: Factory to assess
            
        Returns:
            RiskAssessment with risk level and contributing factors
        """
        factors = {}
        
        # Factor 1: Error rate (weight: 0.3)
        error_rate = self._assess_error_rate(factory_id)
        factors["error_rate"] = error_rate
        
        # Factor 2: Latency trend (weight: 0.2)
        latency_score = self._assess_latency_trend(factory_id)
        factors["latency_trend"] = latency_score
        
        # Factor 3: Heartbeat stability (weight: 0.3)
        heartbeat_score = self._assess_heartbeat_stability(factory_id)
        factors["heartbeat_stability"] = heartbeat_score
        
        # Factor 4: Resource usage (weight: 0.2)
        resource_score = self._assess_resource_usage(factory_id)
        factors["resource_usage"] = resource_score
        
        # Calculate weighted risk score
        weights = {
            "error_rate": 0.3,
            "latency_trend": 0.2,
            "heartbeat_stability": 0.3,
            "resource_usage": 0.2
        }
        
        risk_score = sum(factors[k] * weights[k] for k in weights)
        
        # Determine risk level
        if risk_score >= 0.7:
            risk_level = RiskLevel.HIGH
            recommendation = "Recommend preemptive failover or load balancing"
        elif risk_score >= 0.4:
            risk_level = RiskLevel.MEDIUM
            recommendation = "Monitor closely, prepare for potential failover"
        else:
            risk_level = RiskLevel.LOW
            recommendation = "Factory operating normally"
        
        assessment = RiskAssessment(
            factory_id=factory_id,
            risk_level=risk_level,
            timestamp=datetime.utcnow(),
            factors=factors,
            recommendation=recommendation
        )
        
        # Store in history
        if factory_id not in self._risk_history:
            self._risk_history[factory_id] = []
        self._risk_history[factory_id].append(assessment)
        self._risk_history[factory_id] = self._risk_history[factory_id][-50:]
        
        # Update MongoDB
        mongodb_client.update_factory_status(
            factory_id, 
            factory_status_manager.get_or_create(factory_id).current_status.value,
            risk_level.value
        )
        
        logger.info(f"Risk assessment for {factory_id}: {risk_level.value} (score: {risk_score:.2f})")
        
        return assessment
    
    def _assess_error_rate(self, factory_id: str) -> float:
        """
        Assess error rate risk factor.
        Returns a score from 0.0 to 1.0
        """
        error_rate = fault_detector.calculate_error_rate(factory_id, window_seconds=300)
        
        if error_rate >= config.high_risk_error_rate_threshold:
            return 1.0
        elif error_rate >= config.degraded_error_rate_threshold:
            return 0.6
        elif error_rate > 0:
            return 0.3
        return 0.0
    
    def _assess_latency_trend(self, factory_id: str) -> float:
        """
        Assess latency trend risk factor.
        Returns a score from 0.0 to 1.0
        """
        heartbeats = mongodb_client.get_heartbeats_in_window(factory_id, 300)
        
        if len(heartbeats) < 3:
            return 0.0
        
        latencies = [
            hb.get("metrics", {}).get("latency_ms", 0)
            for hb in heartbeats
            if hb.get("metrics", {}).get("latency_ms")
        ]
        
        if len(latencies) < 3:
            return 0.0
        
        # Check if latency is increasing
        # Compare first half average to second half average
        mid = len(latencies) // 2
        first_half_avg = sum(latencies[mid:]) / len(latencies[mid:])  # Older
        second_half_avg = sum(latencies[:mid]) / len(latencies[:mid])  # Newer
        
        if first_half_avg > 0:
            increase_ratio = (second_half_avg - first_half_avg) / first_half_avg
            
            if increase_ratio > 0.5:  # >50% increase
                return 0.8
            elif increase_ratio > 0.2:  # >20% increase
                return 0.5
            elif increase_ratio > 0:
                return 0.2
        
        # Also check absolute latency
        avg_latency = sum(latencies) / len(latencies)
        if avg_latency > 2000:
            return 0.9
        elif avg_latency > 1000:
            return 0.6
        elif avg_latency > 500:
            return 0.3
        
        return 0.0
    
    def _assess_heartbeat_stability(self, factory_id: str) -> float:
        """
        Assess heartbeat stability risk factor.
        Returns a score from 0.0 to 1.0
        """
        status = mongodb_client.get_factory_status(factory_id)
        if not status:
            return 0.0
        
        missed = status.get("missed_heartbeats", 0)
        
        if missed >= config.missed_heartbeats_threshold:
            return 1.0
        elif missed >= 2:
            return 0.7
        elif missed >= 1:
            return 0.4
        
        # Check current status
        status_sm = factory_status_manager.get(factory_id)
        if status_sm:
            if status_sm.current_status == FactoryStatus.DOWN:
                return 1.0
            elif status_sm.current_status == FactoryStatus.DEGRADED:
                return 0.6
        
        return 0.0
    
    def _assess_resource_usage(self, factory_id: str) -> float:
        """
        Assess resource usage risk factor.
        Returns a score from 0.0 to 1.0
        """
        latest = mongodb_client.get_latest_heartbeat(factory_id)
        if not latest:
            return 0.0
        
        metrics = latest.get("metrics", {})
        cpu_usage = metrics.get("cpu_usage", 0)
        memory_usage = metrics.get("memory_usage", 0)
        
        max_usage = max(cpu_usage, memory_usage)
        
        if max_usage >= 95:
            return 1.0
        elif max_usage >= 85:
            return 0.7
        elif max_usage >= 70:
            return 0.4
        elif max_usage >= 50:
            return 0.2
        
        return 0.0
    
    def should_preemptively_rebalance(self, factory_id: str) -> bool:
        """
        Determine if orders should be preemptively rebalanced from this factory.
        
        Returns True if:
        - Risk is HIGH
        - Other factories have available capacity
        """
        assessment = self.predict_factory_risk(factory_id)
        
        if assessment.risk_level != RiskLevel.HIGH:
            return False
        
        # Check if other factories have capacity
        all_statuses = factory_status_manager.get_all_statuses()
        healthy_factories = [
            fid for fid, status in all_statuses.items()
            if status == FactoryStatus.UP and fid != factory_id
        ]
        
        if not healthy_factories:
            logger.warning(f"No healthy factories available for rebalancing from {factory_id}")
            return False
        
        logger.info(f"Factory {factory_id} should be rebalanced. "
                   f"Available targets: {healthy_factories}")
        return True
    
    def get_risk_history(self, factory_id: str, limit: int = 10) -> List[RiskAssessment]:
        """Get recent risk assessment history for a factory"""
        history = self._risk_history.get(factory_id, [])
        return history[-limit:]
    
    def get_all_factory_risks(self) -> Dict[str, RiskAssessment]:
        """Get current risk assessment for all tracked factories"""
        statuses = factory_status_manager.get_all_statuses()
        risks = {}
        
        for factory_id in statuses:
            risks[factory_id] = self.predict_factory_risk(factory_id)
        
        return risks


# Global instance
risk_predictor = RiskPredictor()
