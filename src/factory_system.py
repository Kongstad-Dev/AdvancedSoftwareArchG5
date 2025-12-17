import json
import time
import random
import threading
from datetime import datetime
from typing import List, Dict
from kafka import KafkaProducer


class Sensor:
    """
    Sensor class with ID, tier, heartbeat functionality, and read method.
    """
    def __init__(self, sensor_id: str, tier: str, kafka_producer: KafkaProducer = None):
        self.sensor_id = sensor_id
        self.tier = tier
        self.kafka_producer = kafka_producer
        self._heartbeat_running = True
        self._heartbeat_thread = None
    
    def heartbeat(self):
        """Send heartbeat to Kafka every 1 second."""
        self._heartbeat_running = True
        
        def _heartbeat_loop():
            while self._heartbeat_running:
                timestamp = datetime.now().isoformat()
                heartbeat_data = {
                    "sensorId": self.sensor_id,
                    "tier": self.tier,
                    "timestamp": timestamp,
                    "status": "active"
                }
                
                if self.kafka_producer:
                    try:
                        self.kafka_producer.send(
                            'SENSOR_HEARTBEAT',
                            value=heartbeat_data
                        )
                        print(f"[{timestamp}] Heartbeat sent to Kafka from Sensor {self.sensor_id}")
                    except Exception as e:
                        print(f"Error sending heartbeat to Kafka: {e}")
                else:
                    print(f"[{timestamp}] Heartbeat from Sensor {self.sensor_id} (Tier {self.tier})")
                delay = random.randint(1, 2)
                time.sleep(delay)
        
        self._heartbeat_thread = threading.Thread(target=_heartbeat_loop, daemon=True)
        self._heartbeat_thread.start()
    
    def stop_heartbeat(self):
        """Stop the heartbeat function."""
        self._heartbeat_running = False
        if self._heartbeat_thread:
            self._heartbeat_thread.join(timeout=1)
    
    def read(self) -> int:
        """Return a random number between 0-100."""
        return random.randint(0, 100)
    
    def __repr__(self):
        return f"Sensor(id={self.sensor_id}, tier={self.tier})"


class Factory:
    """
    Factory class with ID and multiple sensors.
    Can retrieve and process JSON configuration files.
    """
    def __init__(self, factory_id: str, kafka_producer: KafkaProducer = None):
        self.factory_id = factory_id
        self.sensors: Dict[str, Sensor] = {}
        self.kafka_producer = kafka_producer
    
    def add_sensor(self, sensor: Sensor):
        """Add a sensor to the factory."""
        self.sensors[sensor.sensor_id] = sensor
    
    def get_sensor(self, sensor_id: str) -> Sensor:
        """Get a sensor by ID."""
        return self.sensors.get(sensor_id)
    
    def process_soda_item(self, soda_name: str, number: int, sensor_id: str):
        """Process a single soda item by taking readings and sending to Kafka."""
        sensor = self.get_sensor(sensor_id)
        if not sensor:
            print(f"⚠️  Sensor {sensor_id} not found in Factory {self.factory_id}")
            return
        
        print(f"\n📊 Factory {self.factory_id} - Processing: {soda_name}")
        print(f"   Sensor: {sensor_id} (Tier {sensor.tier})")
        print(f"   Target sodas: {number}")
        
        count = 0
        while count < number:
            reading = sensor.read()
            count += 1
            timestamp = datetime.now().isoformat()
            
            # Create reading data
            reading_data = {
                "factoryId": self.factory_id,
                "sensorId": sensor_id,
                "tier": sensor.tier,
                "sodaName": soda_name,
                "reading": reading,
                "count": count,
                "total": number,
                "timestamp": timestamp
            }
            
            # Send to Kafka
            if self.kafka_producer:
                try:
                    self.kafka_producer.send(
                        'SENSOR_READINGS',
                        value=reading_data
                    )
                    print(f"   Factory {self.factory_id} [{timestamp}] Reading #{count}/{number}: {reading} -> Kafka")
                except Exception as e:
                    print(f"   Error sending reading to Kafka: {e}")
            else:
                print(f"   Factory {self.factory_id} [{timestamp}] Reading #{count}/{number}: {reading}")
            
            if count < number:
                delay = random.randint(2, 5)
                time.sleep(delay)
        
        print(f"   ✅ Factory {self.factory_id} completed {soda_name}")
    
    def load_and_process_config(self, config_file: str):
        """
        Load JSON configuration file and process sensor readings simultaneously.
        Config format: {"F1": [{"sodaName": "Coca-Cola", "number": 5, "sensorID": "S1-1"}, ...], "F2": [...]}
        Each factory finds its own configuration by factory ID.
        """
        try:
            with open(config_file, 'r') as f:
                config = json.load(f)
            
            # Get configuration for this specific factory
            factory_config = config.get(self.factory_id)
            
            if not factory_config:
                print(f"⚠️  No configuration found for Factory {self.factory_id}")
                return
            
            if not isinstance(factory_config, list):
                print(f"❌ Invalid configuration format for Factory {self.factory_id}")
                return
            
            print(f"\n{'='*60}")
            print(f"Factory {self.factory_id} - Processing Configuration")
            print(f"Found {len(factory_config)} items to process")
            print(f"{'='*60}")
            
            # Process all items simultaneously using threads
            item_threads = []
            for item in factory_config:
                soda_name = item.get('sodaName')
                number = item.get('number')
                sensor_id = item.get('sensorID')
                
                if not all([soda_name, number is not None, sensor_id]):
                    print(f"⚠️  Skipping invalid config item: {item}")
                    continue
                
                thread = threading.Thread(
                    target=self.process_soda_item,
                    args=(soda_name, number, sensor_id)
                )
                thread.start()
                item_threads.append(thread)
            
            # Wait for all items to complete
            for thread in item_threads:
                thread.join()
            
            print(f"\n{'='*60}")
            print(f"Factory {self.factory_id} - All Processing Complete")
            print(f"{'='*60}\n")
        
        except FileNotFoundError:
            print(f"❌ Error: Configuration file '{config_file}' not found")
        except json.JSONDecodeError:
            print(f"❌ Error: Invalid JSON in file '{config_file}'")
        except Exception as e:
            print(f"❌ Error processing configuration: {str(e)}")
    
    def start_all_heartbeats(self):
        """Start heartbeat for all sensors in the factory."""
        for sensor in self.sensors.values():
            sensor.heartbeat()
    
    def stop_all_heartbeats(self):
        """Stop heartbeat for all sensors in the factory."""
        for sensor in self.sensors.values():
            sensor.stop_heartbeat()
    
    def __repr__(self):
        return f"Factory(id={self.factory_id}, sensors={len(self.sensors)})"


