/**
 * End-to-end tests for the DummyCloud Terraform provider.
 *
 * Uses the Node.js built-in test runner (node:test).
 *
 * What is tested –
 *   1. Dev mode        – provider started directly via tsx; Terraform reattaches
 *                        via TF_REATTACH_PROVIDERS (the normal dev workflow)
 *   2. Node SEA binary – self-contained binary built with `node --build-sea` (bin/)
 *   3. Bun binary      – self-contained binary compiled with `bun --compile` (bin-bun/)
 *
 * Each suite starts a real DummyCloud API server, runs terraform plan/apply/
 * destroy against a real Terraform CLI, and verifies the API state at each step.
 *
 * Prerequisites
 *   • `terraform` CLI in PATH
 *   • Node SEA binary built (suite 2): pnpm run build:binary
 *   • Bun binary built     (suite 3): pnpm run build:binary:bun
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

// terrably build outputs to bin/ by default (matches `terrably build --out bin`).
const BIN_DIR         = path.join(PROVIDER_ROOT, "bin");
// Bun binary lives in its own directory so both binaries coexist side-by-side.
const BUN_BIN_DIR     = path.join(PROVIDER_ROOT, "bin-bun");

// Fixture templates live next to this file.
const FIXTURES_DIR    = path.join(__dirname, "fixtures");

// Use a fixed port offset to reduce collision risk; tests run sequentially.
const BASE_API_PORT   = 19877;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface ApiFixture {
  port: number;
  proc: ChildProcess;
}

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

/** GET a JSON endpoint, return parsed body.
 *
 * Retries on transient connection errors (ECONNRESET / ECONNREFUSED) that can
 * occur when the provider binary is still tearing down its keep-alive
 * connection to the API server right as the test tries to verify state.
 */
async function apiGet(port: number, urlPath: string, retries = 5): Promise<unknown> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
          let body = "";
          res.on("data", (c: string) => (body += c));
          res.on("end", () => {
            try { resolve(JSON.parse(body)); }
            catch (e) { reject(e); }
          });
          res.on("error", reject);
        }).on("error", reject);
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const transient = code === "ECONNRESET" || code === "ECONNREFUSED" || code === "ETIMEDOUT";
      if (transient && attempt < retries) {
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  /* istanbul ignore next */
  throw new Error("unreachable");
}

