#!/usr/bin/env node
/**
 * build-sea.mjs
 *
 * Builds a Node.js Single Executable Application (SEA) for this provider.
 * The output binary embeds the Node.js runtime — no Node.js installation is
 * required on the machine that runs `terraform apply`.
 *
 * Requirements:
 *   Node.js >= 22  (for stable --build-sea support)
 *
 * Usage (from this directory):
 *   node scripts/build-sea.mjs [--name example] [--out bin/]
 *
 * The default --name matches getFullName() in src/provider.ts.
 * Change it if you rename your provider (e.g. --name mycloud).
 *
 * Steps performed:
 *   1. esbuild bundles all JS + node_modules into one CJS file
 *   2. A SEA entry-point is generated that extracts embedded proto assets to
 *      a temp directory and sets TF_PROTO_DIR before the server starts
 *   3. node --build-sea injects the entry-point into a copy of the node binary
 *   4. macOS: the binary is re-signed with an ad-hoc codesign (no cert needed)
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, createRequire } from "node:url";
import * as esbuild from "esbuild";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const providerRoot  = path.resolve(__dirname, "..");

// Resolve proto files from the installed terrably package so this script
// works whether the SDK is a local monorepo sibling or installed from npm.
const _require = createRequire(import.meta.url);
const protoSrc  = path.join(path.dirname(_require.resolve("terrably/package.json")), "proto");

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const getArg = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };

const providerName = getArg("--name") ?? "example";
const outDir       = path.resolve(providerRoot, getArg("--out") ?? "bin");
const binaryName   = `terraform-provider-${providerName}` + (process.platform === "win32" ? ".exe" : "");
const binaryPath   = path.join(outDir, binaryName);

// ---------------------------------------------------------------------------
// Preflight checks
// ---------------------------------------------------------------------------

const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
if (nodeMajor < 22) {
  console.error(`✗ Node.js >= 22 required for --build-sea (found ${process.version})`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Step 1: TypeScript compile
// ---------------------------------------------------------------------------

console.log("▶ Compiling TypeScript...");
execSync("pnpm exec tsc", { cwd: providerRoot, stdio: "inherit" });

// ---------------------------------------------------------------------------
// Step 2: esbuild — bundle JS + node_modules into one CJS file
// ---------------------------------------------------------------------------

console.log("▶ Bundling with esbuild...");

const bundleOut = path.join(providerRoot, "dist", "_sea_bundle.cjs");

await esbuild.build({
  entryPoints: [path.join(providerRoot, "dist", "src", "main.js")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: bundleOut,
  packages: "bundle",
  external: ["*.node"],
});

// ---------------------------------------------------------------------------
// Step 3: Generate SEA entry-point
// ---------------------------------------------------------------------------

console.log("▶ Generating SEA entry-point...");

const bundleCode = fs.readFileSync(bundleOut, "utf8");

const seaEntryCode = `\
"use strict";
// ── SEA preamble: extract .proto assets into a temp dir ──────────────────
const _sea  = require("node:sea");
const _os   = require("node:os");
const _fs   = require("node:fs");
const _path = require("node:path");

if (_sea.isSea()) {
  const protoDir = _fs.mkdtempSync(_path.join(_os.tmpdir(), "tf-js-proto-"));
  process.on("exit", () => { try { _fs.rmSync(protoDir, { recursive: true }); } catch {} });
  for (const name of ["tfplugin6.proto", "grpc_controller.proto", "grpc_stdio.proto"]) {
    _fs.writeFileSync(_path.join(protoDir, name), _sea.getAsset(name, "utf8"));
  }
  // serve() reads TF_PROTO_DIR as a fallback when opts.protoDir is not set
  process.env["TF_PROTO_DIR"] = protoDir;
}

// ── Bundled provider (inlined by esbuild) ──────────────────────────────
${bundleCode}
`;

const seaEntryPath = path.join(providerRoot, "dist", "_sea_entry.cjs");
fs.writeFileSync(seaEntryPath, seaEntryCode, "utf8");

// ---------------------------------------------------------------------------
// Step 4: Write sea-config.json
// ---------------------------------------------------------------------------

console.log("▶ Writing sea-config.json...");

const seaConfig = {
  main: seaEntryPath,
  output: binaryPath,
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  useSnapshot: false,
  assets: {
    "tfplugin6.proto":       path.join(protoSrc, "tfplugin6.proto"),
    "grpc_controller.proto": path.join(protoSrc, "grpc_controller.proto"),
    "grpc_stdio.proto":      path.join(protoSrc, "grpc_stdio.proto"),
  },
};

const seaConfigPath = path.join(providerRoot, "dist", "sea-config.json");
fs.writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2));

// ---------------------------------------------------------------------------
// Step 5: node --build-sea  (copies node binary + injects blob)
//         On macOS, Node 20.17+ removes and re-signs the binary automatically.
// ---------------------------------------------------------------------------

fs.mkdirSync(outDir, { recursive: true });
console.log(`▶ Building SEA binary → ${binaryPath}`);
execSync(`node --build-sea "${seaConfigPath}"`, { stdio: "inherit" });

// ---------------------------------------------------------------------------
// Step 6: macOS — ensure ad-hoc codesign (belt-and-suspenders)
// ---------------------------------------------------------------------------

if (process.platform === "darwin") {
  console.log("▶ Signing (ad-hoc codesign)...");
  execSync(`codesign --sign - --force "${binaryPath}"`, { stdio: "inherit" });
}

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------

const sizeMb = (fs.statSync(binaryPath).size / 1024 / 1024).toFixed(1);
console.log(`\n✅  Binary ready: ${binaryPath}  (${sizeMb} MB)`);
console.log(`\n   Smoke test:`);
console.log(`   TF_PLUGIN_MAGIC_COOKIE=d602bf8f470bc67ca7faa0386276bbdd4330efaf76d1a219cb4d6991ca9872b2 \\`);
console.log(`     "${binaryPath}"\n`);
