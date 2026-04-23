# terrably

Build Terraform & OpenTofu providers in TypeScript.

---

## Install

```bash
pnpm add terrably
```

The package ships the `terrably` CLI, which scaffolds projects, builds standalone binaries, checks your provider, and packages releases.

---

## CLI

```
terrably new <provider-name> [path]    Scaffold a new provider project
terrably build                         Compile + bundle + produce a shippable binary
terrably check                         Run correctness checks against the provider
terrably publish                       Package, sign, and upload a release
```

---

## Quick start — build your first provider in 10 minutes

### 0. Prerequisites

| Tool | Version |
|---|---|
| Node.js | ≥ 22 |
| Terraform CLI | ≥ 1.0 (`brew install terraform`) |

### 1. Scaffold a new project

```bash
npx terrably new mycloud
cd terraform-provider-mycloud
npm install
```

This creates a fully-wired starter project –

```
terraform-provider-mycloud/
  src/
    provider.ts        Provider class
    resources/
      example.ts       Stub resource
    main.ts            Entry point (calls serve())
  tsconfig.json
  package.json
```

### 2. Implement a resource

Every resource is a class implementing the `Resource` interface –

```typescript
// src/resources/server.ts
import { types, Attribute, Schema } from "terrably";
import type { Resource, CreateContext, ReadContext, UpdateContext, DeleteContext, Provider, State } from "terrably";

export class MyCloudServer implements Resource {
  constructor(private readonly provider: MyCloudProvider) {}

  getName() { return "server"; } // → "mycloud_server" in Terraform

  getSchema(): Schema {
    return new Schema([
      new Attribute("id",         types.string(), { computed: true }),
      new Attribute("name",       types.string(), { required: true }),
      new Attribute("region",     types.string(), { required: true }),
      new Attribute("ip_address", types.string(), { computed: true }),
    ]);
  }

  async create(ctx: CreateContext, planned: State): Promise<State> {
    const resp = await fetch(`${this.provider.apiBase}/servers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: planned["name"], region: planned["region"] }),
    });
    if (!resp.ok) { ctx.diagnostics.addError("create failed", await resp.text()); return planned; }
    return resp.json();
  }

  async read(_ctx: ReadContext, current: State): Promise<State | null> {
    const resp = await fetch(`${this.provider.apiBase}/servers/${current["id"]}`);
    if (resp.status === 404) return null;
    return resp.json();
  }

  async update(ctx: UpdateContext, prior: State, planned: State): Promise<State> {
    const resp = await fetch(`${this.provider.apiBase}/servers/${prior["id"]}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: planned["name"] }),
    });
    if (!resp.ok) { ctx.diagnostics.addError("update failed", await resp.text()); return prior; }
    return resp.json();
  }

  async delete(_ctx: DeleteContext, current: State): Promise<void> {
    await fetch(`${this.provider.apiBase}/servers/${current["id"]}`, { method: "DELETE" });
  }
}
```

### 3. Implement the provider

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

  getResources():   ResourceClass[]   { return [MyCloudServer]; }
  getDataSources(): DataSourceClass[] { return []; }
  newResource(cls:   ResourceClass):   Resource   { return new cls(this); }
  newDataSource(cls: DataSourceClass): DataSource { return new cls(this); }
}
```

### 4. Entry point

```typescript
// src/main.ts
import { serve } from "terrably";
import { MyCloudProvider } from "./provider.js";

serve(new MyCloudProvider());
```

### 5. Build the provider binary

```bash
npx terrably build
# → bin/terraform-provider-mycloud  (~130 MB, Node.js runtime embedded)
```

`terrably build` compiles TypeScript, bundles with esbuild, and produces a single **Node.js Single Executable Application (SEA)** binary. Operators do not need Node.js installed.

### 6. Verify the build

```bash
npx terrably check
```

Runs the provider binary through its gRPC lifecycle (GetProviderSchema → ValidateProviderConfig → ConfigureProvider) and reports any mismatches between your schema and Terraform's expectations. Pass `--terraform` to also run `terraform validate`.

### 7. Test locally with dev_overrides

```bash
# Tell Terraform to use your local binary
cat >> ~/.terraformrc <<'EOF'
provider_installation {
  dev_overrides {
    "myorg/mycloud" = "/absolute/path/to/bin"
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

With `dev_overrides` you skip `terraform init` — Terraform always uses your local binary.

---

## Structured logging

Terrably uses [pino](https://getpino.io) to emit structured logs on `stderr` in a format Terraform's logging pipeline (`TF_LOG`) understands –

```typescript
import { createLogger } from "terrably";

const log = createLogger("provider");

// Inside configure():
log.info("provider configured", { endpoint: config["api_url"] });
// stderr → {"@level":"info","@timestamp":"...","@module":"provider","@message":"provider configured","endpoint":"..."}
```

```bash
TF_LOG_PROVIDER=DEBUG terraform apply   # show provider logs only
TF_LOG=TRACE terraform apply            # show everything
```

See [Structured logging](docs/api-reference.md#structured-logging) in the API reference for the full guide.

---

## Publishing to the Terraform Registry

### 1. Build per-platform binaries (CI matrix)

Node.js SEA does not support cross-compilation. Use a CI matrix to build natively on each platform and rename each binary with its platform suffix –

```
bin/
  terraform-provider-mycloud_linux_amd64
  terraform-provider-mycloud_linux_arm64
  terraform-provider-mycloud_darwin_amd64
  terraform-provider-mycloud_darwin_arm64
  terraform-provider-mycloud_windows_amd64.exe
```

### 2. Package, sign, and upload

```bash
# Signs SHA256SUMS with GPG and creates a GitHub Release with all assets
GPG_FINGERPRINT=you@example.com \
GITHUB_TOKEN=${{ secrets.GITHUB_TOKEN }} \
  npx terrably publish --release-version 1.0.0 --github-release
```

`terrably publish` creates the exact layout the Terraform Registry requires:

```
release/
  terraform-provider-mycloud_1.0.0_linux_amd64.zip
  terraform-provider-mycloud_1.0.0_darwin_arm64.zip
  ...one zip per platform...
  terraform-provider-mycloud_1.0.0_manifest.json
  terraform-provider-mycloud_1.0.0_SHA256SUMS
  terraform-provider-mycloud_1.0.0_SHA256SUMS.sig
```

See the **[Distribution guide](docs/distribution.md)** for the complete workflow: GPG key setup, the full GitHub Actions YAML, and registry connection steps.

---

## Project docs

- [API reference](docs/api-reference.md) — every type, interface, and function exported by `terrably`
- [Local testing guide](docs/local-testing.md) — detailed workflows for iterating and debugging
- [Distribution guide](docs/distribution.md) — building binaries and publishing to the Terraform Registry
