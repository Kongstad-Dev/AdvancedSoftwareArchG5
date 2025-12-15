"""
Kafka Listener for Factory Events
Consumes from Kafka topics for sensor events and factory notifications
"""
import logging
import json
import asyncio
from typing import Optional
from datetime import datetime
from confluent_kafka import Consumer, KafkaError, KafkaException

from ..config import config
from ..monitoring.sensor_health_monitor import sensor_health_monitor
from ..monitoring.heartbeat_monitor import heartbeat_monitor
from ..db.mongodb import mongodb_client
from ..grpc.pms_client import pms_client
from ..predictive.risk_predictor import risk_predictor

logger = logging.getLogger(__name__)


class FactoryKafkaListener:
    """
    Kafka listener for factory events.
    
    Consumes from topics:
    - factory.heartbeat: Sensor heartbeat messages
    - factory.readings: Sensor reading messages
    - factory.sensor-failure: Sensor failure notifications
    - factory.restart: Factory restart notifications
    """
    
    def __init__(self):
        self._consumer: Optional[Consumer] = None
        self._running = False
        self._pms_notifications = {}  # Track what we've notified PMS about
        
        # Kafka topics to subscribe to
        self._topics = [
            'factory.heartbeat',
            'factory.readings',
            'factory.sensor-failure',
            'factory.restart'
        ]
        
    def connect(self) -> bool:
        """Connect to Kafka broker and subscribe to topics"""
        try:
            # Parse Kafka brokers
            kafka_brokers = config.kafka_brokers
            if isinstance(kafka_brokers, str):
                kafka_brokers = kafka_brokers.split(',')
            
            # Create Kafka consumer
            conf = {
                'bootstrap.servers': ','.join(kafka_brokers),
                'group.id': 'mms-consumer-group',
                'auto.offset.reset': 'latest',  # Start from latest messages
                'enable.auto.commit': True,
                'session.timeout.ms': 6000,
                'max.poll.interval.ms': 300000
            }
            
            self._consumer = Consumer(conf)
            
            # Subscribe to topics
            self._consumer.subscribe(self._topics)
            logger.info(f"Subscribed to Kafka topics: {', '.join(self._topics)}")
            
            self._running = True
            return True
            
        except Exception as e:
            logger.error(f"Failed to connect to Kafka broker: {e}")
            return False
    
    async def start(self):
        """Start consuming messages from Kafka"""
        if not self._consumer:
            logger.error("Kafka consumer not initialized. Call connect() first.")
            return
        
        logger.info("Starting Kafka consumer loop...")
        
        try:
            while self._running:
                # Poll for messages with timeout (run in executor to avoid blocking)
                msg = await asyncio.to_thread(self._consumer.poll, 1.0)
                
                if msg is None:
                    # No message received
                    await asyncio.sleep(0.01)
                    continue
                
                if msg.error():
                    if msg.error().code() == KafkaError._PARTITION_EOF:
                        # End of partition, not an error
                        continue
                    else:
                        logger.error(f"Kafka error: {msg.error()}")
                        continue
                
                # Process message
                try:
                    topic = msg.topic()
                    key = msg.key().decode('utf-8') if msg.key() else None
                    value = json.loads(msg.value().decode('utf-8'))
                    
                    # Route to appropriate handler
                    if topic == 'factory.heartbeat' or value.get('message_type') == 'heartbeat':
                        self._handle_heartbeat(value)
                    elif topic == 'factory.readings' or value.get('message_type') == 'readings':
                        await self._handle_sensor_reading(value)
                    elif topic == 'factory.sensor-failure' or value.get('message_type') == 'sensor-failure':
                        self._handle_sensor_failure(value)
                    elif topic == 'factory.restart' or value.get('message_type') == 'restart':
                        self._handle_factory_restart(value)
                    else:
                        logger.debug(f"Unhandled topic: {topic}")
                    
                except json.JSONDecodeError as e:
                    logger.error(f"Failed to parse Kafka message: {e}")
                except Exception as e:
                    logger.error(f"Error processing Kafka message from {topic}: {e}")
                    
        except KafkaException as e:
            logger.error(f"Kafka exception: {e}")
        finally:
            logger.info("Kafka consumer loop stopped")
    
    def _handle_sensor_failure(self, payload: dict):
        """Handle sensor failure notification"""
        factory_id = payload.get('factoryId') or payload.get('factory_id')
        sensor_id = payload.get('sensorId')
        reading = payload.get('reading')
        reason = payload.get('reason', 'Unknown')
        
        logger.warning(f"🚨 SENSOR FAILURE: {sensor_id} in {factory_id} - {reason} (reading: {reading})")
        
        # Mark sensor as failed in monitoring
        sensor_health_monitor.mark_sensor_failed(sensor_id, reason)
    
    def _handle_heartbeat(self, payload: dict):
        """Handle sensor heartbeat"""
        sensor_id = payload.get('sensorId')
        factory_id = payload.get('factoryId') or payload.get('factory_id')
        tier = payload.get('tier', 'unknown')
        timestamp_str = payload.get('timestamp')
        
        if not sensor_id or not factory_id:
            logger.warning(f"Skipping heartbeat - missing sensor_id or factory_id")
            return
        
        # Parse timestamp
        try:
            timestamp = datetime.fromisoformat(timestamp_str.replace('Z', '+00:00'))
        except (ValueError, AttributeError):
            timestamp = datetime.utcnow()
        
        # Update sensor health monitor (in-memory)
        sensor_health_monitor.process_heartbeat(sensor_id, factory_id, tier, timestamp)
        
        # Record heartbeat to MongoDB for persistence and testing
        mongodb_client.record_heartbeat(factory_id, timestamp, {
            'sensor_id': sensor_id,
            'tier': tier,
            'status': payload.get('status', 'active')
        })
        
        logger.debug(f"Processed heartbeat from {sensor_id} in factory {factory_id}")
    
    def _handle_factory_restart(self, payload: dict):
        """Handle factory restart notification"""
        factory_id = payload.get('factoryId') or payload.get('factory_id')
        recovered_sensors = payload.get('recoveredSensors', [])
        
        logger.info(f"🔄 FACTORY RESTART: {factory_id} - Recovered {len(recovered_sensors)} sensors")
        logger.info(f"   Recovered sensors: {', '.join(recovered_sensors)}")
        
        # Recover all sensors in the sensor health monitor
        sensor_health_monitor.recover_factory_sensors(factory_id, recovered_sensors)
        
        # Reset risk tracking for recovered sensors
        for sensor_id in recovered_sensors:
            risk_predictor.reset_sensor_risk(sensor_id)
    
    async def _handle_sensor_reading(self, payload: dict):
        """Handle sensor reading and check for at-risk patterns"""
        factory_id = payload.get('factoryId') or payload.get('factory_id')
        sensor_id = payload.get('sensorId')
        reading = payload.get('reading')
        
        logger.info(f"📊 Processing sensor reading: {sensor_id} = {reading}")
        
        if not sensor_id or not factory_id or reading is None:
            logger.warning(f"Incomplete reading payload: {payload}")
            return
        
        # Track reading in risk predictor (threshold=70 to detect degrading sensors)
        at_risk_info = risk_predictor.track_sensor_reading(sensor_id, factory_id, reading, threshold=70.0)
        
        # If sensor became at-risk, publish notification to Kafka for PMS to consume
        if at_risk_info:
            risk_notification = {
                "factoryId": factory_id,
                "factory_id": factory_id,
                "sensorId": sensor_id,
                "lowReadingCount": at_risk_info["low_reading_count"],
                "recentReadings": at_risk_info["recent_readings"],
                "threshold": at_risk_info["threshold"],
                "timestamp": datetime.utcnow().isoformat(),
                "message_type": "sensor-at-risk"
            }
            
            # Publish to Kafka topic factory.sensor-at-risk
            try:
                from confluent_kafka import Producer
                
                # Create producer for publishing at-risk notifications
                producer_conf = {'bootstrap.servers': ','.join(config.kafka_brokers.split(','))}
                producer = Producer(producer_conf)
                
                producer.produce(
                    'factory.sensor-at-risk',
                    key=factory_id,
                    value=json.dumps(risk_notification)
                )
                producer.flush()
                
                logger.info(f"📢 Published sensor at-risk notification for {sensor_id} to factory.sensor-at-risk")
            except Exception as e:
                logger.error(f"Failed to publish sensor at-risk notification to Kafka: {e}")
    
    def stop(self):
        """Stop Kafka listener"""
        self._running = False
        if self._consumer:
            self._consumer.close()
            logger.info("Kafka consumer stopped")


# Global instance
factory_kafka_listener = FactoryKafkaListener()
