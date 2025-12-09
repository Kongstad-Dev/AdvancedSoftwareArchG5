"""
MQTT Listener for Factory Events
Listens to sensor failures and factory restart notifications
"""
import logging
import json
import asyncio
from typing import Optional
from datetime import datetime

import paho.mqtt.client as mqtt

from ..config import config
from ..monitoring.sensor_health_monitor import sensor_health_monitor
from ..grpc.pms_client import pms_client
from ..predictive.risk_predictor import risk_predictor

logger = logging.getLogger(__name__)


class FactoryMQTTListener:
    """
    MQTT listener for factory events.
    
    Subscribes to:
    - factory/+/sensor-failure: Sensor failure notifications
    - factory/+/heartbeat: Sensor heartbeat messages  
    - factory/+/restart: Factory restart notifications
    """
    
    def __init__(self):
        self._client: Optional[mqtt.Client] = None
        self._running = False
        self._pms_notifications = {}  # Track what we've notified PMS about
        
    def connect(self) -> bool:
        """Connect to MQTT broker"""
        try:
            # Extract host and port from broker URL
            broker_url = config.mqtt_broker.replace('mqtt://', '')
            if ':' in broker_url:
                host, port = broker_url.split(':')
                port = int(port)
            else:
                host = broker_url
                port = 1883
            
            self._client = mqtt.Client(client_id=f"mms-listener-{datetime.now().timestamp()}")
            
            self._client.on_connect = self._on_connect
            self._client.on_message = self._on_message
            self._client.on_disconnect = self._on_disconnect
            
            logger.info(f"Connecting to MQTT broker at {host}:{port}")
            self._client.connect(host, port, keepalive=60)
            
            # Start network loop in background
            self._client.loop_start()
            self._running = True
            
            return True
            
        except Exception as e:
            logger.error(f"Failed to connect to MQTT broker: {e}")
            return False
    
    def _on_connect(self, client, userdata, flags, rc):
        """Callback when connected to MQTT broker"""
        if rc == 0:
            logger.info("Connected to MQTT broker successfully")
            
            # Subscribe to factory events
            topics = [
                ("factory/+/sensor-failure", 1),
                ("factory/+/heartbeat", 1),
                ("factory/+/restart", 1),
                ("factory/+/readings", 1)  # Subscribe to sensor readings
            ]
            
            for topic, qos in topics:
                client.subscribe(topic, qos)
                logger.info(f"Subscribed to MQTT topic: {topic}")
        else:
            logger.error(f"Failed to connect to MQTT broker with code: {rc}")
    
    def _on_disconnect(self, client, userdata, rc):
        """Callback when disconnected from MQTT broker"""
        if rc != 0:
            logger.warning(f"Unexpected MQTT disconnection (code: {rc}). Will auto-reconnect.")
    
    def _on_message(self, client, userdata, msg):
        """Callback when message received"""
        try:
            topic = msg.topic
            payload = json.loads(msg.payload.decode('utf-8'))
            
            # Log every incoming message temporarily for debugging
            if '/readings' in topic:
                logger.info(f"📨 Received reading on topic: {topic}")
            
            # Route to appropriate handler (run synchronously in callback thread)
            if '/sensor-failure' in topic:
                self._handle_sensor_failure_sync(topic, payload)
            elif '/heartbeat' in topic:
                self._handle_heartbeat_sync(topic, payload)
            elif '/restart' in topic:
                self._handle_factory_restart_sync(topic, payload)
            elif '/readings' in topic:
                self._handle_sensor_reading_sync(topic, payload)
            else:
                logger.info(f"Unhandled topic: {topic}")
                
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse MQTT message: {e}")
        except Exception as e:
            logger.error(f"Error processing MQTT message: {e}")
    
    def _handle_sensor_failure_sync(self, topic: str, payload: dict):
        """Handle sensor failure notification (synchronous version)"""
        factory_id = payload.get('factoryId')
        sensor_id = payload.get('sensorId')
        reading = payload.get('reading')
        reason = payload.get('reason', 'Unknown')
        
        logger.warning(f"🚨 SENSOR FAILURE: {sensor_id} in {factory_id} - {reason} (reading: {reading})")
        
        # Mark sensor as failed in monitoring
        sensor_health_monitor.mark_sensor_failed(sensor_id, reason)
    
    def _handle_heartbeat_sync(self, topic: str, payload: dict):
        """Handle sensor heartbeat (synchronous version)"""
        sensor_id = payload.get('sensorId')
        factory_id = payload.get('factoryId')
        tier = payload.get('tier', 'unknown')
        timestamp_str = payload.get('timestamp')
        
        if not sensor_id or not factory_id:
            return
        
        # Parse timestamp
        try:
            timestamp = datetime.fromisoformat(timestamp_str.replace('Z', '+00:00'))
        except (ValueError, AttributeError):
            timestamp = datetime.utcnow()
        
        # Update sensor health monitor
        sensor_health_monitor.process_heartbeat(sensor_id, factory_id, tier, timestamp)
    
    def _handle_factory_restart_sync(self, topic: str, payload: dict):
        """Handle factory restart notification (synchronous version)"""
        factory_id = payload.get('factoryId')
        recovered_sensors = payload.get('recoveredSensors', [])
        
        logger.info(f"🔄 FACTORY RESTART: {factory_id} - Recovered {len(recovered_sensors)} sensors")
        logger.info(f"   Recovered sensors: {', '.join(recovered_sensors)}")
        
        # Recover all sensors in the sensor health monitor
        sensor_health_monitor.recover_factory_sensors(factory_id, recovered_sensors)
        
        # Reset risk tracking for recovered sensors
        for sensor_id in recovered_sensors:
            risk_predictor.reset_sensor_risk(sensor_id)
    
    def _handle_sensor_reading_sync(self, topic: str, payload: dict):
        """Handle sensor reading and check for at-risk patterns"""
        factory_id = payload.get('factoryId')
        sensor_id = payload.get('sensorId')
        reading = payload.get('reading')
        
        logger.info(f"📊 Processing sensor reading: {sensor_id} = {reading}")
        
        if not sensor_id or not factory_id or reading is None:
            logger.warning(f"Incomplete reading payload: {payload}")
            return
        
        # Track reading in risk predictor (threshold=70 to detect degrading sensors)
        at_risk_info = risk_predictor.track_sensor_reading(sensor_id, factory_id, reading, threshold=70.0)
        
        # If sensor became at-risk, publish notification to MQTT for PMS to handle
        if at_risk_info:
            risk_notification = {
                "factoryId": factory_id,
                "sensorId": sensor_id,
                "lowReadingCount": at_risk_info["low_reading_count"],
                "recentReadings": at_risk_info["recent_readings"],
                "threshold": at_risk_info["threshold"],
                "timestamp": datetime.utcnow().isoformat()
            }
            
            # Publish to MQTT topic for PMS to consume
            topic = f"factory/{factory_id}/sensor-at-risk"
            try:
                self._client.publish(
                    topic,
                    json.dumps(risk_notification),
                    qos=1
                )
                logger.info(f"📢 Published sensor at-risk notification for {sensor_id} to {topic}")
            except Exception as e:
                logger.error(f"Failed to publish sensor at-risk notification: {e}")
    
    def stop(self):
        """Stop MQTT listener"""
        if self._client and self._running:
            self._client.loop_stop()
            self._client.disconnect()
            self._running = False
            logger.info("MQTT listener stopped")


# Global instance
factory_mqtt_listener = FactoryMQTTListener()
