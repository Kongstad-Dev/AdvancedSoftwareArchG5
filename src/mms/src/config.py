"""
Configuration settings for MMS
Sensor-based monitoring (Temperature, Level, Quality sensors)
"""
import os
from dataclasses import dataclass, field
from typing import Dict


@dataclass
class SensorThresholds:
    """Thresholds for sensor readings"""
    temperature: Dict = field(default_factory=lambda: {
        'normal': {'min': 15, 'max': 30},
        'warning': {'min': 10, 'max': 35}
    })
    level: Dict = field(default_factory=lambda: {
        'normal': {'min': 20, 'max': 80},
        'warning': {'min': 10, 'max': 90}
    })
    quality_ph: Dict = field(default_factory=lambda: {
        'normal': {'min': 6.5, 'max': 7.5},
        'warning': {'min': 6.0, 'max': 8.0}
    })
    quality_color: Dict = field(default_factory=lambda: {
        'normal': {'min': 40, 'max': 60},
        'warning': {'min': 30, 'max': 70}
    })
    quality_weight: Dict = field(default_factory=lambda: {
        'normal': {'min': 490, 'max': 510},
        'warning': {'min': 480, 'max': 520}
    })


@dataclass
class Config:
    """MMS Configuration"""
    # MongoDB settings
    mongodb_uri: str = os.getenv('MONGODB_URI', 'mongodb://mms_user:mms_password@localhost:27017/monitoring_db?authSource=admin')
    mongodb_database: str = 'monitoring_db'
    
    # Kafka settings
    kafka_brokers: str = os.getenv('KAFKA_BROKERS', 'localhost:9092')
    kafka_sensor_topic: str = 'factory.sensors'
    kafka_consumer_group: str = 'mms-sensor-consumer-group'
    
    # PMS gRPC settings
    pms_grpc_host: str = os.getenv('PMS_GRPC_HOST', 'localhost')
    pms_grpc_port: int = int(os.getenv('PMS_GRPC_PORT', '50051'))
    
    # Sensor monitoring settings
    sensor_timeout_seconds: int = int(os.getenv('SENSOR_TIMEOUT_SECONDS', '5'))
    sensors_per_factory: int = 20  # 6 temp + 6 level + 8 quality
    
    # Factory health thresholds (based on % of OK sensors)
    factory_health_operational: int = 80   # >= 80% OK = Operational
    factory_health_degraded: int = 50      # 50-79% OK = Degraded
    factory_health_critical: int = 20      # 20-49% OK = Critical
    # < 20% OK = Down
    
    # Recovery settings
    recovery_consecutive_healthy_count: int = 5
    
    # Health check settings
    health_check_port: int = int(os.getenv('HEALTH_CHECK_PORT', '8000'))
    
    # Sensor thresholds
    sensor_thresholds: SensorThresholds = field(default_factory=SensorThresholds)
    
    @property
    def kafka_brokers_list(self) -> list:
        return self.kafka_brokers.split(',')
    
    @property
    def pms_grpc_address(self) -> str:
        return f"{self.pms_grpc_host}:{self.pms_grpc_port}"


config = Config()
