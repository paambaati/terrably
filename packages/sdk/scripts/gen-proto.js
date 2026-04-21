#!/usr/bin/env node
// Generates TypeScript stubs from the proto files using ts-proto.
// Uses the protoc bundled inside grpc-tools so no system protoc is required.
"use strict";

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const root = path.resolve(__dirname, "..");
const protoDir = path.join(root, "proto");
const outDir = path.join(root, "gen");

// Resolve the protoc binary bundled by grpc-tools
const protocBin = path.join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "grpc_tools_node_protoc.cmd" : "grpc_tools_node_protoc"
);

// Resolve the ts-proto plugin
const tsProtoPlugin = path.join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "protoc-gen-ts_proto.cmd" : "protoc-gen-ts_proto"
);

// Ensure output directory exists
fs.mkdirSync(outDir, { recursive: true });

const protoFiles = fs
  .readdirSync(protoDir)
  .filter((f) => f.endsWith(".proto"))
  .map((f) => path.join(protoDir, f));

// ts-proto options:
//   outputServices=nice-grpc  → emit nice-grpc compatible service defs
//   outputClientImpl=false    → skip client stubs (we only need server side)
//   addGrpcMetadata=true      → include metadata in service calls
//   esModuleInterop=true      → TS esModuleInterop compat
//   useDate=false             → keep Timestamps as proto objects (Terraform uses them)
//   forceLong=long            → use Long for int64 fields (critical for TF state versions)
const tsProtoOpts = [
  "outputServices=nice-grpc",
  "outputClientImpl=false",
  "addGrpcMetadata=true",
  "esModuleInterop=true",
  "useDate=false",
  "forceLong=long",
].join(",");

const cmd = [
  protocBin,
  `--plugin=protoc-gen-ts_proto=${tsProtoPlugin}`,
  `--ts_proto_out=${outDir}`,
  `--ts_proto_opt=${tsProtoOpts}`,
  `-I${protoDir}`,
  ...protoFiles,
].join(" ");

console.log("Running protoc...");
console.log(cmd);
execSync(cmd, { stdio: "inherit" });
console.log("Proto generation complete → gen/");
