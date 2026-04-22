# Distributing your provider

This guide explains how to build, package, sign, and publish a terrably-based
provider to the Terraform Registry so operators can install it with a normal
`required_providers` block.

---

## Table of contents

1. [Why distribute as a binary?](#why-distribute-as-a-binary)
2. [Prerequisites](#prerequisites)
3. [Build a binary locally](#build-a-binary-locally)
4. [Multi-platform release with `terrably publish`](#multi-platform-release)
5. [GitHub Actions release workflow](#github-actions-release-workflow)
6. [Connecting to the Terraform Registry](#connecting-to-the-terraform-registry)
7. [Platform support matrix](#platform-support-matrix)
8. [Versioning](#versioning)
9. [Schema changes and state migration](#publishing-a-new-version)

---

## Why distribute as a binary?

Operators who consume your provider should not need Node.js installed. A **Node.js Single Executable Application (SEA)** bundles the JS runtime into a single native binary — just like a Go provider — so Terraform can launch it directly.

---

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | ≥ 22 | Required for stable `--build-sea` support |
| terrably CLI | any | `npm i -g terrably` |
| GPG | any | To sign the release for the Terraform Registry |
| GitHub CLI (`gh`) | optional | Alternative to `--github-release` flag |
| Terraform CLI | ≥ 1.0 | For local smoke-tests |

---

## Build a binary locally

```bash
# From your provider root –
terrably build

# Output: bin/terraform-provider-mycloud  (120-130 MB, Node.js runtime embedded)
```

`terrably build` automatically –
1. Runs `tsc` to compile TypeScript.
2. Bundles with esbuild (single CJS file).
3. Generates a SEA entry-point that extracts the embedded `.proto` files into a temporary directory at startup.
4. Runs `node --build-sea` to produce the final binary.
5. On macOS, runs `codesign --sign -` (ad-hoc signature required for execution).

### Smoke-test the binary

```bash
TF_PLUGIN_MAGIC_COOKIE=d602bf8f470bc67ca7faa0386276bbdd4330efaf76d1a219cb4d6991ca9872b2 ./bin/terraform-provider-mycloud
# → prints the go-plugin handshake line and blocks
```

---

## Multi-platform release

### How multi-platform works

Node.js SEA does **not** support cross-compilation — a binary built on macOS will not run on Linux. The solution is a CI matrix that builds natively on each platform, then a single packaging step that assembles all binaries into the release assets the Terraform Registry requires.

```
CI matrix (one job per platform)
  └─ terrably build  →  bin/terraform-provider-mycloud{_os_arch}

Packaging job
  └─ terrably publish  →  release/
       terraform-provider-mycloud_1.0.0_linux_amd64.zip
       terraform-provider-mycloud_1.0.0_linux_arm64.zip
       terraform-provider-mycloud_1.0.0_darwin_amd64.zip
       terraform-provider-mycloud_1.0.0_darwin_arm64.zip
       terraform-provider-mycloud_1.0.0_windows_amd64.zip
       terraform-provider-mycloud_1.0.0_manifest.json
       terraform-provider-mycloud_1.0.0_SHA256SUMS
       terraform-provider-mycloud_1.0.0_SHA256SUMS.sig
```

### Required release asset layout

The Terraform Registry validates that each release has exactly this structure –

| File | Description |
|---|---|
| `terraform-provider-{name}_{ver}_{os}_{arch}.zip` | One zip per platform containing the binary |
| `terraform-provider-{name}_{ver}_manifest.json` | Protocol version declaration |
| `terraform-provider-{name}_{ver}_SHA256SUMS` | SHA-256 of every zip + manifest |
| `terraform-provider-{name}_{ver}_SHA256SUMS.sig` | Binary GPG detach-signature of the checksum file |

The binary **inside** each zip must be named `terraform-provider-{name}_v{ver}` (no OS/arch suffix, no `.exe` — Terraform appends `.exe` on Windows itself).

### `terrably publish`

`terrably publish` does all the packaging work – zipping, manifest generation, checksum computation, GPG signing, and optional GitHub Release creation.

```
terrably publish [options]

Options:
  --release-version <v>   Version (e.g. 1.2.3 or v1.2.3); defaults to version in package.json
  --name <n>              Provider short name (e.g. mycloud); defaults to package.json name
  --binaries-dir <dir>    Directory containing per-platform binaries  (default: bin/)
  --out <dir>             Output directory for release assets          (default: release/)
  --protocol-version <v>  Terraform protocol version: 5.0 or 6.0      (default: 6.0)
  --gpg-key <fp>          GPG key fingerprint/email for signing        (default: $GPG_FINGERPRINT)
  --github-release        Create GitHub Release and upload all assets  (requires $GITHUB_TOKEN)
  --draft                 Create the release as a draft
  --tag <tag>             Git tag name                                 (default: v{version})
```

**Binary naming convention** (`--binaries-dir`):
Files in the binaries directory must be named `terraform-provider-{name}_{os}_{arch}[.exe]`:

```
bin/
  terraform-provider-mycloud_linux_amd64
  terraform-provider-mycloud_linux_arm64
  terraform-provider-mycloud_linux_arm
  terraform-provider-mycloud_darwin_amd64
  terraform-provider-mycloud_darwin_arm64
  terraform-provider-mycloud_windows_amd64.exe
```

If only one binary is present with no platform suffix (e.g. the plain `terraform-provider-mycloud` produced by `terrably build`), it is treated as the current platform — useful for quick local testing.

### Local packaging workflow

```bash
# 1. Generate all per-platform binaries (see CI workflow below for automation)
#    Each CI job produces ONE binary named with its OS/arch suffix.
#    For a local single-platform test –
terrably build
mv bin/terraform-provider-mycloud bin/terraform-provider-mycloud_$(uname -s | tr '[:upper:]' '[:lower:]')_amd64

# 2. Package, sign, and preview locally (skips --github-release)
GPG_FINGERPRINT=your@email.com \
  terrably publish --release-version 1.0.0

# Output preview:
#   release/terraform-provider-mycloud_1.0.0_linux_amd64.zip    XX KB
#   release/terraform-provider-mycloud_1.0.0_manifest.json       0 KB
#   release/terraform-provider-mycloud_1.0.0_SHA256SUMS           0 KB
#   release/terraform-provider-mycloud_1.0.0_SHA256SUMS.sig       0 KB
```

---

## GitHub Actions release workflow

Create `.github/workflows/release.yml` in your provider repository. Replace `mycloud` with your provider's short name.

```yaml
name: Release

# Triggers on any tag matching v* (e.g. v1.0.0, v1.2.3-beta)
on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write   # needed to create the GitHub Release

env:
  PROVIDER_NAME: mycloud   # ← change this

jobs:
  # ── Build: one job per OS/arch, runs terrably build natively ─────────────
  build:
    name: Build (${{ matrix.os }}_${{ matrix.arch }})
    runs-on: ${{ matrix.runner }}
    strategy:
      matrix:
        include:
          # Primary targets (required for HCP Terraform compatibility)
          - { os: linux,   arch: amd64, runner: ubuntu-latest    }
          - { os: linux,   arch: arm64, runner: ubuntu-24.04-arm }
          - { os: darwin,  arch: amd64, runner: macos-13         }
          - { os: darwin,  arch: arm64, runner: macos-latest     }
          - { os: windows, arch: amd64, runner: windows-latest   }
          # Extended targets (optional)
          - { os: linux,   arch: arm,   runner: ubuntu-24.04-arm }
          - { os: linux,   arch: "386", runner: ubuntu-latest    }

    steps:
      - uses: actions/checkout@v6

      - uses: actions/setup-node@v6
        with:
          node-version: '22'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Build SEA binary
        shell: bash
        run: |
          npx terrably build --name "$PROVIDER_NAME"

      - name: Rename binary with platform suffix
        shell: bash
        run: |
          EXT=""
          if [ "${{ matrix.os }}" = "windows" ]; then EXT=".exe"; fi
          mv "bin/terraform-provider-${PROVIDER_NAME}${EXT}" \
             "bin/terraform-provider-${PROVIDER_NAME}_${{ matrix.os }}_${{ matrix.arch }}${EXT}"

      - name: Upload binary artifact
        uses: actions/upload-artifact@v4
        with:
          name: binary-${{ matrix.os }}-${{ matrix.arch }}
          path: bin/terraform-provider-${{ env.PROVIDER_NAME }}_${{ matrix.os }}_${{ matrix.arch }}*
          if-no-files-found: error
          retention-days: 1

  # ── Release: collect all binaries, package, sign, publish ────────────────
  release:
    name: Publish to GitHub Releases
    needs: build
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Download all platform binaries
        uses: actions/download-artifact@v4
        with:
          path: bin/
          pattern: binary-*
          merge-multiple: true

      - name: Import GPG key
        run: |
          echo "${{ secrets.GPG_PRIVATE_KEY }}" | gpg --batch --import
          # Extract fingerprint for signing
          FP=$(gpg --list-secret-keys --with-colons | awk -F: '/^fpr/{print $10; exit}')
          echo "GPG_FINGERPRINT=${FP}" >> "$GITHUB_ENV"

      - name: Package, sign, and publish release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          VERSION="${{ github.ref_name }}"
          npx terrably publish \
            --release-version "${VERSION}" \
            --gpg-key         "${GPG_FINGERPRINT}" \
            --github-release
```

### Required GitHub Actions secrets

| Secret | Description |
|---|---|
| `GPG_PRIVATE_KEY` | ASCII-armored private key: `gpg --armor --export-secret-keys <ID>` |
| `PASSPHRASE` | GPG key passphrase (omit step if the key has no passphrase) |

`GITHUB_TOKEN` is injected automatically by GitHub Actions — no manual setup needed.

### Testing the workflow

```bash
# Tag and push to trigger the workflow
git tag v1.0.0
git push origin v1.0.0
```

Once the workflow completes, go to your repository's **Releases** page to verify
all assets were uploaded correctly.

---

## Connecting to the Terraform Registry

### 1. Repository naming

Your GitHub repository **must** be named `terraform-provider-{name}` (all lowercase) –

```
github.com/acme/terraform-provider-mycloud
```

### 2. Generate and register a GPG key

```bash
# Generate a 4096-bit RSA key (ECC keys are not accepted by the registry)
gpg --full-generate-key
# Choose: RSA and RSA, 4096 bits, key does not expire

# Export the public key
gpg --armor --export your@email.com
```

Go to [registry.terraform.io → Settings → GPG Keys](https://registry.terraform.io/settings/gpg-keys) and paste the public key block. Add it under the namespace that owns your provider.

### 3. Publish from the registry UI

1. Go to [registry.terraform.io → Publish → Provider](https://registry.terraform.io/publish/provider).
2. Select your GitHub organisation and the `terraform-provider-mycloud` repository.
3. The registry creates a webhook — future `v*` releases are indexed automatically.

### 4. Verify the published provider

```hcl
# main.tf
terraform {
  required_providers {
    mycloud = {
      source  = "acme/mycloud"
      version = "~> 1.0"
    }
  }
}
```

```bash
terraform init    # downloads and verifies the binary
terraform plan
```

---

## Platform support matrix

Terrably follows the [Terraform Registry recommended combinations](https://developer.hashicorp.com/terraform/registry/providers/os-arch) –

| Platform | GitHub Actions runner | Priority |
|---|---|---|
| Linux x86-64 (`linux_amd64`) | `ubuntu-latest` | **Required** for HCP Terraform |
| Linux arm64 (`linux_arm64`) | `ubuntu-24.04-arm` | Recommended |
| Linux armv6 (`linux_arm`) | `ubuntu-24.04-arm` | Recommended |
| Linux 386 (`linux_386`) | `ubuntu-latest` | Optional |
| macOS arm64 (`darwin_arm64`) | `macos-latest` | Recommended |
| macOS x86-64 (`darwin_amd64`) | `macos-13` | Recommended |
| Windows x86-64 (`windows_amd64`) | `windows-latest` | Recommended |
| Windows 386 (`windows_386`) | `windows-latest` | Optional |
| FreeBSD (`freebsd_*`) | self-hosted | Optional |

> **Cross-compilation is not supported.** A Node.js SEA binary is platform-native.
> Each platform requires its own runner in the CI matrix.

---

## How proto files are handled inside the SEA

`@grpc/proto-loader` reads `.proto` files from disk. Inside a SEA only built-in Node modules are accessible. `terrably build` works around this by –

1. Embedding the three proto files as **SEA assets** (via the `assets` field in `sea-config.json`)
2. Generating a preamble in the entry-point that extracts those assets to a temporary directory at startup and sets `TF_PROTO_DIR`.
3. Cleaning up the temporary directory on process exit.

If you have a custom build pipeline, pass `protoDir` explicitly –

```typescript
import { serve } from "terrably";
import { MyProvider } from "./provider.js";

serve(new MyProvider(), { protoDir: process.env["TF_PROTO_DIR"] });
```

---

## Versioning

Follow [Semantic Versioning](https://semver.org/) with a `v` prefix (`v1.0.0`).

| Change | Bump |
|---|---|
| Breaking schema change (removed attribute, type change) | `MAJOR` |
| New resource, data source, or attribute | `MINOR` |
| Bug fix, performance improvement | `PATCH` |
| Pre-release (`-alpha.1`, `-beta.2`) | Explicit opt-in via version constraint |

When bumping the `version` field on a resource `Schema`, implement `upgrade()` to migrate old state.

---

### Schema version changes and state migration

Every resource's `Schema` carries an integer `version` (default `0`). When
Terraform refreshes or plans a resource, it compares the schema version stored
in state against the current one. If they differ, it calls `Resource.upgrade()`
for each intervening version until the state is current.

**Increment the version whenever the shape of state changes**

```typescript
// Before (v0)
getSchema(): Schema {
  return new Schema([
    new Attribute("id",     types.string(), { computed: true }),
    new Attribute("zone",   types.string(), { required: true }),  // ← will be renamed
    new Attribute("size_gb", types.number(), { required: true }),
  ], [], 0);  // ← schema version 0
}

// After (v1) — "zone" renamed to "availability_zone"
getSchema(): Schema {
  return new Schema([
    new Attribute("id",                  types.string(), { computed: true }),
    new Attribute("availability_zone",   types.string(), { required: true }),
    new Attribute("size_gb",             types.number(), { required: true }),
  ], [], 1);  // ← schema version bumped to 1
}
```

#### Implementing `upgrade()`

`upgrade()` receives the raw stored state and the version it was saved at.
Return the state reshaped to match the **current** schema.

```typescript
upgrade(ctx: UpgradeContext, version: number, old: State): State {
  // Always use a switch so you can chain future upgrades safely
  switch (version) {
    case 0: {
      // v0 → v1: rename "zone" to "availability_zone"
      const { zone, ...rest } = old;
      return {
        ...rest,
        availability_zone: zone,
      };
    }
    default:
      // Should never happen — terrably only calls upgrade() for older versions
      ctx.diagnostics.addError(
        "Unknown schema version",
        `Cannot upgrade state from version ${version}.`,
      );
      return old;
  }
}
```

#### Chaining multiple version upgrades

If you have already shipped `v1` and now need `v2`, add a new `case` and bump `Schema` to `2`. Terraform will call `upgrade()` once per stored version, so a resource saved at `v0` will go through `case 0` then `case 1` in sequence.

```typescript
upgrade(ctx: UpgradeContext, version: number, old: State): State {
  switch (version) {
    case 0: {
      // v0 → v1: rename "zone" → "availability_zone"
      const { zone, ...rest } = old;
      return this.upgrade(ctx, 1, { ...rest, availability_zone: zone });
    }
    case 1: {
      // v1 → v2: split "size_gb" into "disk_size_gb" + "disk_type"
      const { size_gb, ...rest } = old;
      return {
        ...rest,
        disk_size_gb: size_gb,
        disk_type: "ssd",   // default for previously created resources
      };
    }
    default:
      ctx.diagnostics.addError(
        "Unknown schema version",
        `Cannot upgrade state from version ${version}.`,
      );
      return old;
  }
}
```

---

### Common migration patterns

#### Rename an attribute

```typescript
case 0: {
  const { old_name, ...rest } = old;
  return { ...rest, new_name: old_name };
}
```

#### Remove an attribute (drop from state)

```typescript
case 0: {
  const { deprecated_field, ...rest } = old;  // eslint-disable-line @typescript-eslint/no-unused-vars
  return rest;
}
```

#### Change a type — string to number

```typescript
case 0: {
  return {
    ...old,
    // stored as "42", needs to become 42
    port: Number(old["port"] as string),
  };
}
```

#### Split one attribute into two

```typescript
case 0: {
  const { endpoint, ...rest } = old;
  const url = new URL(endpoint as string);
  return {
    ...rest,
    host: url.hostname,
    port: Number(url.port) || 443,
  };
}
```

#### Add a new required attribute to existing resources

Don't bump schema version for this. Instead, declare the attribute as `optional: true, computed: true` with a sensible `default`. Existing state objects will read back `null`; your `read()` can detect `null` and backfill the value from the live API on the next refresh, which Terraform then records.

```typescript
// NEW attribute — use optional+computed so existing state is valid
new Attribute("disk_type", types.string(), {
  optional: true,
  computed: true,
  default: "ssd",
  description: "Disk type for the volume. Defaults to `ssd`.",
})
```

```typescript
read(ctx: ReadContext, current: State): State {
  const live = await this.api.getServer(current["id"] as string);
  return {
    ...current,
    ...live,
    // Backfill on first read of a resource created before this attribute existed
    disk_type: live.diskType ?? current["disk_type"] ?? "ssd",
  };
}
