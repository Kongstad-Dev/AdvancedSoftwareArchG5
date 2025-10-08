// SysML textual requirements for Industry 4.0 demo
requirement FR1 {
  id = "FR1"
  text = "System shall maintain continuous availability by rerouting production on anomaly detection."
  verifies = ["UC1"]
}

requirement FR3 {
  id = "FR3"
  text = "Monitoring service shall ingest heterogeneous sensor data via MQTT adapters."
  verifies = ["UC1", "UC4"]
}

requirement FR7 {
  id = "FR7"
  text = "System shall avoid technology lock-in by supporting multiple message buses and databases."
  verifies = ["Exercise4"]
}

requirement FR9 {
  id = "FR9"
  text = "System shall coordinate cross-factory updates using microservice interfaces."
  verifies = ["UC4"]
}

requirement NFR1 {
  id = "NFR1"
  text = "Failover latency shall be below 1 second."
  verifies = ["UC1"]
}

requirement NFR2 {
  id = "NFR2"
  text = "Event pipeline shall sustain at least 100 messages per minute during reroute."
  verifies = ["LoadTest"]
}

requirement NFR7 {
  id = "NFR7"
  text = "System shall support redundancy tactics to eliminate single points of failure."
  verifies = ["Exercise5"]
}
