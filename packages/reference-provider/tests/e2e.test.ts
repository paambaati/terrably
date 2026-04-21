/**
 * End-to-end tests for the DummyCloud Terraform provider.
 *
 * Uses the Node.js built-in test runner (node:test).
 *
 * What is tested:
 *   1. Dev mode  – provider started directly via tsx; Terraform reattaches via
 *                  TF_REATTACH_PROVIDERS (the normal development workflow)
 *   2. Node SEA binary     – provider runs as a self-contained binary (bin-sea/)
 *
 * Each suite starts a real DummyCloud API server, runs terraform plan/apply/
 * destroy against a real Terraform CLI, and verifies the API state at each step.
 *
 * Prerequisites
 *   • `terraform` CLI in PATH
 *   • SEA binary built (for suite 2):     node scripts/build-sea.mjs
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync, execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TF_MAGIC_COOKIE = "d602bf8f470bc67ca7faa0386276bbdd4330efaf76d1a219cb4d6991ca9872b2" as const;
// Running from source with tsx: __dirname = <pkg>/tests — one level up is the package root.
const PROVIDER_ROOT   = path.resolve(__dirname, "..");
const SDK_ROOT        = path.resolve(PROVIDER_ROOT, "..", "sdk");

// Use a fixed port offset to reduce collision risk; tests run sequentially.
const BASE_API_PORT   = 19877;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Wait until GET /servers returns 200, or throw after timeout. */
async function waitForApi(port: number, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/servers`, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on("error", () => resolve(false));
      req.setTimeout(500, () => { req.destroy(); resolve(false); });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`API on port ${port} not ready after ${timeoutMs}ms`);
}

/** GET a JSON endpoint, return parsed body. */
async function apiGet(port: number, urlPath: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
      let body = "";
      res.on("data", (c: string) => (body += c));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

/** Write a minimal Terraform config for the suite. */
function writeTfConfig(dir: string, apiPort: number): void {
  const overridesPath = path.join(dir, ".terraformrc");
  const binDir        = path.join(PROVIDER_ROOT, "bin-sea");

  fs.writeFileSync(overridesPath, `\
provider_installation {
  dev_overrides {
    "example/dummycloud" = "${binDir}"
  }
  direct {}
}
`);

  fs.writeFileSync(path.join(dir, "main.tf"), `\
terraform {
  required_providers {
    dummycloud = { source = "example/dummycloud" }
  }
}
provider "dummycloud" {
  api_url = "http://127.0.0.1:${apiPort}"
}
resource "dummycloud_server" "web" {
  name = "web-01"
  size = "small"
}
resource "dummycloud_server" "db" {
  name = "db-01"
  size = "large"
}
output "web_id"     { value = dummycloud_server.web.id }
output "web_status" { value = dummycloud_server.web.status }
`);
}

/** Run a terraform subcommand, return stdout. Throws on non-zero exit. */
function tf(args: string[], cwd: string, terraformrc: string, extraEnv: Record<string, string> = {}): string {
  return execFileSync("terraform", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, TF_CLI_CONFIG_FILE: terraformrc, TF_INPUT: "0", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// ---------------------------------------------------------------------------
// Fixture: API server lifecycle for a single suite
// ---------------------------------------------------------------------------

interface ApiFixture {
  port: number;
  proc: ChildProcess;
}

function startApiServer(port: number): Promise<ApiFixture> {
  // Resolve tsx/cjs from this package's node_modules so the spawn doesn't
  // require tsx to be globally installed.
  const tsxCjs = require.resolve("tsx/cjs");
  const proc = spawn(process.execPath, [
    "--require", tsxCjs,
    path.join(PROVIDER_ROOT, "api-server", "index.ts"),
  ], {
    env: { ...process.env, PORT: String(port) },
    stdio: "pipe",
  });
  proc.stderr?.on("data", (d: Buffer) => process.stderr.write(`[api:${port}] ${d}`));
  return waitForApi(port).then(() => ({ port, proc }));
}

/**
 * Start the provider in dev mode (TF_PLUGIN_DEBUG=1) via tsx and wait until
 * it prints TF_REATTACH_PROVIDERS to stdout.  Returns the JSON string value
 * ready to be passed as the TF_REATTACH_PROVIDERS env var.
 */
function startProviderDevMode(timeoutMs = 10_000): Promise<{ proc: ChildProcess; reattachJson: string }> {
  return new Promise((resolve, reject) => {
    const tsxCjs = require.resolve("tsx/cjs");
    const proc = spawn(process.execPath, [
      "--require", tsxCjs,
      path.join(PROVIDER_ROOT, "src", "main.ts"),
    ], {
      env: {
        ...process.env,
        TF_PLUGIN_MAGIC_COOKIE: TF_MAGIC_COOKIE,
        TF_PLUGIN_DEBUG: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Provider did not emit TF_REATTACH_PROVIDERS within ${timeoutMs}ms`));
    }, timeoutMs);

    let stdout = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = /TF_REATTACH_PROVIDERS='(.+?)'/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolve({ proc, reattachJson: match[1]! });
      }
    });

    proc.stderr?.on("data", (d: Buffer) => process.stderr.write(`[provider:dev] ${d}`));

    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Provider exited with code ${code} before emitting TF_REATTACH_PROVIDERS`));
    });
  });
}

// ---------------------------------------------------------------------------
// Helper: run a full plan → apply → verify → destroy cycle
// ---------------------------------------------------------------------------

async function planApplyVerifyDestroy(tfDir: string, apiPort: number, label: string, extraEnv: Record<string, string> = {}): Promise<void> {
  const rc = path.join(tfDir, ".terraformrc");

  // plan
  const planOut = tf(["plan", "-no-color", "-out=tfplan"], tfDir, rc, extraEnv);
  assert.match(planOut, /Plan: 2 to add/, `[${label}] plan should show 2 to add`);

  // apply
  tf(["apply", "-auto-approve", "-no-color", "tfplan"], tfDir, rc, extraEnv);

  // verify via API
  const servers = (await apiGet(apiPort, "/servers")) as Array<{ name: string; size: string }>;
  assert.equal(servers.length, 2, `[${label}] API should have 2 servers after apply`);
  assert.ok(servers.some((s) => s.name === "web-01"), `[${label}] web-01 should exist`);
  assert.ok(servers.some((s) => s.name === "db-01"),  `[${label}] db-01 should exist`);

  // destroy
  tf(["destroy", "-auto-approve", "-no-color"], tfDir, rc, extraEnv);

  // verify deletion
  const after = (await apiGet(apiPort, "/servers")) as unknown[];
  assert.equal(after.length, 0, `[${label}] API should be empty after destroy`);
}

// ---------------------------------------------------------------------------
// Suite 1 — dev mode (tsx + TF_REATTACH_PROVIDERS)
//
// The provider is started directly via tsx with TF_PLUGIN_DEBUG=1.
// Terraform reattaches to the already-running process via TF_REATTACH_PROVIDERS.
// This mirrors the normal development workflow (no shell wrapper needed).
// ---------------------------------------------------------------------------

describe("provider: dev mode", () => {
  let api: ApiFixture;
  let tfDir: string;
  let providerProc: ChildProcess;
  let reattachEnv: Record<string, string>;

  before(async () => {
    api = await startApiServer(BASE_API_PORT);
    tfDir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-e2e-dev-"));
    writeTfConfig(tfDir, BASE_API_PORT);

    // Start the provider in dev mode and capture TF_REATTACH_PROVIDERS.
    // dev_overrides in .terraformrc tells Terraform to skip registry lookups;
    // TF_REATTACH_PROVIDERS tells it to connect to the already-running process.
    const { proc, reattachJson } = await startProviderDevMode();
    providerProc = proc;
    reattachEnv = { TF_REATTACH_PROVIDERS: reattachJson };
  });

  after(() => {
    providerProc?.kill();
    api.proc.kill();
    fs.rmSync(tfDir, { recursive: true, force: true });
  });

  it("plan reports 2 resources to create", () => {
    const out = tf(["plan", "-no-color", "-out=tfplan"], tfDir, path.join(tfDir, ".terraformrc"), reattachEnv);
    assert.match(out, /Plan: 2 to add/);
  });

  it("apply creates both servers and they appear in the API", async () => {
    tf(["apply", "-auto-approve", "-no-color", "tfplan"], tfDir, path.join(tfDir, ".terraformrc"), reattachEnv);
    const servers = (await apiGet(BASE_API_PORT, "/servers")) as Array<{ name: string }>;
    assert.equal(servers.length, 2);
    assert.ok(servers.some((s) => s.name === "web-01"));
    assert.ok(servers.some((s) => s.name === "db-01"));
  });

  it("destroy removes both servers from the API", async () => {
    tf(["destroy", "-auto-approve", "-no-color"], tfDir, path.join(tfDir, ".terraformrc"), reattachEnv);
    const after = (await apiGet(BASE_API_PORT, "/servers")) as unknown[];
    assert.equal(after.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — Node SEA binary (bin-sea/)
// ---------------------------------------------------------------------------

describe("provider: Node SEA binary", () => {
  const seaBinary = path.join(PROVIDER_ROOT, "bin-sea", "terraform-provider-dummycloud");
  let api: ApiFixture;
  let tfDir: string;

  before(async () => {
    assert.ok(
      fs.existsSync(seaBinary),
      `SEA binary not found at ${seaBinary}. Run: node scripts/build-sea.mjs`
    );

    api   = await startApiServer(BASE_API_PORT + 1);
    tfDir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-e2e-sea-"));
    writeTfConfig(tfDir, BASE_API_PORT + 1);
    // writeTfConfig already writes .terraformrc pointing at bin-sea/
  });

  after(() => {
    api.proc.kill();
    fs.rmSync(tfDir, { recursive: true, force: true });
  });

  it("smoke test: binary exits non-zero when magic cookie is missing", () => {
    // Without the magic cookie the binary prints an error and exits non-zero.
    // execFileSync throws on non-zero exit, which is what we assert here.
    assert.throws(
      () => execFileSync(seaBinary, [], { stdio: "pipe", timeout: 3000 }),
      /Command failed/
    );
  });

  it("full cycle: plan → apply → verify → destroy", async () => {
    await planApplyVerifyDestroy(tfDir, BASE_API_PORT + 1, "SEA");
  });
});


