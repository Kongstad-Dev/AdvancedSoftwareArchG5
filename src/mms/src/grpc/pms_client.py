"""
gRPC client for communicating with PMS (Production Management System)
"""
import logging
import asyncio
from typing import Optional
import grpc

from ..config import config
from ..monitoring.exception_handler import exception_handler

logger = logging.getLogger(__name__)


class PMSClient:
    """
    gRPC client for PMS FactoryStatusService.
    
    Used to report factory status changes to PMS for order rescheduling.
    """
    
    def __init__(self):
        self._channel: Optional[grpc.Channel] = None
        self._stub = None
        self._connected = False
    
    def connect(self) -> bool:
        """Establish connection to PMS gRPC server"""
        try:
            # Load proto dynamically
            from grpc_tools import protoc
            import grpc_tools.protoc
            
            # For now, we'll use a simpler approach with channel
            self._channel = grpc.insecure_channel(config.pms_grpc_address)
            
            # Try to connect
            try:
                grpc.channel_ready_future(self._channel).result(timeout=5)
                self._connected = True
                logger.info(f"Connected to PMS gRPC server at {config.pms_grpc_address}")
                return True
            except grpc.FutureTimeoutError:
                logger.warning(f"Could not connect to PMS gRPC server at {config.pms_grpc_address}")
                return False
                
        except Exception as e:
            logger.error(f"Failed to connect to PMS: {e}")
            return False
    
    def _ensure_connected(self):
        """Ensure connection is established"""
        if not self._connected:
            self.connect()
    
    async def report_factory_status(
        self, 
        factory_id: str, 
        status: str, 
        reason: str
    ) -> dict:
        """
        Report factory status to PMS via gRPC.
        
        Args:
            factory_id: Factory identifier
            status: Status (UP, DEGRADED, DOWN)
            reason: Reason for status change
            
        Returns:
            Response from PMS
        """
        self._ensure_connected()
        
        # Since we're using dynamic proto loading, we'll make an HTTP call as fallback
        # In production, this would use the proper gRPC stub
        
        import httpx
        
        try:
            # Use REST endpoint as fallback
            pms_url = f"http://{config.pms_grpc_host}:3000/factories/{factory_id}/status"
            
            async with httpx.AsyncClient() as client:
                response = await client.put(
                    pms_url,
                    json={
                        "status": status,
                        "reason": reason
                    },
                    timeout=10.0
                )
                
                if response.status_code == 200:
                    data = response.json()
                    logger.info(f"Reported factory status to PMS: {factory_id} -> {status}")
                    return {
                        "success": True,
                        "message": data.get("data", {}).get("message", "Status updated"),
                        "orders_rescheduled": data.get("data", {}).get("ordersRescheduled", 0)
                    }
                else:
                    logger.error(f"PMS returned error: {response.status_code} - {response.text}")
                    return {
                        "success": False,
                        "message": f"PMS error: {response.status_code}"
                    }
                    
        except Exception as e:
            logger.error(f"Failed to report factory status: {e}")
            return {
                "success": False,
                "message": str(e)
            }
    
    async def report_factory_status_with_retry(
        self,
        factory_id: str,
        status: str,
        reason: str,
        max_retries: int = 3
    ) -> dict:
        """
        Report factory status with retry logic.
        
        Args:
            factory_id: Factory identifier
            status: Status (UP, DEGRADED, DOWN)
            reason: Reason for status change
            max_retries: Maximum retry attempts
            
        Returns:
            Response from PMS
        """
        last_error = None
        
        for attempt in range(1, max_retries + 1):
            try:
                result = await self.report_factory_status(factory_id, status, reason)
                if result.get("success"):
                    return result
                last_error = result.get("message")
            except Exception as e:
                last_error = str(e)
                logger.warning(f"Report status attempt {attempt}/{max_retries} failed: {e}")
            
            if attempt < max_retries:
                delay = 0.5 * (2 ** (attempt - 1))
                await asyncio.sleep(delay)
        
        logger.error(f"All retry attempts failed for factory status report: {factory_id}")
        return {
            "success": False,
            "message": f"All retries failed: {last_error}"
        }
    
    def close(self):
        """Close the gRPC channel"""
        if self._channel:
            self._channel.close()
            self._connected = False
            logger.info("PMS gRPC connection closed")


# Global instance
pms_client = PMSClient()
