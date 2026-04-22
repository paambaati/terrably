import { spawnSync, spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

// __dirname here is <terrably-pkg>/dist/src/cli/commands/ at runtime.
const SDK_PROTO_DIR = path.resolve(__dirname, "..", "..", "..", "..", "proto");

const MAGIC_COOKIE_KEY   = "TF_PLUGIN_MAGIC_COOKIE";
const MAGIC_COOKIE_VALUE = "d602bf8f470bc67ca7faa0386276bbdd4330efaf76d1a219cb4d6991ca9872b2";


// ---------------------------------------------------------------------------
// Step helpers
// ---------------------------------------------------------------------------

/**
 * Step 1 — Magic-cookie guard.
 * Spawns the provider without TF_PLUGIN_MAGIC_COOKIE and asserts non-zero exit.
 */
function checkMagicCookieGuard(execPath: string, execArgs: string[]): void {
  process.stdout.write("  Checking magic-cookie guard...\n");

  const env = { ...process.env };
  delete env[MAGIC_COOKIE_KEY];

  const result = spawnSync(execPath, execArgs, {
    env,
    timeout: 8_000,
    stdio: ["ignore", "ignore", "pipe"],
  });

  if (result.status === 0) {
    throw new Error(
      "Provider exited 0 without the magic cookie — it must reject startup when the cookie is absent.",
    );
  }
  process.stdout.write(`  ✔  Magic-cookie guard (exit ${result.status ?? "signal"})\n`);
}

/**
 * Step 2 — Dev-mode handshake.
 * Spawns the provider in dev mode and captures TF_REATTACH_PROVIDERS from stdout.
 * Returns the proc (still running) and the parsed JSON string value.
 */
async function startDevMode(
  execPath: string,
  execArgs: string[],
): Promise<{ proc: ReturnType<typeof spawn>; reattachJson: string }> {
  process.stdout.write("  Starting provider in dev mode...\n");

  return new Promise((resolve, reject) => {
    const proc = spawn(execPath, execArgs, {
      env: {
        ...process.env,
        [MAGIC_COOKIE_KEY]: MAGIC_COOKIE_VALUE,
        TF_PLUGIN_DEBUG:    "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("Timed out waiting for TF_REATTACH_PROVIDERS (10 s)"));
    }, 10_000);

    let stdout = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = /TF_REATTACH_PROVIDERS='(.+?)'/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolve({ proc, reattachJson: match[1]! });
      }
    });

    proc.stderr?.on("data", (d: Buffer) => process.stderr.write(`[provider] ${d}`));

    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Provider exited ${code} before emitting TF_REATTACH_PROVIDERS`));
    });
  });
}

/**
 * Step 3 — GetProviderSchema via gRPC.
 * Dials the running provider, calls GetProviderSchema, validates the response.
 */
async function checkSchema(reattachJson: string): Promise<string[]> {
  const reattach = JSON.parse(reattachJson) as Record<
    string,
    { Addr: { Network: string; String: string } }
  >;

  const entry = Object.values(reattach)[0];
  if (!entry) throw new Error("TF_REATTACH_PROVIDERS JSON has no entries");

  if (entry.Addr.Network !== "unix") {
    throw new Error(`Unsupported transport: ${entry.Addr.Network} (expected unix)`);
  }
  const socketPath = entry.Addr.String;

  process.stdout.write(`  Dialing gRPC (unix:${socketPath})...\n`);

  const pkgDef = protoLoader.loadSync(path.join(SDK_PROTO_DIR, "tfplugin6.proto"), {
    keepCase: true,
    longs:    String,
    enums:    String,
    defaults: true,
    oneofs:   true,
    includeDirs: [SDK_PROTO_DIR],
  });

  const grpcObj = grpc.loadPackageDefinition(pkgDef) as Record<
    string,
    Record<string, grpc.ServiceClientConstructor>
  >;
  const ProviderClient = grpcObj["tfplugin6"]!["Provider"]!;
  const client = new ProviderClient(
    `unix:${socketPath}`,
    grpc.credentials.createInsecure(),
  );

  try {
    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      (client as unknown as Record<string, Function>)["GetProviderSchema"](
        {},
        (err: Error | null, res: Record<string, unknown>) => {
          if (err) reject(err);
          else resolve(res);
        },
      );
    });

    // Check for schema-level errors
    const diags = (response["diagnostics"] ?? []) as Array<{
      severity: string;
      summary: string;
    }>;
    const errors = diags.filter((d) => d.severity === "ERROR");
    if (errors.length > 0) {
      throw new Error(`Schema diagnostics contain errors: ${errors.map((e) => e.summary).join("; ")}`);
    }

    // Verify at least one resource schema is present
    const resourceSchemas = response["resource_schemas"] as Record<string, unknown> | undefined;
    const resourceTypes   = Object.keys(resourceSchemas ?? {});
    if (resourceTypes.length === 0) {
      throw new Error("GetProviderSchema returned no resource schemas");
    }

    process.stdout.write(`  ✔  Schema: ${resourceTypes.join(", ")}\n`);
    return resourceTypes;
  } finally {
    client.close();
  }
}

/**
 * Step 4 (optional) — terraform validate.
 * Writes a minimal .tf + .terraformrc into a temp dir and runs terraform validate
 * against the already-running provider via TF_REATTACH_PROVIDERS.
 */
function checkTerraformValidate(resourceTypes: string[], reattachJson: string): void {
  process.stdout.write("  Running terraform validate...\n");

  // Derive provider source from the reattach key, e.g. "registry.terraform.io/myorg/mycloud"
  const providerFullName = Object.keys(
    JSON.parse(reattachJson) as Record<string, unknown>,
  )[0]!;
  // e.g. "registry.terraform.io/myorg/mycloud" → namespace "myorg/mycloud", source "myorg/mycloud"
  const parts  = providerFullName.split("/");
  const source  = parts.slice(1).join("/");   // "myorg/mycloud"
  const alias   = parts[parts.length - 1]!;   // "mycloud"

  // Pick the first resource type for a minimal resource block, e.g. "mycloud_server"
  const firstType = resourceTypes[0]!;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "terrably-check-"));
  try {
    fs.writeFileSync(
      path.join(tmpDir, "main.tf"),
      `terraform {
  required_providers {
    ${alias} = { source = "${source}" }
  }
}
provider "${alias}" {}
`,
    );

    fs.writeFileSync(
      path.join(tmpDir, ".terraformrc"),
      `provider_installation {
  dev_overrides { "${source}" = "${tmpDir}" }
  direct {}
}
`,
    );

    execFileSync("terraform", ["validate", "-no-color"], {
      cwd: tmpDir,
      encoding: "utf8",
      env: {
        ...process.env,
        TF_CLI_CONFIG_FILE:    path.join(tmpDir, ".terraformrc"),
        TF_REATTACH_PROVIDERS: reattachJson,
        TF_INPUT:              "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    process.stdout.write(`  ✔  terraform validate (${firstType} schema accepted)\n`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function checkCommand(options: { binary?: string; terraform?: boolean }): Promise<void> {
  const providerRoot  = process.cwd();
  const binaryArg     = options.binary;
  const withTerraform = options.terraform === true;

  // ── Determine how to spawn the provider ───────────────────────────────────
  let execPath: string;
  let execArgs: string[];

  if (binaryArg) {
    const binaryPath = path.resolve(providerRoot, binaryArg);
    if (!fs.existsSync(binaryPath)) {
      process.stderr.write(`✗ Binary not found: ${binaryPath}\n`);
      process.exit(1);
    }
    execPath = binaryPath;
    execArgs = [];
    process.stdout.write(`terrably check — binary: ${binaryPath}\n\n`);
  } else {
    // Source mode: spawn via tsx from the provider's own node_modules
    const mainTs = path.join(providerRoot, "src", "main.ts");
    if (!fs.existsSync(mainTs)) {
      process.stderr.write(
        "✗ src/main.ts not found. Run terrably check from your provider's root,\n" +
        "  or pass --binary <path> to check a pre-built binary.\n",
      );
      process.exit(1);
    }

    // Resolve tsx from the provider's own node_modules so this works even
    // when terrably is installed globally and tsx is only local to the provider.
    const providerRequire = createRequire(path.join(providerRoot, "package.json"));
    let tsxCjs: string;
    try {
      tsxCjs = providerRequire.resolve("tsx/cjs");
    } catch {
      process.stderr.write(
        "✗ tsx not found in this project's node_modules.\n" +
        "  Run: pnpm add -D tsx\n",
      );
      process.exit(1);
    }

    execPath = process.execPath;
    execArgs = ["--require", tsxCjs, mainTs];
    process.stdout.write(`terrably check — source (tsx): ${mainTs}\n\n`);
  }

  // ── Step 1: magic-cookie guard ────────────────────────────────────────────
  checkMagicCookieGuard(execPath, execArgs);

  // ── Step 2: dev-mode handshake ────────────────────────────────────────────
  const { proc, reattachJson } = await startDevMode(execPath, execArgs);
  process.stdout.write("  ✔  Dev-mode handshake (TF_REATTACH_PROVIDERS emitted)\n");

  let schemaResourceTypes: string[] = [];
  try {
    // ── Step 3: GetProviderSchema ───────────────────────────────────────────
    schemaResourceTypes = await checkSchema(reattachJson);

    // ── Step 4 (optional): terraform validate ──────────────────────────────
    if (withTerraform) {
      try {
        checkTerraformValidate(schemaResourceTypes, reattachJson);
      } catch (err) {
        process.stderr.write(`  ✗  terraform validate failed: ${String(err)}\n`);
        proc.kill();
        process.exit(1);
      }
    }
  } finally {
    proc.kill();
  }

  process.stdout.write("\n✅  All checks passed.\n");
}
