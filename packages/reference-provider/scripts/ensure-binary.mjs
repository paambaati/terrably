#!/usr/bin/env node
/**
 * ensure-binary.mjs
 *
 * Run before the e2e test suite to ensure the SEA binary exists.
 * If it is missing, invokes `terrably build` to produce it.
 *
 * This is intentionally lightweight: it does NOT rebuild when source changes —
 * it only bootstraps a fresh checkout where no binary has been built yet.
 * Developers who change provider source should run `pnpm run build:binary`
 * explicitly.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const providerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binDir       = path.join(providerRoot, "bin");
const ext          = process.platform === "win32" ? ".exe" : "";
const binary       = path.join(binDir, `terraform-provider-dummycloud${ext}`);

if (fs.existsSync(binary)) {
  process.stdout.write(`Binary already present: ${binary}\n`);
} else {
  process.stdout.write(`Binary not found at ${binary} — building...\n`);
  execSync("pnpm run build:binary", { cwd: providerRoot, stdio: "inherit" });
}
