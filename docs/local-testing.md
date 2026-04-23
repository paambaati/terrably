# Local testing guide

This guide covers every workflow you'll use while iterating on a Terraform provider built with `terrably` – running plan/apply against your code, debugging gRPC calls, writing unit tests for resource logic, and running the full E2E suite.

---

## Overview of the two testing modes

| Mode | How Terraform finds your provider | Use when |
|---|---|---|
| **dev_overrides** | `~/.terraformrc` or `TF_CLI_CONFIG_FILE` points Terraform at a local binary | Daily development — fast iteration |
| **dev mode** | You start the provider manually; Terraform reattaches via `TF_REATTACH_PROVIDERS` | Attaching a debugger, inspecting logs in real time |

---

## Mode 1 — dev_overrides (recommended for most work)

This is the simplest workflow. Terraform calls your local binary as if it were a released provider.

### Step 1 – Build your provider

```bash
pnpm run build
```

### Step 2 – Build the provider binary

Terraform invokes providers as OS processes. Build a self-contained SEA binary –

```bash
# Requires Node.js >= 25.5.0
pnpm run build:sea
```

The output is `bin/terraform-provider-<name>` — a native binary that embeds the Node.js runtime. No Node.js or bash is required on the machine running `terraform apply`.

### Step 3 – Configure dev_overrides

You can either write a global `~/.terraformrc` or a local file and point `TF_CLI_CONFIG_FILE` at it.

**Option A — local file (recommended, keeps your global config clean):**

```hcl
# tf-workspace/.terraformrc
provider_installation {
  dev_overrides {
    "myorg/mycloud" = "/absolute/path/to/your-provider/bin"
  }
  direct {}
}
```

**Option B — edit `~/.terraformrc`** (affects all Terraform workspaces on your machine).

### Step 4 – Write a Terraform config

```hcl
# tf-workspace/main.tf
terraform {
  required_providers {
    mycloud = { source = "myorg/mycloud" }
  }
}

provider "mycloud" {
  api_url = "http://127.0.0.1:8765"
}

resource "mycloud_server" "example" {
  name   = "hello"
  region = "us-east-1"
}
```

### Step 5 – Run Terraform

```bash
cd tf-workspace

# With a local .terraformrc –
export TF_CLI_CONFIG_FILE="$PWD/.terraformrc"

terraform plan
terraform apply -auto-approve
terraform destroy -auto-approve
```

> **No `terraform init` needed** with `dev_overrides` — Terraform skips the registry lookup.

### Iterate rapidly

The loop is –

```
edit TypeScript → pnpm exec tsc → terraform plan
```

Each `terraform plan` spawns a fresh Node.js process, so there is no server to restart.

---

## Mode 2 — dev mode (manual process + reattach)

Use this when you want to attach a debugger, print detailed logs, or inspect exactly what Terraform sends over gRPC.

### Step 1 – Start your provider manually

Your `main.ts` should respect the `--dev` flag or `TF_PLUGIN_DEBUG=1`:

```typescript
// src/main.ts
import { serve } from "terrably";
import { MyProvider } from "./provider.js";

const dev = process.argv.includes("--dev") || process.env["TF_PLUGIN_DEBUG"] === "1";
serve(new MyProvider(), { dev }).catch(console.error);
```

Build and start –

```bash
pnpm exec tsc

TF_PLUGIN_MAGIC_COOKIE=d602bf8f470bc67ca7faa0386276bbdd4330efaf76d1a219cb4d6991ca9872b2 \
TF_PLUGIN_DEBUG=1 \
  node dist/src/main.js
```

The provider prints –

```
Dev mode — set this env var:

    export TF_REATTACH_PROVIDERS='{"registry.terraform.io/myorg/mycloud":{"Protocol":"grpc","ProtocolVersion":6,"Pid":12345,"Test":true,"Addr":{"Network":"unix","String":"/tmp/tf-js-provider-12345-...sock"}}}'
```

### Step 2 – Copy the export and run Terraform

In a separate shell –

```bash
export TF_REATTACH_PROVIDERS='...(paste from above)...'
terraform plan
```

Terraform connects to the already-running process. The provider process stays alive between Terraform commands, so you can run multiple `plan`/`apply` cycles without restarting it. Kill it with `Ctrl-C` when done.

### Attaching a Node.js debugger

