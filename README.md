# terrably

Write Terraform providers in TypeScript (or plain JavaScript). The framework speaks the native Terraform Plugin Protocol v6 (tfplugin6) over gRPC — the same protocol used by official Go providers — so providers built with this SDK work with every Terraform CLI ≥ 1.0 without any wrappers or shims.

---

## Repository layout

```
packages/
  sdk/                  terrably — the framework (publish this)
    src/
      types.ts          TfType system (string, number, bool, list, set, map, …)
      schema.ts         Attribute, NestedBlock, Block, Schema
      interfaces.ts     Provider / Resource / DataSource interfaces + context objects
      encoding.ts       msgpack ↔ State encode/decode
      servicer.ts       gRPC handler bridge
      serve.ts          Server startup + go-plugin handshake
    proto/              tfplugin6.proto + go-plugin side-channel protos

  example-provider/     Minimal copy-pasteable starting point (copy this to write your own)
    src/
      provider.ts       ExampleProvider skeleton
      resources/
        item.ts         example_item resource stub
      main.ts           Entry point
    scripts/
      build-sea.mjs     Builds a self-contained SEA binary
    bin/                SEA binary output after `pnpm build:sea`
    tf-workspace/       Sample Terraform config

  reference-provider/   Full working provider for a toy "DummyCloud" API (used by E2E tests)
    api-server/         Tiny in-memory Hono REST API (the fake cloud)
    src/
      provider.ts       DummyCloudProvider
      resources/
        server.ts       dummycloud_server resource
      main.ts           Entry point
    tests/
      e2e.ts            Full plan/apply/destroy E2E test suite
    tf-workspace/       Terraform config that exercises the provider
```

---

## Quick start — build your first provider in 10 minutes

### 0. Prerequisites

| Tool | Version |
|---|---|
| Node.js | ≥ 22 |
| pnpm | ≥ 9 (`npm i -g pnpm`) |
| Terraform CLI | ≥ 1.0 (`brew install terraform`) |

### 1. Create your project

```bash
mkdir terraform-provider-mycloud
cd terraform-provider-mycloud
pnpm init
```

### 2. Install the SDK

```bash
# From npm (once published):
pnpm add terrably

# Or link directly from this monorepo during development:
pnpm add terrably@workspace:*
```

### 3. Implement a resource

Every resource is a class that implements the `Resource` interface. The only required methods are `getName`, `getSchema`, `create`, `read`, `update`, and `delete`.

