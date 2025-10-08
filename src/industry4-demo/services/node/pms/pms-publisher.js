const path = require("path");
const { randomUUID } = require("crypto");
const { Kafka } = require("kafkajs");
const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");
const CircuitBreaker = require("opossum");
const { Pool } = require("pg");
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

const argv = yargs(hideBin(process.argv))
  .option("factory", {
    alias: "f",
    type: "number",
    default: 1,
    describe: "Factory identifier used across the workflow"
  })
  .option("workflow", {
    alias: "w",
    type: "string",
    default: "bottling",
    describe: "Workflow name for traceability"
  })
  .option("line", {
    alias: "l",
    type: "string",
    default: "line-A",
    describe: "Target production line"
  })
  .help()
  .parse();

const CONFIG = {
  kafkaBrokers: (process.env.KAFKA_BROKERS || "localhost:9092").split(","),
  workflowTopic: process.env.TOPIC_WORKFLOW_EVENTS || "workflow-events",
  postgresUrl: process.env.POSTGRES_URL || "postgres://demo:demo@localhost:5432/workflows",
  grpcTarget: process.env.MMS_GRPC_TARGET || "localhost:50051",
  breaker: {
    timeout: Number.parseInt(process.env.GRPC_TIMEOUT_MS || "1000", 10),
    errorThresholdPercentage: Number.parseFloat(process.env.GRPC_ERROR_THRESHOLD || "50"),
    resetTimeout: Number.parseInt(process.env.GRPC_RESET_TIMEOUT_MS || "30000", 10)
  }
};

const protoPath = path.resolve(__dirname, "../../../proto/health.proto");
const packageDefinition = protoLoader.loadSync(protoPath, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
});
const proto = grpc.loadPackageDefinition(packageDefinition).health;
const grpcClient = new proto.HealthService(CONFIG.grpcTarget, grpc.credentials.createInsecure());

const breaker = new CircuitBreaker(
  (request) =>
    new Promise((resolve, reject) => {
      grpcClient.SyncConfig(request, (error, response) => {
        if (error) {
          reject(error);
        } else {
          resolve(response);
        }
      });
    }),
  CONFIG.breaker
);

const kafka = new Kafka({
  clientId: "pms-service",
  brokers: CONFIG.kafkaBrokers
});

const pool = new Pool({ connectionString: CONFIG.postgresUrl });

const fetchWorkflowConfig = async (factoryId, workflowName) => {
  try {
    const result = await pool.query(
      `
        SELECT workflow_name, target_line, updated_at
        FROM workflows
        WHERE factory_id = $1 AND workflow_name = $2
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      [factoryId, workflowName]
    );
    if (result.rows.length === 0) {
      return {
        workflow_name: workflowName,
        target_line: argv.line,
        updated_at: new Date().toISOString()
      };
    }
    return result.rows[0];
  } catch (error) {
    console.warn("[PMS] Failed to query Postgres, continuing with defaults:", error.message);
    return {
      workflow_name: workflowName,
      target_line: argv.line,
      updated_at: new Date().toISOString()
    };
  }
};

const run = async () => {
  const producer = kafka.producer();
  await producer.connect();

  const config = await fetchWorkflowConfig(argv.factory, argv.workflow);

  let syncResponse;
  try {
    syncResponse = await breaker.fire({ factory: String(argv.factory) });
    console.log(
      `[PMS] gRPC config sync succeeded (healthy=${syncResponse.healthy}, lastUpdated=${syncResponse.lastUpdated})`
    );
  } catch (error) {
    console.warn("[PMS] gRPC sync failed, using fallback:", error.message);
    syncResponse = {
      healthy: true,
      lastUpdated: new Date().toISOString(),
      fallback: true
    };
  }

  const event = {
    id: randomUUID(),
    event: "workflow-started",
    workflow: config.workflow_name,
    factory: argv.factory,
    line: config.target_line,
    timestamp: new Date().toISOString(),
    syncMetadata: syncResponse
  };

  await producer.send({
    topic: CONFIG.workflowTopic,
    messages: [
      {
        key: event.id,
        value: JSON.stringify(event)
      }
    ]
  });

  console.log(`[PMS] Published workflow-started event to ${CONFIG.workflowTopic}`, event);

  await producer.disconnect();
  await pool.end();
};

run()
  .then(() => {
    console.log("[PMS] Completed workflow initiation");
    process.exit(0);
  })
  .catch((error) => {
    console.error("[PMS] Fatal error:", error);
    process.exit(1);
  });
