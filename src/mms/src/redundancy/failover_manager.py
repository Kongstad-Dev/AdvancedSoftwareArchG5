"""
Failover Manager
Orchestrates failover when a factory fails
"""
import logging
import asyncio
from datetime import datetime
from typing import Optional, List, Callable

from ..config import config
from ..db.mongodb import mongodb_client
from ..grpc.pms_client import pms_client
from ..monitoring.factory_status import factory_status_manager, FactoryStatus
from ..predictive.risk_predictor import risk_predictor, RiskLevel

logger = logging.getLogger(__name__)


class FailoverManager:
    """
    Orchestrates failover operations when a factory fails.
    
    Responsibilities:
    - Detect when failover is needed
    - Find suitable backup factories
    - Coordinate with PMS for order rescheduling
    - Log failover events
    """
    
    def __init__(self):
        self._on_failover_callbacks: List[Callable] = []
        self._active_failovers: set = set()
    
    def on_failover(self, callback: Callable):
        """Register callback for failover events"""
        self._on_failover_callbacks.append(callback)
    
    async def trigger_failover(self, factory_id: str, reason: str) -> dict:
        """
        Trigger failover for a factory.
        
        Args:
            factory_id: Failed factory ID
            reason: Reason for failover
            
        Returns:
            Failover result
        """
        # Prevent duplicate failovers
        if factory_id in self._active_failovers:
            logger.warning(f"Failover already in progress for {factory_id}")
            return {"success": False, "message": "Failover already in progress"}
        
        self._active_failovers.add(factory_id)
        
        try:
            logger.info(f"Triggering failover for {factory_id}: {reason}")
            
            # Log failover event in MongoDB
            mongodb_client.log_failover_event(factory_id, reason)
            
            # Find backup factory
            backup_factory = self._find_backup_factory(factory_id)
            
            if backup_factory:
                logger.info(f"Selected backup factory: {backup_factory}")
                mongodb_client.log_failover_event(
                    factory_id, 
                    f"Selected backup: {backup_factory}",
                    backup_factory
                )
            else:
                logger.warning(f"No backup factory available for {factory_id}")
            
            # Report to PMS
            result = await pms_client.report_factory_status_with_retry(
                factory_id=factory_id,
                status="DOWN",
                reason=reason
            )
            
            # Update local status
            status_sm = factory_status_manager.get_or_create(factory_id)
            status_sm.mark_down(reason)
            mongodb_client.update_factory_status(factory_id, FactoryStatus.DOWN.value)
            
            # Notify callbacks
            for callback in self._on_failover_callbacks:
                try:
                    callback(factory_id, reason, backup_factory, result)
                except Exception as e:
                    logger.error(f"Error in failover callback: {e}")
            
            logger.info(f"Failover completed for {factory_id}: {result}")
            
            return {
                "success": result.get("success", False),
                "factory_id": factory_id,
                "backup_factory": backup_factory,
                "orders_rescheduled": result.get("orders_rescheduled", 0),
                "message": result.get("message")
            }
            
        finally:
            self._active_failovers.discard(factory_id)
    
    def _find_backup_factory(self, failed_factory_id: str) -> Optional[str]:
        """
        Find a suitable backup factory.
        
        Selection criteria:
        - Must be UP status
        - Must not be the failed factory
        - Prefer factory with lowest risk level
        """
        all_statuses = factory_status_manager.get_all_statuses()
        
        # Filter for UP factories excluding the failed one
        candidates = [
            fid for fid, status in all_statuses.items()
            if status == FactoryStatus.UP and fid != failed_factory_id
        ]
        
        if not candidates:
            return None
        
        # Rank by risk level
        def get_risk_score(factory_id: str) -> int:
            assessment = risk_predictor.predict_factory_risk(factory_id)
            risk_scores = {
                RiskLevel.LOW: 0,
                RiskLevel.MEDIUM: 1,
                RiskLevel.HIGH: 2
            }
            return risk_scores.get(assessment.risk_level, 1)
        
        # Sort by risk score (lower is better)
        candidates.sort(key=get_risk_score)
        
        return candidates[0] if candidates else None
    
    async def check_and_trigger_failovers(self):
        """
        Check all factories and trigger failovers where needed.
        """
        all_statuses = factory_status_manager.get_all_statuses()
        
        for factory_id, status in all_statuses.items():
            if status == FactoryStatus.DOWN:
                # Check if we need to trigger failover
                factory_status = mongodb_client.get_factory_status(factory_id)
                if factory_status:
                    missed = factory_status.get("missed_heartbeats", 0)
                    if missed >= config.missed_heartbeats_threshold:
                        await self.trigger_failover(
                            factory_id,
                            f"Missed {missed} consecutive heartbeats"
                        )
    
    async def preemptive_rebalance(self, factory_id: str) -> dict:
        """
        Preemptively rebalance orders from a high-risk factory.
        
        Args:
            factory_id: Factory to rebalance from
            
        Returns:
            Rebalance result
        """
        logger.info(f"Initiating preemptive rebalance for {factory_id}")
        
        # Mark factory as degraded
        status_sm = factory_status_manager.get_or_create(factory_id)
        status_sm.mark_degraded("Preemptive rebalance due to high risk")
        
        # Report to PMS
        result = await pms_client.report_factory_status_with_retry(
            factory_id=factory_id,
            status="DEGRADED",
            reason="Preemptive rebalance - high risk detected"
        )
        
        mongodb_client.log_failover_event(
            factory_id,
            "Preemptive rebalance initiated"
        )
        
        return result


# Global instance
failover_manager = FailoverManager()