```typescript
// src/resources/server.ts
import { types, Attribute, Schema } from "terrably";
import type { Resource, CreateContext, ReadContext, UpdateContext, DeleteContext, Provider, State } from "terrably";

export class MyCloudServer implements Resource {
  private readonly apiBase: string;

  // The provider is injected so resources can access configuration
  constructor(provider: Provider) {
    this.apiBase = (provider as any).apiBase ?? "https://api.mycloud.example";
  }

  getName(): string {
    return "server"; // → resource type "mycloud_server" in Terraform
  }

  getSchema(): Schema {
    return new Schema([
      new Attribute("id",         types.string(), { computed: true }),
      new Attribute("name",       types.string(), { required: true }),
      new Attribute("region",     types.string(), { required: true }),
      new Attribute("size",       types.string(), { optional: true }),
      new Attribute("ip_address", types.string(), { computed: true }),
    ]);
  }

  async create(ctx: CreateContext, planned: State): Promise<State> {
    const resp = await fetch(`${this.apiBase}/servers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: planned["name"], region: planned["region"], size: planned["size"] }),
    });
    if (!resp.ok) {
      ctx.diagnostics.addError("Failed to create server", await resp.text());
      return planned;
    }
    return resp.json(); // { id, name, region, size, ip_address }
  }

  async read(_ctx: ReadContext, current: State): Promise<State | null> {
    const resp = await fetch(`${this.apiBase}/servers/${current["id"]}`);
    if (resp.status === 404) return null; // signals resource was deleted externally
    return resp.json();
  }

  async update(ctx: UpdateContext, prior: State, planned: State): Promise<State> {
    const resp = await fetch(`${this.apiBase}/servers/${prior["id"]}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: planned["name"], size: planned["size"] }),
    });
    if (!resp.ok) {
      ctx.diagnostics.addError("Failed to update server", await resp.text());
      return prior;
    }
    return resp.json();
  }

  async delete(_ctx: DeleteContext, current: State): Promise<void> {
    await fetch(`${this.apiBase}/servers/${current["id"]}`, { method: "DELETE" });
  }
}
```

### 4. Implement the provider

```typescript
// src/provider.ts
import { types, Attribute, Schema, Diagnostics } from "terrably";
import type { Provider, Resource, DataSource, ResourceClass, DataSourceClass, State } from "terrably";
import { MyCloudServer } from "./resources/server.js";

export class MyCloudProvider implements Provider {
  apiBase = "https://api.mycloud.example";

  getFullName()    { return "registry.terraform.io/myorg/mycloud"; }
  getModelPrefix() { return "mycloud"; }

  getProviderSchema(_diags: Diagnostics): Schema {
    return new Schema([
      new Attribute("api_url", types.string(), { optional: true }),
      new Attribute("token",   types.string(), { optional: true, sensitive: true }),
    ]);
  }

  validateConfig(_diags: Diagnostics, _config: State): void {}

  configure(_diags: Diagnostics, config: State): void {
    if (typeof config["api_url"] === "string") this.apiBase = config["api_url"];
  }

  getResources():    ResourceClass[]    { return [MyCloudServer]; }
  getDataSources():  DataSourceClass[]  { return []; }
  newResource(cls:   ResourceClass):    Resource    { return new cls(this); }
  newDataSource(cls: DataSourceClass):  DataSource  { return new cls(this); }
}
```

### 5. Add the entry point

```typescript
// src/main.ts
import { serve } from "terrably";
import { MyCloudProvider } from "./provider.js";

serve(new MyCloudProvider()).catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
```

### 6. Build the provider binary

Build a **self-contained SEA binary** so Terraform can invoke your provider without needing Node.js installed on the target machine:

```bash
# Requires Node.js >= 22
node scripts/build-sea.mjs --name mycloud --out bin/
# → bin/terraform-provider-mycloud  (~130 MB, embeds Node.js runtime)
```

Or add it as a package script and run:

```bash
pnpm build:sea
```

### 7. Build and test locally

```bash
pnpm exec tsc

# Tell Terraform to use your local binary instead of downloading from the registry
cat > ~/.terraformrc <<'EOF'
provider_installation {
  dev_overrides {
    "myorg/mycloud" = "/absolute/path/to/terraform-provider-mycloud/bin"
  }
  direct {}
}
EOF

# Write a config
cat > main.tf <<'EOF'
terraform {
  required_providers {
    mycloud = { source = "myorg/mycloud" }
  }
}
provider "mycloud" {}
resource "mycloud_server" "example" {
  name   = "hello"
  region = "us-east-1"
}
EOF

terraform plan
terraform apply
terraform destroy -auto-approve
```

With `dev_overrides` you skip `terraform init` and Terraform always uses your local binary. Plan/apply/destroy work exactly as with any published provider.

---

## Project docs

- [SDK API reference](docs/api-reference.md) — every type, interface and function exported by `terrably`
- [Local testing guide](docs/local-testing.md) — detailed workflows for iterating and debugging your provider
- [Distribution guide](docs/distribution.md) — building standalone binaries with Node.js SEA and publishing to the Terraform Registry

---

## How it works

Terraform communicates with providers over **gRPC** using the [Plugin Protocol v6](https://developer.hashicorp.com/terraform/plugin/how-terraform-works). This SDK:

1. Starts a Unix-socket gRPC server serving the `tfplugin6.Provider` service plus two required side-channel services (`GRPCController`, `GRPCStdio`).
2. Negotiates a self-signed mTLS certificate and prints the six-field **go-plugin handshake** on stdout so Terraform can find and trust the server.
3. Dispatches each RPC (GetProviderSchema, PlanResourceChange, ApplyResourceChange, ReadResource, …) to your TypeScript classes.
4. Encodes/decodes resource state using **msgpack** (Terraform's wire format), including the `Unknown` sentinel for values not yet known at plan time.

No Go toolchain is required. Providers run entirely in Node.js (≥ 22).

---

## Distributing your provider

Providers must be distributed as **self-contained binaries** — no Node.js or bash needed on the operator's machine. Node.js Single Executable Applications (SEA) embed the runtime directly into the binary.

### Build a standalone binary (Node.js ≥ 22)

```bash
# Requires Node.js >= 22
# One-shot build — produces bin/terraform-provider-mycloud
node scripts/build-sea.mjs --name mycloud --out bin/
```

The script:
1. Bundles your code and all dependencies into a single CJS file
2. Embeds the three `.proto` files as **SEA assets** (extracted to a temp dir at startup)
3. Runs `node --build-sea` to inject the bundle into a copy of the Node.js runtime
4. Signs the binary on macOS with `codesign --sign -`

Output is a single native binary (~95 MB) with no external runtime dependency.

### Publish to the Terraform Registry

The registry requires per-platform zip archives, a SHA256SUMS file, and a GPG signature — all created by a GitHub Actions release workflow that builds natively on each platform:

```
git tag v1.0.0
git push origin v1.0.0
# → GitHub Actions builds darwin_arm64, darwin_amd64, linux_amd64,
#   linux_arm64 and windows_amd64 binaries, zips them, signs the
#   checksum file, and creates a GitHub release.
# → The Terraform Registry automatically indexes the new release.
```

See the **[Distribution guide](docs/distribution.md)** for the complete workflow: GPG key setup, required artifact naming, the full GitHub Actions YAML, and registry connection steps.
