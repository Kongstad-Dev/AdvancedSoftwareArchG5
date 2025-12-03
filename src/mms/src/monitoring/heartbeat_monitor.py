"""
Heartbeat Monitor
Processes heartbeats from factories and detects timeouts
"""
import logging
import json
import asyncio
from datetime import datetime, timedelta
from typing import Dict, Any, Optional, Callable
from ..config import config
from ..db.mongodb import mongodb_client
from .factory_status import factory_status_manager, FactoryStatus

logger = logging.getLogger(__name__)


class HeartbeatMonitor:
    """
    Monitors factory heartbeats and detects anomalies.
    
    Responsibilities:
    - Process incoming heartbeats
    - Record heartbeats in MongoDB
    - Check for timeouts
    - Update factory status
    """
    
    def __init__(self):
        self._last_heartbeat_times: Dict[str, datetime] = {}
        self._on_timeout_callbacks: list[Callable] = []
        self._on_recovery_callbacks: list[Callable] = []
        self._running = False
        self._check_task: Optional[asyncio.Task] = None
    
    def on_timeout(self, callback: Callable):
        """Register callback for heartbeat timeout"""
        self._on_timeout_callbacks.append(callback)
    
    def on_recovery(self, callback: Callable):
        """Register callback for factory recovery"""
        self._on_recovery_callbacks.append(callback)
    
    def process_heartbeat(self, factory_id: str, timestamp: datetime, metrics: Dict[str, Any]):
        """
        Process a heartbeat from a factory.
        
        Args:
            factory_id: Factory identifier
            timestamp: Heartbeat timestamp
            metrics: Heartbeat metrics (cpu, memory, errors, etc.)
        """
        logger.debug(f"Processing heartbeat from {factory_id}")
        
        # Record heartbeat in MongoDB
        mongodb_client.record_heartbeat(factory_id, timestamp, metrics)
        
        # Update last heartbeat time
        self._last_heartbeat_times[factory_id] = datetime.utcnow()
        
        # Reset missed heartbeat counter
        mongodb_client.reset_missed_heartbeats(factory_id)
        
        # Get or create status state machine
        status_sm = factory_status_manager.get_or_create(factory_id)
        
        # Check if factory was DOWN or DEGRADED
        previous_status = status_sm.current_status
        
        if previous_status != FactoryStatus.UP:
            # Check for recovery
            consecutive_healthy = mongodb_client.increment_consecutive_healthy(factory_id)
            
            if consecutive_healthy >= config.recovery_consecutive_healthy_count:
                # Factory has recovered
                logger.info(f"Factory {factory_id} has recovered after {consecutive_healthy} healthy heartbeats")
                status_sm.mark_up("Recovered after consecutive healthy heartbeats")
                mongodb_client.update_factory_status(factory_id, FactoryStatus.UP.value)
                mongodb_client.reset_consecutive_healthy(factory_id)
                
                # Notify recovery callbacks
                for callback in self._on_recovery_callbacks:
                    try:
                        callback(factory_id)
                    except Exception as e:
                        logger.error(f"Error in recovery callback: {e}")
        else:
            # Factory is UP, reset consecutive healthy counter
            mongodb_client.reset_consecutive_healthy(factory_id)
        
        # Update status in MongoDB
        mongodb_client.update_factory_status(factory_id, status_sm.current_status.value)
    
    def check_timeouts(self):
        """
        Check for factories that have timed out.
        Should be called periodically.
        """
        now = datetime.utcnow()
        timeout_threshold = timedelta(seconds=config.heartbeat_timeout_seconds)
        
        for factory_id, last_heartbeat in list(self._last_heartbeat_times.items()):
            time_since_heartbeat = now - last_heartbeat
            
            if time_since_heartbeat > timeout_threshold:
                self._handle_timeout(factory_id, time_since_heartbeat.total_seconds())
    
    def _handle_timeout(self, factory_id: str, seconds_since_heartbeat: float):
        """Handle a heartbeat timeout"""
        logger.warning(f"Heartbeat timeout for {factory_id}: {seconds_since_heartbeat:.1f}s since last heartbeat")
        
        # Increment missed heartbeats counter
        missed_count = mongodb_client.increment_missed_heartbeats(factory_id)
        
        # Reset consecutive healthy counter
        mongodb_client.reset_consecutive_healthy(factory_id)
        
        # Get status state machine
        status_sm = factory_status_manager.get_or_create(factory_id)
        
        if missed_count >= config.missed_heartbeats_threshold:
            # Factory is DOWN
            if status_sm.current_status != FactoryStatus.DOWN:
                status_sm.mark_down(f"Missed {missed_count} consecutive heartbeats")
                mongodb_client.update_factory_status(factory_id, FactoryStatus.DOWN.value)
                
                # Notify timeout callbacks
                for callback in self._on_timeout_callbacks:
                    try:
                        callback(factory_id, "missed_heartbeats", missed_count)
                    except Exception as e:
                        logger.error(f"Error in timeout callback: {e}")
        else:
            # Factory is DEGRADED
            if status_sm.current_status == FactoryStatus.UP:
                status_sm.mark_degraded(f"Missed {missed_count} heartbeat(s)")
                mongodb_client.update_factory_status(factory_id, FactoryStatus.DEGRADED.value)
    
    def get_factory_status(self, factory_id: str) -> FactoryStatus:
        """Get current status of a factory"""
        status_sm = factory_status_manager.get(factory_id)
        if status_sm:
            return status_sm.current_status
        return FactoryStatus.UP  # Default to UP if not tracked
    
    def get_all_factory_statuses(self) -> Dict[str, FactoryStatus]:
        """Get status of all tracked factories"""
        return factory_status_manager.get_all_statuses()
    
    async def start_monitoring(self, check_interval: float = 1.0):
        """Start the periodic timeout check loop"""
        self._running = True
        logger.info(f"Starting heartbeat monitoring (check interval: {check_interval}s)")
        
        while self._running:
            try:
                self.check_timeouts()
            except Exception as e:
                logger.error(f"Error during timeout check: {e}")
            await asyncio.sleep(check_interval)
    
    def stop_monitoring(self):
        """Stop the monitoring loop"""
        self._running = False
        if self._check_task:
            self._check_task.cancel()
        logger.info("Heartbeat monitoring stopped")


# Global instance
heartbeat_monitor = HeartbeatMonitor()
