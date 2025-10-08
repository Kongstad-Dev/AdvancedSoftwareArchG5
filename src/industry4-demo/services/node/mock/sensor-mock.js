const mqtt = require("mqtt");
const { randomUUID } = require("crypto");
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

const argv = yargs(hideBin(process.argv))
  .option("sensors", {
    alias: "n",
    type: "number",
    default: 5,
    describe: "Number of concurrent sensor publishers to simulate"
  })
  .option("interval", {
    alias: "i",
    type: "number",
    default: 5000,
    describe: "Interval in milliseconds between sensor samples"
  })
  .option("fail-after", {
    type: "number",
    describe: "Milliseconds after which all sensors fail (omit for manual failure injection)"
  })
  .option("mqtt-url", {
    type: "string",
    default: process.env.MQTT_URL || "mqtt://localhost:1883",
    describe: "MQTT broker URL"
  })
  .option("topic", {
    type: "string",
    default: process.env.MQTT_SENSOR_TOPIC || "factory1/sensors",
    describe: "MQTT topic for sensor data"
  })
  .help()
  .parse();

const client = mqtt.connect(argv["mqtt-url"]);
const sensorRegistry = Array.from({ length: argv.sensors }).map((_, index) => ({
  id: index + 1,
  healthy: true
}));

const publishSample = (sensor) => {
  const status = sensor.healthy ? "healthy" : "failed";
  const message = {
    sensorId: sensor.id,
    status,
    value: sensor.healthy ? Math.round(Math.random() * 1000) / 10 : null,
    timestamp: new Date().toISOString(),
    correlationId: randomUUID()
  };

  client.publish(argv.topic, JSON.stringify(message), { qos: 0 }, (error) => {
    if (error) {
      console.error(`[MockSensor] Failed to publish sample for sensor ${sensor.id}:`, error.message);
    }
  });
};

client.on("connect", () => {
  console.log(`[MockSensor] Connected to ${argv["mqtt-url"]}, publishing to topic ${argv.topic}`);

  sensorRegistry.forEach((sensor) => {
    publishSample(sensor);
    sensor.timer = setInterval(() => publishSample(sensor), argv.interval);
  });
});

client.on("error", (error) => {
  console.error("[MockSensor] MQTT error:", error.message);
});

if (argv["fail-after"]) {
  setTimeout(() => {
    console.warn("[MockSensor] Triggering failure mode for all sensors");
    sensorRegistry.forEach((sensor) => {
      sensor.healthy = false;
    });
  }, argv["fail-after"]);
}

const shutdown = () => {
  console.log("[MockSensor] Shutting down sensor simulation");
  sensorRegistry.forEach((sensor) => clearInterval(sensor.timer));
  client.end(true, () => process.exit(0));
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
