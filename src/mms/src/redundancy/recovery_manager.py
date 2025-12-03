"""
Recovery Manager
Handles factory recovery detection and rebalancing
"""
import logging
import asyncio
from datetime import datetime
from typing import Optional, List, Callable

from ..config import config
from ..db.mongodb import mongodb_client
from ..grpc.pms_client import pms_client
from ..monitoring.factory_status import factory_status_manager, FactoryStatus

logger = logging.getLogger(__name__)


class RecoveryManager:
    """
    Manages factory recovery detection and rebalancing.
    
    Responsibilities:
    - Detect when a factory has recovered
    - Notify PMS for potential rebalancing
    - Log recovery events
    """
    
    def __init__(self):
        self._on_recovery_callbacks: List[Callable] = []
        self._recovering_factories: set = set()
    
    def on_recovery(self, callback: Callable):
        """Register callback for recovery events"""
        self._on_recovery_callbacks.append(callback)
    
    async def handle_recovery(self, factory_id: str) -> dict:
        """
        Handle factory recovery.
        
        Called when a factory has had consecutive healthy heartbeats
        after being DOWN or DEGRADED.
        
        Args:
            factory_id: Recovered factory ID
            
        Returns:
            Recovery handling result
        """
        # Prevent duplicate recovery handling
        if factory_id in self._recovering_factories:
            logger.debug(f"Recovery already being handled for {factory_id}")
            return {"success": False, "message": "Recovery already in progress"}
        
        self._recovering_factories.add(factory_id)
        
        try:
            logger.info(f"Handling recovery for {factory_id}")
            
            # Get current status
            status_sm = factory_status_manager.get_or_create(factory_id)
            previous_status = status_sm.current_status
            
            # Update to UP
            status_sm.mark_up(f"Recovered after {config.recovery_consecutive_healthy_count} consecutive healthy heartbeats")
            mongodb_client.update_factory_status(factory_id, FactoryStatus.UP.value)
            mongodb_client.reset_consecutive_healthy(factory_id)
            mongodb_client.reset_missed_heartbeats(factory_id)
            
            # Log recovery event
            mongodb_client.log_failover_event(
                factory_id,
                f"Factory recovered from {previous_status.value}",
                None
            )
            
            # Report to PMS
            result = await pms_client.report_factory_status_with_retry(
                factory_id=factory_id,
                status="UP",
                reason=f"Factory recovered from {previous_status.value}"
            )
            
            # Notify callbacks
            for callback in self._on_recovery_callbacks:
                try:
                    callback(factory_id, previous_status)
                except Exception as e:
                    logger.error(f"Error in recovery callback: {e}")
            
            logger.info(f"Recovery completed for {factory_id}")
            
            return {
                "success": True,
                "factory_id": factory_id,
                "previous_status": previous_status.value,
                "pms_response": result
            }
            
        finally:
            self._recovering_factories.discard(factory_id)
    
    def check_recovery(self, factory_id: str) -> bool:
        """
        Check if a factory has recovered.
        
        A factory is considered recovered if:
        - Current status is DOWN or DEGRADED
        - Has had consecutive healthy heartbeats >= threshold
        
        Args:
            factory_id: Factory to check
            
        Returns:
            True if factory has recovered
        """
        status_sm = factory_status_manager.get(factory_id)
        if not status_sm:
            return False
        
        # Only check if currently DOWN or DEGRADED
        if status_sm.current_status == FactoryStatus.UP:
            return False
        
        # Check consecutive healthy count
        factory_status = mongodb_client.get_factory_status(factory_id)
        if not factory_status:
            return False
        
        consecutive_healthy = factory_status.get("consecutive_healthy", 0)
        
        return consecutive_healthy >= config.recovery_consecutive_healthy_count
    
    async def check_all_recoveries(self):
        """
        Check all factories for potential recoveries.
        """
        all_statuses = factory_status_manager.get_all_statuses()
        
        for factory_id, status in all_statuses.items():
            if status in (FactoryStatus.DOWN, FactoryStatus.DEGRADED):
                if self.check_recovery(factory_id):
                    await self.handle_recovery(factory_id)


# Global instance
recovery_manager = RecoveryManager()