```bash
TF_PLUGIN_MAGIC_COOKIE=d602bf8f470bc67ca7faa0386276bbdd4330efaf76d1a219cb4d6991ca9872b2 \
TF_PLUGIN_DEBUG=1 \
  node --inspect-brk dist/src/main.js
```

Open `chrome://inspect` or use the VS Code "Attach to Node Process" launch config. The process pauses until a debugger connects.

---

## Unit testing resource logic

Resource lifecycle methods (`create`, `read`, `update`, `delete`) are plain async functions. Test them directly without starting a gRPC server.

### Example using Node's built-in test runner

```typescript
// tests/server.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { MyCloudServer } from "../src/resources/server.js";
import { Diagnostics } from "terrably";
import type { CreateContext } from "terrably";

// Mock provider
const mockProvider = { apiBase: "https://api.mycloud.example" } as any;

test("create returns state with id", async () => {
  const resource = new MyCloudServer(mockProvider);
  const ctx: CreateContext = {
    diagnostics: new Diagnostics(),
    typeName: "mycloud_server",
  };

  const result = await resource.create(ctx, { name: "test", size: "small" });

  assert.ok(result["id"], "should have an id");
  assert.equal(result["name"], "test");
  assert.ok(!ctx.diagnostics.hasErrors());
});

test("read returns null for 404", async () => {
  const resource = new MyCloudServer(mockProvider);
  const ctx = { diagnostics: new Diagnostics(), typeName: "mycloud_server" };

  const result = await resource.read(ctx, { id: "nonexistent-id" });

  assert.equal(result, null);
});
```

Run with –

```bash
# First build so imports resolve
pnpm exec tsc

node --test dist/tests/*.test.js
```

### Testing with a real local API

Start your fake/real API server before running tests –

```bash
node dist/api-server/index.js &
node --test dist/tests/server.test.js
kill %1
```

---

## End-to-end tests

The E2E tests live in `tests/e2e.ts` and use the built-in **`node:test`** runner — no extra test framework needed.

Two suites are included –

| Suite | What runs | Binary |
|---|---|---|
| `provider: dev mode` | tsx + TF_REATTACH_PROVIDERS | Dev spawn (reference-provider only) |
| `provider: Node SEA binary` | self-contained native binary | `bin/` (reference-provider) |

### Prerequisites

```bash
# 1. Build the SDK
cd packages/sdk && pnpm exec tsc

# 2. Build the reference provider
cd packages/reference-provider && pnpm exec tsc

# 3. Build the SEA binary (required for the SEA suite)
pnpm run build:binary

# 4. Confirm terraform is in PATH
terraform version
```

### Run the tests

```bash
cd packages/reference-provider
node --test dist/tests/e2e.js
```

Or via the package script –

```bash
pnpm run test
```

---

## Troubleshooting

### "This binary is a Terraform provider plugin" on startup

The magic cookie is missing. Set it in your shell before running the provider –

```bash
export TF_PLUGIN_MAGIC_COOKIE=d602bf8f470bc67ca7faa0386276bbdd4330efaf76d1a219cb4d6991ca9872b2
```

Terraform sets this automatically when it spawns the provider; you only need it when starting the provider manually.

### "The provider does not support resource type X"

The resource type name Terraform uses is `{getModelPrefix()}_{resource.getName()}`. Check that –

- `getModelPrefix()` returns `"mycloud"` (no trailing underscore)
- `getName()` returns `"server"` (no prefix)
- Combined – `"mycloud_server"` matches what you wrote in `main.tf`

### proto files not found at runtime

The SDK loads `tfplugin6.proto` at runtime from `packages/sdk/proto/`. If you copied the SDK's `dist/` somewhere without the `proto/` directory, they need to travel together. The `proto/` directory must exist two levels above `dist/src/serve.js`, i.e. at `<sdk-root>/proto/`.

### gRPC "transport: Error while dialing"

The Unix socket path changed between runs. This happens if you restart the provider in dev mode without updating `TF_REATTACH_PROVIDERS`. Copy the new export from the provider's stdout each time you restart it.

### Terraform state becomes inconsistent after a schema change

If you add or rename attributes without implementing `upgrade()`, Terraform may fail to read old state. Either –

- Increment `version` in your `Schema` constructor and implement `upgrade()` to map old attribute names to new ones
- Or run `terraform state rm <resource>` to remove the old state and re-create the resource
