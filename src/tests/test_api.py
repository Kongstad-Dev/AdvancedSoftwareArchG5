#!/usr/bin/env python3
"""Quick test to verify MMS API returns sensor data"""
import requests
import json

# Test MMS API
try:
    response = requests.get("http://localhost:8000/factories/F1/sensors")
    print(f"Status Code: {response.status_code}")
    print(f"Response:\n{json.dumps(response.json(), indent=2)}")
    
    data = response.json().get("data", {})
    print(f"\nFactory F1 has {data.get('total_sensors', 0)} sensors")
    print(f"Healthy: {data.get('healthy_count', 0)}")
    print(f"Failed: {data.get('failed_count', 0)}")
    
except Exception as e:
    print(f"ERROR: {e}")
