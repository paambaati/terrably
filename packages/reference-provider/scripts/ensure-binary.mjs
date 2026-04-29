#!/usr/bin/env node
/**
 * ensure-binary.mjs
 *
 * Run before the e2e test suite to ensure both provider binaries exist –
 *   1. Node SEA binary (bin/)      — always built
 *   2. Bun compiled binary (bin-bun/) — built only when `bun` is in PATH
 *
 * This is intentionally lightweight; it does NOT rebuild when source changes —
 * it only bootstraps a fresh checkout where no binary has been built yet.
 * Developers who change provider source should run `pnpm run build:binary`
 * (and `pnpm run build:binary:bun`) explicitly.
 */

import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const providerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ext          = process.platform === "win32" ? ".exe" : "";

// ── Node SEA binary ─────────────────────────────────────────────────────────
const seaBinary = path.join(providerRoot, "bin", `terraform-provider-dummycloud${ext}`);
if (fs.existsSync(seaBinary)) {
  process.stdout.write(`Node SEA binary already present: ${seaBinary}\n`);
} else {
  process.stdout.write(`Node SEA binary not found at ${seaBinary} — building...\n`);
  execSync("pnpm run build:binary", { cwd: providerRoot, stdio: "inherit" });
}

// ── Bun compiled binary ─────────────────────────────────────────────────────
const bunBinary = path.join(providerRoot, "bin-bun", `terraform-provider-dummycloud${ext}`);
const bunAvailable = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;

if (!bunAvailable) {
  process.stdout.write("bun not found in PATH — skipping Bun binary build (suite 3 will be skipped at runtime).\n");
} else if (fs.existsSync(bunBinary)) {
  process.stdout.write(`Bun binary already present: ${bunBinary}\n`);
} else {
  process.stdout.write(`Bun binary not found at ${bunBinary} — building...\n`);
  execSync("pnpm run build:binary:bun", { cwd: providerRoot, stdio: "inherit" });
}
