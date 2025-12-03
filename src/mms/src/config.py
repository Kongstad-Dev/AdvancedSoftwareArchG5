"""
Configuration settings for MMS
"""
import os
from dataclasses import dataclass


@dataclass
class Config:
    """MMS Configuration"""
    # MongoDB settings
    mongodb_uri: str = os.getenv('MONGODB_URI', 'mongodb://mms_user:mms_password@localhost:27017/monitoring_db?authSource=admin')
    mongodb_database: str = 'monitoring_db'
    
    # Kafka settings
    kafka_brokers: str = os.getenv('KAFKA_BROKERS', 'localhost:9092')
    kafka_heartbeat_topic: str = 'factory.heartbeat'
    kafka_consumer_group: str = 'mms-consumer-group'
    
    # PMS gRPC settings
    pms_grpc_host: str = os.getenv('PMS_GRPC_HOST', 'localhost')
    pms_grpc_port: int = int(os.getenv('PMS_GRPC_PORT', '50051'))
    
    # Monitoring settings
    heartbeat_timeout_seconds: int = int(os.getenv('HEARTBEAT_TIMEOUT_SECONDS', '3'))
    missed_heartbeats_threshold: int = 3
    degraded_error_rate_threshold: float = 0.05
    high_risk_error_rate_threshold: float = 0.1
    recovery_consecutive_healthy_count: int = 5
    
    # Health check settings
    health_check_port: int = int(os.getenv('HEALTH_CHECK_PORT', '8000'))
    
    @property
    def kafka_brokers_list(self) -> list:
        return self.kafka_brokers.split(',')
    
    @property
    def pms_grpc_address(self) -> str:
        return f"{self.pms_grpc_host}:{self.pms_grpc_port}"


config = Config()
