"""
Factory Status State Machine
Manages transitions between UP, DEGRADED, and DOWN states
"""
import logging
from enum import Enum
from dataclasses import dataclass
from datetime import datetime
from typing import Optional, Callable, List

logger = logging.getLogger(__name__)


class FactoryStatus(Enum):
    """Factory status enumeration"""
    UP = "UP"
    DEGRADED = "DEGRADED"
    DOWN = "DOWN"


@dataclass
class StatusTransition:
    """Represents a status transition"""
    from_status: FactoryStatus
    to_status: FactoryStatus
    timestamp: datetime
    reason: str


class FactoryStatusStateMachine:
    """
    State machine for managing factory status transitions.
    
    Valid transitions:
    - UP -> DEGRADED (intermittent issues)
    - UP -> DOWN (sudden failure)
    - DEGRADED -> UP (recovery)
    - DEGRADED -> DOWN (worsening)
    - DOWN -> DEGRADED (partial recovery)
    - DOWN -> UP (full recovery)
    """
    
    def __init__(self, factory_id: str, initial_status: FactoryStatus = FactoryStatus.UP):
        self.factory_id = factory_id
        self._current_status = initial_status
        self._transition_history: List[StatusTransition] = []
        self._on_transition_callbacks: List[Callable] = []
        
    @property
    def current_status(self) -> FactoryStatus:
        """Get current status"""
        return self._current_status
    
    @property
    def is_up(self) -> bool:
        return self._current_status == FactoryStatus.UP
    
    @property
    def is_degraded(self) -> bool:
        return self._current_status == FactoryStatus.DEGRADED
    
    @property
    def is_down(self) -> bool:
        return self._current_status == FactoryStatus.DOWN
    
    def on_transition(self, callback: Callable):
        """Register a callback for status transitions"""
        self._on_transition_callbacks.append(callback)
    
    def transition_to(self, new_status: FactoryStatus, reason: str) -> bool:
        """
        Attempt to transition to a new status.
        Returns True if transition was successful.
        """
        if new_status == self._current_status:
            logger.debug(f"Factory {self.factory_id} already in status {new_status.value}")
            return False
        
        old_status = self._current_status
        transition = StatusTransition(
            from_status=old_status,
            to_status=new_status,
            timestamp=datetime.utcnow(),
            reason=reason
        )
        
        self._current_status = new_status
        self._transition_history.append(transition)
        
        logger.info(
            f"Factory {self.factory_id} status changed: "
            f"{old_status.value} -> {new_status.value} ({reason})"
        )
        
        # Notify callbacks
        for callback in self._on_transition_callbacks:
            try:
                callback(self.factory_id, old_status, new_status, reason)
            except Exception as e:
                logger.error(f"Error in transition callback: {e}")
        
        return True
    
    def mark_up(self, reason: str = "healthy") -> bool:
        """Mark factory as UP"""
        return self.transition_to(FactoryStatus.UP, reason)
    
    def mark_degraded(self, reason: str = "intermittent issues") -> bool:
        """Mark factory as DEGRADED"""
        return self.transition_to(FactoryStatus.DEGRADED, reason)
    
    def mark_down(self, reason: str = "failure detected") -> bool:
        """Mark factory as DOWN"""
        return self.transition_to(FactoryStatus.DOWN, reason)
    
    def get_transition_history(self, limit: int = 10) -> List[StatusTransition]:
        """Get recent transition history"""
        return self._transition_history[-limit:]


class FactoryStatusManager:
    """
    Manages status state machines for all factories
    """
    
    def __init__(self):
        self._factories: dict[str, FactoryStatusStateMachine] = {}
        self._global_callbacks: List[Callable] = []
    
    def get_or_create(self, factory_id: str) -> FactoryStatusStateMachine:
        """Get or create a state machine for a factory"""
        if factory_id not in self._factories:
            sm = FactoryStatusStateMachine(factory_id)
            # Register global callbacks
            for callback in self._global_callbacks:
                sm.on_transition(callback)
            self._factories[factory_id] = sm
        return self._factories[factory_id]
    
    def get(self, factory_id: str) -> Optional[FactoryStatusStateMachine]:
        """Get state machine for a factory"""
        return self._factories.get(factory_id)
    
    def on_any_transition(self, callback: Callable):
        """Register a callback for any factory status transition"""
        self._global_callbacks.append(callback)
        # Add to existing factories
        for sm in self._factories.values():
            sm.on_transition(callback)
    
    def get_all_statuses(self) -> dict[str, FactoryStatus]:
        """Get current status of all factories"""
        return {
            factory_id: sm.current_status 
            for factory_id, sm in self._factories.items()
        }
    
    def get_factories_by_status(self, status: FactoryStatus) -> List[str]:
        """Get factory IDs with a specific status"""
        return [
            factory_id 
            for factory_id, sm in self._factories.items() 
            if sm.current_status == status
        ]


# Global instance
factory_status_manager = FactoryStatusManager()