def create_factories(num_factories: int, kafka_producer: KafkaProducer = None) -> List[Factory]:
    """
    Create x number of factories with predefined sensors.
    
    Args:
        num_factories: Number of factories to create
        kafka_producer: KafkaProducer instance for streaming data
    
    Returns:
        List of Factory objects
    """
    factories = []
    
    # Predefined sensor configurations
    sensor_tiers = ["1.1", "1.2", "2.1", "2.2", "3.1"]
    
    for i in range(1, num_factories + 1):
        factory = Factory(f"F{i}", kafka_producer)
        
        # Add 3-5 sensors per factory
        num_sensors = random.randint(3, 5)
        for j in range(1, num_sensors + 1):
            sensor_id = f"S{i}-{j}"
            tier = random.choice(sensor_tiers)
            sensor = Sensor(sensor_id, tier, kafka_producer)
            factory.add_sensor(sensor)
        
        factories.append(factory)
        print(f"✅ Created {factory} with sensors: {list(factory.sensors.keys())}")
    
    return factories


def create_example_config(filename: str = "factory_config.json"):
    """Create an example configuration JSON file with factory-specific configs."""
    example_config = {
        "F1": [
            {"sodaName": "Coca-Cola", "number": 5, "sensorID": "S1-1"},
            {"sodaName": "Pepsi", "number": 3, "sensorID": "S1-2"}
        ],
        "F2": [
            {"sodaName": "Sprite", "number": 7, "sensorID": "S2-1"},
            {"sodaName": "Fanta", "number": 4, "sensorID": "S2-2"}
        ],
        "F3": [
            {"sodaName": "Dr Pepper", "number": 6, "sensorID": "S3-1"},
            {"sodaName": "Mountain Dew", "number": 8, "sensorID": "S3-2"}
        ]
    }
    
    with open(filename, 'w') as f:
        json.dump(example_config, indent=2, fp=f)
    
    print(f"📝 Example configuration file created: {filename}")


def run_factory(factory: Factory, config_file: str):
    """Run a single factory's configuration processing with heartbeats."""
    # Start heartbeats for all sensors
    factory.start_all_heartbeats()
    
    # Process configuration
    factory.load_and_process_config(config_file)
    
    # Stop heartbeats after processing
    factory.stop_all_heartbeats()


def main():
    """Main function to demonstrate the factory system with Kafka streaming."""
    print("🏭 Factory System Starting...\n")
    
    # Initialize Kafka Producer
    kafka_producer = None
    try:
        kafka_producer = KafkaProducer(
            bootstrap_servers=['localhost:9092'],
            value_serializer=lambda v: json.dumps(v).encode('utf-8'),
            key_serializer=lambda v: v.encode('utf-8') if v else None
        )
        print("✅ Connected to Kafka broker at localhost:9092\n")
    except Exception as e:
        print(f"⚠️  Warning: Could not connect to Kafka: {e}")
        print("   Running without Kafka streaming...\n")
    
    # Create factories with Kafka producer
    num_factories = 3
    factories = create_factories(num_factories, kafka_producer)
    
    print(f"\n{'='*60}")
    print(f"Created {len(factories)} factories")
    print(f"{'='*60}\n")
    
    # Create example config only if it doesn't exist
    config_file = "factory_config.json"
    import os
    if not os.path.exists(config_file):
        create_example_config(config_file)
    else:
        print(f"📝 Using existing configuration file: {config_file}\n")
    
    # Start all factories concurrently
    print("\n🔧 Starting all factories concurrently...\n")
    print("📡 Streaming to Kafka topics:")
    print("   - SENSOR_READINGS")
    print("   - SENSOR_HEARTBEAT\n")
    
    factory_threads = []
    for factory in factories:
        thread = threading.Thread(target=run_factory, args=(factory, config_file))
        thread.start()
        factory_threads.append(thread)
    
    # Wait for all factories to complete
    for thread in factory_threads:
        thread.join()
    
    # Cleanup
    if kafka_producer:
        kafka_producer.flush()
        kafka_producer.close()
        print("\n✅ Kafka producer closed")
    
    print("✅ All factories completed!")


if __name__ == "__main__":
    main()
