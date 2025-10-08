#!/usr/bin/env node
/**
 * Helper script to regenerate gRPC bindings for Node.js services.
 * Requires `grpc-tools` to be available (e.g. npm install -g grpc-tools).
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const protoPath = path.join(ROOT, "proto", "health.proto");
const outDir = path.join(ROOT, "services", "node", "generated");

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const args = [
  "grpc_tools_node_protoc",
  `--js_out=import_style=commonjs,binary:${outDir}`,
  `--grpc_out=grpc_js:${outDir}`,
  `--proto_path=${path.dirname(protoPath)}`,
  protoPath
];

const result = spawnSync("npx", args, { stdio: "inherit" });

if (result.error) {
  console.error("Failed to execute grpc_tools_node_protoc:", result.error.message);
  process.exit(1);
}

if (result.status !== 0) {
  console.error("Protobuf generation failed with exit code", result.status);
  process.exit(result.status);
}

console.log("Node.js protobuf stubs generated in", outDir);