/** POST JSON to the API; returns parsed response body. */
async function apiPost(port: number, urlPath: string, body: unknown): Promise<unknown> {
  const bodyStr = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(bodyStr) },
      },
      (res) => {
        let data = "";
        res.on("data", (c: string) => (data += c));
        res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

/** PUT JSON to the API; returns parsed response body. */
async function apiPut(port: number, urlPath: string, body: unknown): Promise<unknown> {
  const bodyStr = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method: "PUT",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(bodyStr) },
      },
      (res) => {
        let data = "";
        res.on("data", (c: string) => (data += c));
        res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

/** Write the .terraformrc + one-server-with-tags.tftpl config into `dir`. */
function writeTfConfigWithTags(dir: string, apiPort: number, tagsExpr: string, binDir: string = BIN_DIR): void {
  writeTfConfig(dir, apiPort, "one-server-with-tags.tftpl", binDir, { TAGS_EXPR: tagsExpr });
}

/** Write the .terraformrc + bad-api.tftpl config into `dir`. */
function writeTfConfigBadApi(dir: string, binDir: string = BIN_DIR): void {
  renderFixture(dir, "terraformrc.tpl", { BIN_DIR: binDir });
  renderFixture(dir, "bad-api.tftpl", {});
}

/**
 * Render a fixture template into `dir`.
 *
 * Template tokens (`{{KEY}}`) are replaced with the supplied `vars`.
 * `terraformrc.tpl` is always rendered as `.terraformrc`.
 * All other templates are rendered as `main.tf`.
 */
function renderFixture(
  dir: string,
  templateName: string,
  vars: Record<string, string> = {},
): void {
  const tplPath = path.join(FIXTURES_DIR, templateName);
  let content = fs.readFileSync(tplPath, "utf8");
  for (const [key, value] of Object.entries(vars)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }
  const outName = templateName === "terraformrc.tpl" ? ".terraformrc" : "main.tf";
  fs.writeFileSync(path.join(dir, outName), content);
}

/** Write the shared .terraformrc + a named main.tf template into `dir`. */
function writeTfConfig(
  dir: string,
  apiPort: number,
  mainTpl = "two-servers.tftpl",
  binDir: string = BIN_DIR,
  extraVars: Record<string, string> = {},
): void {
  renderFixture(dir, "terraformrc.tpl", { BIN_DIR: binDir });
  renderFixture(dir, mainTpl, { API_PORT: String(apiPort), BIN_DIR: binDir, ...extraVars });
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

async function startApiServer(port: number): Promise<ApiFixture> {
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
  await waitForApi(port);
  return ({ port, proc });
}

/**
 * Start the provider in dev mode (TF_PLUGIN_DEBUG=1) via tsx and wait until
 * it prints TF_REATTACH_PROVIDERS to stdout. Returns the JSON string value
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
// Suite 2 — Node SEA binary (bin/)
// ---------------------------------------------------------------------------

describe("provider: Node SEA binary", () => {
  const seaBinary = path.join(BIN_DIR, `terraform-provider-dummycloud${process.platform === "win32" ? ".exe" : ""}`);
  let api: ApiFixture;
  let tfDir: string;

  before(async () => {
    assert.ok(
      fs.existsSync(seaBinary),
      `SEA binary not found at ${seaBinary}. Run: pnpm run build:binary`
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

// ---------------------------------------------------------------------------
// Suite 3 — Bun compiled binary (bin-bun/)
//
// The provider is compiled to a single self-contained executable by
// `bun --compile`. No Node.js or Bun runtime is required at run time.
// Build it once with: pnpm run build:binary:bun
// ---------------------------------------------------------------------------

describe("provider: Bun compiled binary", () => {
  const ext       = process.platform === "win32" ? ".exe" : "";
  const bunBinary = path.join(BUN_BIN_DIR, `terraform-provider-dummycloud${ext}`);
  let api: ApiFixture;
  let tfDir: string;

  before(async () => {
    assert.ok(
      fs.existsSync(bunBinary),
      `Bun binary not found at ${bunBinary}. Run: pnpm run build:binary:bun`
    );

    api   = await startApiServer(BASE_API_PORT + 2);
    tfDir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-e2e-bun-"));
    writeTfConfig(tfDir, BASE_API_PORT + 2, "two-servers.tftpl", BUN_BIN_DIR);
  });

  after(() => {
    api.proc.kill();
    fs.rmSync(tfDir, { recursive: true, force: true });
  });

  it("smoke test: binary exits non-zero when magic cookie is missing", () => {
    assert.throws(
      () => execFileSync(bunBinary, [], { stdio: "pipe", timeout: 3000 }),
      /Command failed/
    );
  });

  it("full cycle: plan → apply → verify → destroy", async () => {
    await planApplyVerifyDestroy(tfDir, BASE_API_PORT + 2, "Bun");
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — in-place update + idempotency
//
// Verifies that –
//   • changing an attribute (size) triggers exactly 1 change in the plan
//     (exercises changedFields in PlanResourceChange)
//   • running plan immediately after apply reports no changes
//     (exercises encodeBlockPreserving in ReadResource)
// ---------------------------------------------------------------------------

describe("provider: in-place update and idempotency", () => {
  let api: ApiFixture;
  let tfDir: string;
  let providerProc: ChildProcess;
  let reattachEnv: Record<string, string>;

  before(async () => {
    api = await startApiServer(BASE_API_PORT + 3);
    tfDir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-e2e-update-"));
    writeTfConfig(tfDir, BASE_API_PORT + 3);
    const { proc, reattachJson } = await startProviderDevMode();
    providerProc = proc;
    reattachEnv = { TF_REATTACH_PROVIDERS: reattachJson };
  });

  after(() => {
    providerProc?.kill();
    api.proc.kill();
    fs.rmSync(tfDir, { recursive: true, force: true });
  });

  it("apply creates 2 servers", async () => {
    tf(["apply", "-auto-approve", "-no-color"], tfDir, path.join(tfDir, ".terraformrc"), reattachEnv);
    const servers = (await apiGet(BASE_API_PORT + 3, "/servers")) as Array<{ name: string }>;
    assert.equal(servers.length, 2);
  });

  // Exercises encodeBlockPreserving + TfNormalizedJson.semanticallyEqual for the
  // null-tags case: the API returns the same state, so no spurious diff should appear.
  it("plan immediately after apply shows no changes (idempotency)", () => {
    const out = tf(["plan", "-no-color"], tfDir, path.join(tfDir, ".terraformrc"), reattachEnv);
    assert.match(out, /No changes\.|0 to change/);
  });

  it("modifying size: plan reports exactly 1 resource to change", () => {
    renderFixture(tfDir, "two-servers-updated-size.tftpl", { API_PORT: String(BASE_API_PORT + 3) });
    const out = tf(["plan", "-no-color", "-out=tfplan-update"], tfDir, path.join(tfDir, ".terraformrc"), reattachEnv);
    assert.match(out, /Plan: 0 to add, 1 to change, 0 to destroy/);
  });

  it("applying the update reflects the new size in the API", async () => {
    tf(["apply", "-auto-approve", "-no-color", "tfplan-update"], tfDir, path.join(tfDir, ".terraformrc"), reattachEnv);
    const servers = (await apiGet(BASE_API_PORT + 3, "/servers")) as Array<{ name: string; size: string }>;
    const web = servers.find((s) => s.name === "web-01");
    assert.ok(web, "web-01 should exist after update");
    assert.equal(web!.size, "medium");
  });

  it("plan after update shows no changes (idempotency after update)", () => {
    const out = tf(["plan", "-no-color"], tfDir, path.join(tfDir, ".terraformrc"), reattachEnv);
    assert.match(out, /No changes\.|0 to change/);
  });

  it("destroy removes all servers", async () => {
    tf(["destroy", "-auto-approve", "-no-color"], tfDir, path.join(tfDir, ".terraformrc"), reattachEnv);
    const after = (await apiGet(BASE_API_PORT + 3, "/servers")) as unknown[];
    assert.equal(after.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Suite 5 — normalizedJson: key-reorder idempotency
//
// Verifies that when the upstream API returns JSON with keys in a different
// order than what Terraform stored, no spurious diff appears in the next plan.
//
// The scenario:
//   1. Apply with tags = jsonencode({env="prod", owner="alice"})
//      → state stores the sorted JSON string {"env":"prod","owner":"alice"}
//   2. Directly PUT to the API to change key ordering to {owner, env}
//      (simulates an API that doesn't preserve key insertion order)
//   3. terraform plan → ReadResource reads {owner:"alice",env:"prod"} from API
//      encodeBlockPreserving calls normalizedJson.semanticallyEqual
//      → equal → prior wire bytes reused → 0 changes  ✓
//   4. Modify tags config to confirm a real change IS detected.
// ---------------------------------------------------------------------------

describe("provider: normalizedJson tags key-reorder idempotency", () => {
  let api: ApiFixture;
  let tfDir: string;
  let providerProc: ChildProcess;
  let reattachEnv: Record<string, string>;

  before(async () => {
    api = await startApiServer(BASE_API_PORT + 4);
    tfDir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-e2e-tags-"));
    writeTfConfigWithTags(tfDir, BASE_API_PORT + 4, `jsonencode({env="prod", owner="alice"})`);
    const { proc, reattachJson } = await startProviderDevMode();
    providerProc = proc;
    reattachEnv = { TF_REATTACH_PROVIDERS: reattachJson };
  });

  after(() => {
    providerProc?.kill();
    api.proc.kill();
    fs.rmSync(tfDir, { recursive: true, force: true });
  });

  it("apply creates the server with tags", async () => {
    tf(["apply", "-auto-approve", "-no-color"], tfDir, path.join(tfDir, ".terraformrc"), reattachEnv);
    const servers = (await apiGet(BASE_API_PORT + 4, "/servers")) as Array<{ id: string; name: string; tags: unknown }>;
    assert.equal(servers.length, 1);
    assert.ok(servers[0]!.tags, "tags should be present in API");
  });

  it("plan after apply shows no changes (baseline idempotency)", () => {
    const out = tf(["plan", "-no-color"], tfDir, path.join(tfDir, ".terraformrc"), reattachEnv);
    assert.match(out, /No changes\.|0 to change/);
  });

  // Core regression test for TfNormalizedJson.semanticallyEqual + encodeBlockPreserving:
  // after the API stores the tags with reversed key order, the next plan must still
  // report 0 changes.
  it("API-side key reorder does not cause a spurious plan diff", async () => {
    // Fetch the server to get its ID, then PUT with keys in reversed order.
    const servers = (await apiGet(BASE_API_PORT + 4, "/servers")) as Array<{ id: string }>;
    const id = servers[0]!.id;
    // Store tags with reversed key order — simulates an API that doesn't preserve sort.
    await apiPut(BASE_API_PORT + 4, `/servers/${id}`, { tags: { owner: "alice", env: "prod" } });

    // Plan should detect no change: semanticallyEqual treats {"owner":…,"env":…}
    // and {"env":…,"owner":…} as identical.
    const out = tf(["plan", "-no-color"], tfDir, path.join(tfDir, ".terraformrc"), reattachEnv);
    assert.match(out, /No changes\.|0 to change/);
  });

  it("changing a tag value IS detected as a change", () => {
    renderFixture(tfDir, "one-server-with-tags.tftpl", { API_PORT: String(BASE_API_PORT + 4), TAGS_EXPR: `jsonencode({env="staging", owner="alice"})` });
    const out = tf(["plan", "-no-color", "-out=tfplan-tag-update"], tfDir, path.join(tfDir, ".terraformrc"), reattachEnv);
    assert.match(out, /Plan: 0 to add, 1 to change, 0 to destroy/);
  });

  it("destroy removes the server", async () => {
    tf(["destroy", "-auto-approve", "-no-color"], tfDir, path.join(tfDir, ".terraformrc"), reattachEnv);
    const after = (await apiGet(BASE_API_PORT + 4, "/servers")) as unknown[];
    assert.equal(after.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Suite 6 — terraform import
//
// Verifies that a server created directly via the API can be imported into
// Terraform state, and that the resulting state produces no plan diff.
// ---------------------------------------------------------------------------

describe("provider: terraform import", () => {
  let api: ApiFixture;
  let tfDir: string;
  let providerProc: ChildProcess;
  let reattachEnv: Record<string, string>;

  before(async () => {
    api = await startApiServer(BASE_API_PORT + 5);
    tfDir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-e2e-import-"));
    const { proc, reattachJson } = await startProviderDevMode();
    providerProc = proc;
    reattachEnv = { TF_REATTACH_PROVIDERS: reattachJson };
  });

  after(() => {
    providerProc?.kill();
    api.proc.kill();
    fs.rmSync(tfDir, { recursive: true, force: true });
  });

  it("import brings an API-created server into state", async () => {
    // Create server directly via the API (bypassing Terraform).
    const created = (await apiPost(BASE_API_PORT + 5, "/servers", { name: "imported-01", size: "small" })) as { id: string };
    const serverId = created.id;

    // Write the Terraform config whose declaration matches the server.
    writeTfConfig(tfDir, BASE_API_PORT + 5, "one-server-basic.tftpl");

    // Import the existing server into the Terraform resource address.
    tf(["import", "-no-color", "dummycloud_server.imported", serverId], tfDir, path.join(tfDir, ".terraformrc"), reattachEnv);

    // After import, plan should show no changes (state matches config + API).
    const out = tf(["plan", "-no-color"], tfDir, path.join(tfDir, ".terraformrc"), reattachEnv);
    assert.match(out, /No changes\.|0 to change/);
  });

  it("destroy removes the imported server from the API", async () => {
    tf(["destroy", "-auto-approve", "-no-color"], tfDir, path.join(tfDir, ".terraformrc"), reattachEnv);
    const after = (await apiGet(BASE_API_PORT + 5, "/servers")) as unknown[];
    assert.equal(after.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Suite 7 — provider panic → error diagnostic (no provider crash)
//
// Verifies that when user code throws (here: fetch to a dead address), the
// SDK's try/catch in ApplyResourceChange catches the exception and returns
// a Terraform error diagnostic instead of crashing the provider process.
//
// Before the fix, an unhandled throw would propagate out of the gRPC handler,
// causing the provider process to exit and Terraform to report
// "Plugin crashed: exit status 1" rather than a structured diagnostic.
// ---------------------------------------------------------------------------

describe("provider: unhandled provider error becomes an error diagnostic", () => {
  let tfDir: string;
  let providerProc: ChildProcess;
  let reattachEnv: Record<string, string>;

  before(async () => {
    tfDir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-e2e-panic-"));
    writeTfConfigBadApi(tfDir);
    const { proc, reattachJson } = await startProviderDevMode();
    providerProc = proc;
    reattachEnv = { TF_REATTACH_PROVIDERS: reattachJson };
  });

  after(() => {
    providerProc?.kill();
    fs.rmSync(tfDir, { recursive: true, force: true });
  });

  it("apply fails with an error diagnostic, not a provider crash", () => {
    // tf() throws on non-zero exit; capture the error to inspect the output.
    let errorOutput = "";
    let threw = false;
    try {
      tf(["apply", "-auto-approve", "-no-color"], tfDir, path.join(tfDir, ".terraformrc"), reattachEnv);
    } catch (err) {
      threw = true;
      const spawnErr = err as { stdout?: string; stderr?: string; message?: string };
      errorOutput = `${spawnErr.stdout ?? ""}\n${spawnErr.stderr ?? ""}\n${spawnErr.message ?? ""}`;
    }

    assert.ok(threw, "apply should exit non-zero when the API is unreachable");

    // A structured Terraform diagnostic contains "Error:" in the output.
    assert.match(errorOutput, /Error/i, "output should contain a Terraform error diagnostic");

    // The provider must NOT have crashed: a crash produces "Plugin crashed".
    assert.doesNotMatch(errorOutput, /Plugin crashed|plugin crashed/, "provider should not have crashed");
  });

  it("provider process is still alive after the failed apply", () => {
    // exitCode is null while the process is still running.
    assert.equal(providerProc.exitCode, null, "provider process should still be running");
  });
});

// ---------------------------------------------------------------------------
// Suite 8 — ObjectAttribute (metadata, SINGLE nesting)
//
// Verifies that a Schema_Object / nested_type attribute:
//   • is accepted by Terraform (provider schema registers correctly)
//   • is applied correctly (create stores the structured value)
//   • produces no spurious plan diff after apply (encodeBlockPreserving + TfObject
//     semanticallyEqual compares field-by-field)
//   • a real field change IS detected as a plan change (1 to change)
//   • the change is correctly applied
// ---------------------------------------------------------------------------

describe("provider: ObjectAttribute metadata (SINGLE nesting)", () => {
  let api: ApiFixture;
  let tfDir: string;
  let providerProc: ChildProcess;
  let reattachEnv: Record<string, string>;

  before(async () => {
    api = await startApiServer(BASE_API_PORT + 6);
    tfDir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-e2e-meta-"));
    writeTfConfig(tfDir, BASE_API_PORT + 6, "one-server-with-metadata.tftpl");
    const { proc, reattachJson } = await startProviderDevMode();
    providerProc = proc;
    reattachEnv = { TF_REATTACH_PROVIDERS: reattachJson };
  });

  after(() => {
    providerProc?.kill();
    api.proc.kill();
    fs.rmSync(tfDir, { recursive: true, force: true });
  });

  it("plan shows 1 resource to create", () => {
    const out = tf(["plan", "-no-color", "-out=tfplan-meta"], tfDir, path.join(tfDir, ".terraformrc"), reattachEnv);
    assert.match(out, /Plan: 1 to add/);
  });

  it("apply creates the server and the API stores the metadata object", async () => {
    tf(["apply", "-auto-approve", "-no-color", "tfplan-meta"], tfDir, path.join(tfDir, ".terraformrc"), reattachEnv);
    const servers = (await apiGet(BASE_API_PORT + 6, "/servers")) as Array<{
      name: string;
      metadata: { owner: string; environment: string } | null;
    }>;
    assert.equal(servers.length, 1);
    const meta = servers[0]!.metadata;
    assert.ok(meta, "metadata should be stored in the API");
    assert.equal(meta.owner,       "alice");
    assert.equal(meta.environment, "prod");
  });

  // Core regression test for TfObject.semanticallyEqual + encodeBlockPreserving:
  // the read() round-trip through TfObject.decode → TfObject.encode must produce
  // a value that compares as equal to the prior wire bytes, so no spurious diff occurs.
  it("plan immediately after apply shows no changes (ObjectAttribute idempotency)", () => {
    const out = tf(["plan", "-no-color"], tfDir, path.join(tfDir, ".terraformrc"), reattachEnv);
    assert.match(out, /No changes\.|0 to change/);
  });

  it("changing a metadata field IS detected as a plan change (1 to change)", () => {
    renderFixture(tfDir, "one-server-with-metadata-updated.tftpl", { API_PORT: String(BASE_API_PORT + 6) });
    const out = tf(["plan", "-no-color", "-out=tfplan-meta-update"], tfDir, path.join(tfDir, ".terraformrc"), reattachEnv);
    assert.match(out, /Plan: 0 to add, 1 to change, 0 to destroy/);
  });

  it("applying the metadata change updates the value in the API", async () => {
    tf(["apply", "-auto-approve", "-no-color", "tfplan-meta-update"], tfDir, path.join(tfDir, ".terraformrc"), reattachEnv);
    const servers = (await apiGet(BASE_API_PORT + 6, "/servers")) as Array<{
      name: string;
      metadata: { owner: string; environment: string } | null;
    }>;
    const meta = servers[0]!.metadata;
    assert.ok(meta);
    assert.equal(meta.environment, "staging", "environment should be updated to 'staging'");
  });

  it("plan after metadata update shows no changes (idempotency after update)", () => {
    const out = tf(["plan", "-no-color"], tfDir, path.join(tfDir, ".terraformrc"), reattachEnv);
    assert.match(out, /No changes\.|0 to change/);
  });

  it("destroy removes the server", async () => {
    tf(["destroy", "-auto-approve", "-no-color"], tfDir, path.join(tfDir, ".terraformrc"), reattachEnv);
    const after = (await apiGet(BASE_API_PORT + 6, "/servers")) as unknown[];
    assert.equal(after.length, 0);
  });
});
