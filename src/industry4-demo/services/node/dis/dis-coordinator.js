const amqp = require("amqplib");
const { MongoClient } = require("mongodb");
const nodemailer = require("nodemailer");

const CONFIG = {
  rabbitMQ: process.env.RABBITMQ_URL || "amqp://guest:guest@localhost:5672/",
  mongoUrl: process.env.MONGO_URL || "mongodb://localhost:27017",
  mongoDb: process.env.MONGO_DB || "logs",
  anomalyCollection: process.env.MONGO_COLLECTION || "anomalies",
  alertQueue: process.env.RABBITMQ_ALERT_QUEUE || "failure-alerts",
  notifyFrom: process.env.NOTIFY_FROM || "system@factory.com",
  notifyTo: (process.env.NOTIFY_TO || "manager@factory.com").split(",")
};

class ConfigVisitor {
  constructor({ logger }) {
    this.logger = logger;
  }

  visitFactory(factory) {
    this.logger(`Visiting factory ${factory.factory}`);
    return this.visitConfigurations(factory.configurations || []);
  }

  visitConfigurations(configurations) {
    configurations.forEach((config) => {
      this.logger(`Config ${config.name} => state=${config.state}`);
    });
    return configurations.length;
  }
}

const loadFactoriesFromMongo = async (client) => {
  const db = client.db(CONFIG.mongoDb);
  const records = await db.collection(CONFIG.anomalyCollection).find({}).toArray();
  return records.map((record) => ({
    factory: record.factory ?? "unknown",
    configurations: record.configurations || [
      {
        name: "backup-route",
        state: record.action || "unknown"
      }
    ]
  }));
};

const handleAlert = async (channel, msg, mongoClient) => {
  if (!msg?.content) {
    return;
  }
  const alert = JSON.parse(msg.content.toString());
  console.warn("[DIS] Received failover alert", alert);

  const factories = await loadFactoriesFromMongo(mongoClient);
  const visitor = new ConfigVisitor({
    logger: (message) => console.log(`[DIS][Visitor] ${message}`)
  });

  factories.forEach((factory) => {
    visitor.visitFactory(factory);
  });

  await sendNotification(alert, factories.length);

  console.log(
    `[DIS] Completed cross-factory synchronization for ${factories.length} factories triggered by sensor ${alert.sensorId}`
  );
  channel.ack(msg);
};

const transporter = nodemailer.createTransport({ jsonTransport: true });

const sendNotification = async (alert, syncedFactories) => {
  const subject = `Reroute executed for sensor ${alert.sensorId}`;
  const text = `Reason: ${alert.reason}\nTimestamp: ${alert.timestamp}\nFactories updated: ${syncedFactories}`;
  await transporter.sendMail({
    from: CONFIG.notifyFrom,
    to: CONFIG.notifyTo,
    subject,
    text
  });
  console.log("[DIS] Notification dispatched via Nodemailer", { sensorId: alert.sensorId, syncedFactories });
};

const run = async () => {
  const mongoClient = new MongoClient(CONFIG.mongoUrl);
  await mongoClient.connect();
  console.log("[DIS] Connected to MongoDB", CONFIG.mongoUrl);

  const connection = await amqp.connect(CONFIG.rabbitMQ);
  const channel = await connection.createChannel();
  await channel.assertQueue(CONFIG.alertQueue, { durable: false });
  console.log("[DIS] Listening for alerts on queue", CONFIG.alertQueue);

  channel.consume(CONFIG.alertQueue, (msg) => {
    handleAlert(channel, msg, mongoClient).catch((error) => {
      console.error("[DIS] Error handling alert:", error);
      channel.nack(msg, false, false);
    });
  });

  const shutdown = async () => {
    console.log("[DIS] Shutting down coordinator");
    await channel.close();
    await connection.close();
    await mongoClient.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

run().catch((error) => {
  console.error("[DIS] Coordinator failed to start:", error);
  process.exit(1);
});
