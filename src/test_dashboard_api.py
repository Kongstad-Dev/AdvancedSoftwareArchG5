#!/usr/bin/env python3
import requests
import json

print("Testing Dashboard APIs...")
print("=" * 60)

# Test PMS via dashboard proxy
print("\n1. Testing /api/factories (PMS proxy)")
try:
    r = requests.get("http://localhost:8080/api/factories", timeout=5)
    print(f"   Status: {r.status_code}")
    if r.status_code == 200:
        data = r.json()
        print(f"   Response: {json.dumps(data, indent=2)[:200]}")
except Exception as e:
    print(f"   ERROR: {e}")

# Test MMS via dashboard proxy
print("\n2. Testing /mms/factories/F1/sensors (MMS proxy)")
try:
    r = requests.get("http://localhost:8080/mms/factories/F1/sensors", timeout=5)
    print(f"   Status: {r.status_code}")
    if r.status_code == 200:
        data = r.json()
        print(f"   Total sensors: {data.get('data', {}).get('total_sensors', 0)}")
        print(f"   Healthy: {data.get('data', {}).get('healthy_count', 0)}")
except Exception as e:
    print(f"   ERROR: {e}")

# Test PMS directly
print("\n3. Testing PMS directly (http://localhost:3000/factories)")
try:
    r = requests.get("http://localhost:3000/factories", timeout=5)
    print(f"   Status: {r.status_code}")
    if r.status_code == 200:
        data = r.json()
        print(f"   Factories: {len(data.get('data', []))}")
except Exception as e:
    print(f"   ERROR: {e}")

# Test MMS directly
print("\n4. Testing MMS directly (http://localhost:8000/factories/F1/sensors)")
try:
    r = requests.get("http://localhost:8000/factories/F1/sensors", timeout=5)
    print(f"   Status: {r.status_code}")
    if r.status_code == 200:
        data = r.json()
        print(f"   Total sensors: {data.get('data', {}).get('total_sensors', 0)}")
except Exception as e:
    print(f"   ERROR: {e}")

print("\n" + "=" * 60)
