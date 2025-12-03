"""
Health check endpoint for MMS
"""
import logging
from fastapi import APIRouter, HTTPException
from datetime import datetime

from .db.mongodb import mongodb_client
from .config import config

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/health")
async def health_check():
    """
    Health check endpoint.
    Returns overall service health status.
    """
    mongodb_healthy = mongodb_client.health_check()
    
    health = {
        "status": "healthy" if mongodb_healthy else "unhealthy",
        "timestamp": datetime.utcnow().isoformat(),
        "service": "mms",
        "version": "1.0.0",
        "checks": {
            "mongodb": "connected" if mongodb_healthy else "disconnected"
        }
    }
    
    if not mongodb_healthy:
        raise HTTPException(status_code=503, detail=health)
    
    return health


@router.get("/health/ready")
async def readiness_check():
    """
    Readiness check endpoint.
    Returns whether the service is ready to accept traffic.
    """
    mongodb_healthy = mongodb_client.health_check()
    
    if mongodb_healthy:
        return {"ready": True}
    else:
        raise HTTPException(
            status_code=503, 
            detail={"ready": False, "reason": "MongoDB not ready"}
        )


@router.get("/health/live")
async def liveness_check():
    """
    Liveness check endpoint.
    Returns whether the service is alive.
    """
    return {"alive": True}
