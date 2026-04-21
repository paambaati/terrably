# Distributing your provider

This guide explains how to produce a standalone binary from your TypeScript provider and publish it to the Terraform Registry so Terraform users can install it with a normal `required_providers` block.

---

## Why distribute as a binary?

Operators who consume your provider should not need to install Node.js. A **Node.js Single Executable Application (SEA)** bundles the JS runtime into a single native binary — just like a Go provider binary — so Terraform can launch it directly.

---

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | ≥ 22 | Required for stable `--build-sea` support |
| GPG | any | For Terraform Registry signature |
| Terraform CLI | ≥ 1.0 | For local smoke-test |

---

## Building a binary locally

### 1. Build the binary

```bash
# From your provider's root directory:
pnpm build:sea
# or directly:
node scripts/build-sea.mjs --name mycloud --out bin/
```

The script:
1. Bundles all JS + `node_modules` into a single CJS file
2. Generates a SEA entry-point that extracts the `.proto` files from embedded assets into a temp directory at startup (so `@grpc/proto-loader` can read them)
3. Writes a `sea-config.json` referencing the three proto files as assets
4. Runs `node --build-sea sea-config.json` to produce the final binary
5. On macOS, runs `codesign --sign -` (ad-hoc signature)

Output: `bin/terraform-provider-mycloud`

Size is typically 120–130 MB (the Node.js runtime is embedded).

### 3. Smoke-test the binary

```bash
# The binary must receive the magic cookie to start
TF_PLUGIN_MAGIC_COOKIE=d602bf8f470bc67ca7faa0386276bbdd4330efaf76d1a219cb4d6991ca9872b2 \
  ./bin/terraform-provider-mycloud
# → prints the go-plugin handshake line and blocks
```

### 4. Use via dev_overrides

Point your `.terraformrc` at the `bin/` directory and run `terraform plan` normally. The binary behaves identically to the Node.js wrapper script.

---

## How proto files are handled inside the SEA

`@grpc/proto-loader` reads `.proto` files from disk. Inside a SEA only built-in Node modules are accessible by default. The build script works around this by:

1. Embedding the three proto files as **SEA assets** (via the `assets` field in `sea-config.json`)
2. Generating a preamble in the bundled entry-point that, at startup, extracts those assets to a temporary directory and passes it to `serve()` via the `protoDir` option
3. Cleaning up the temp directory on process exit

The `protoDir` option is exposed on `ServeOptions` for exactly this use case — if you have a custom build pipeline, you can pass it directly:

```typescript
import { serve } from "@tfjs/sdk";
import { MyProvider } from "./provider.js";

// protoDir is set by the SEA preamble via TF_PROTO_DIR env var,
// or you can pass it explicitly:
serve(new MyProvider(), { protoDir: process.env["TF_PROTO_DIR"] });
```

---

## Publishing to the Terraform Registry

The [Terraform Registry](https://registry.terraform.io) distributes providers as GitHub releases. The process is:

```
GPG key → GitHub repo → tag a release → registry indexes automatically
```

### Step 1: Repository naming

Your GitHub repository **must** be named `terraform-provider-{name}`, e.g.:

```
github.com/acme/terraform-provider-mycloud
```

### Step 2: Register a GPG key

Generate a GPG key (4096-bit RSA, no expiry) and add the public key to your Terraform Registry account:

```bash
gpg --full-generate-key          # choose RSA 4096, no expiry
gpg --export --armor <KEY_ID>    # copy the public key block
```

Go to [registry.terraform.io → your namespace → GPG Keys](https://registry.terraform.io/settings/gpg-keys) and paste it. Store the private key as a GitHub Actions secret named `GPG_PRIVATE_KEY` and the passphrase as `GPG_PASSPHRASE`.

### Step 3: Add the registry manifest

Each zip artifact must contain a `terraform-registry-manifest.json`:

```json
{
  "version": 1,
  "metadata": {
    "protocol_versions": ["6.0"]
  }
}
```

`"6.0"` matches tfplugin6, which is what this SDK implements.

### Step 4: Understand the required release artifacts

For a version `v1.2.3` and provider named `mycloud`, the GitHub release must have:

| File | Contents |
|---|---|
| `terraform-provider-mycloud_1.2.3_linux_amd64.zip` | binary + manifest |
| `terraform-provider-mycloud_1.2.3_linux_arm64.zip` | binary + manifest |
| `terraform-provider-mycloud_1.2.3_darwin_amd64.zip` | binary + manifest |
| `terraform-provider-mycloud_1.2.3_darwin_arm64.zip` | binary + manifest |
| `terraform-provider-mycloud_1.2.3_windows_amd64.zip` | binary + manifest |
| `terraform-provider-mycloud_1.2.3_SHA256SUMS` | sha256 of every zip |
| `terraform-provider-mycloud_1.2.3_SHA256SUMS.sig` | GPG signature of the above |

The **binary inside each zip** must be named `terraform-provider-mycloud_v1.2.3` (no `.exe` extension, even on Windows — Terraform handles the extension itself).

### Step 5: GitHub Actions release workflow

Create `.github/workflows/release.yml` in your provider repository:

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write   # needed to create the GitHub release

jobs:
  build:
    name: Build (${{ matrix.os }})
    runs-on: ${{ matrix.runner }}
    strategy:
      matrix:
        include:
          - { os: linux,   arch: amd64, runner: ubuntu-latest,   ext: "" }
          - { os: linux,   arch: arm64, runner: ubuntu-24.04-arm, ext: "" }
          - { os: darwin,  arch: amd64, runner: macos-13,        ext: "" }
          - { os: darwin,  arch: arm64, runner: macos-14,        ext: "" }
          - { os: windows, arch: amd64, runner: windows-latest,  ext: ".exe" }

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Install dependencies
        run: npm ci
        # or: pnpm install

      - name: Build TypeScript
        run: npx tsc

      - name: Build SEA binary
        shell: bash
        run: |
          VERSION="${{ github.ref_name }}"        # e.g. v1.2.3
          VERSION_NUM="${VERSION#v}"              # e.g. 1.2.3
          PROVIDER_NAME="mycloud"
          BINARY="terraform-provider-${PROVIDER_NAME}_v${VERSION_NUM}"

          node scripts/build-sea.mjs --name "${PROVIDER_NAME}" --out staging/
          # Rename to the versioned name expected by the registry
          mv "staging/terraform-provider-${PROVIDER_NAME}${{ matrix.ext }}" \
             "staging/${BINARY}${{ matrix.ext }}"

          # Create the registry manifest
          cat > staging/terraform-registry-manifest.json <<'EOF'
          {"version":1,"metadata":{"protocol_versions":["6.0"]}}
          EOF

          # Zip: binary + manifest
          cd staging
          ZIP_NAME="terraform-provider-${PROVIDER_NAME}_${VERSION_NUM}_${{ matrix.os }}_${{ matrix.arch }}.zip"
          zip "${ZIP_NAME}" "${BINARY}${{ matrix.ext }}" terraform-registry-manifest.json
          echo "ZIP_NAME=${ZIP_NAME}" >> $GITHUB_ENV
          echo "ZIP_PATH=staging/${ZIP_NAME}" >> $GITHUB_ENV

      - name: Upload zip artifact
        uses: actions/upload-artifact@v4
        with:
          name: provider-${{ matrix.os }}-${{ matrix.arch }}
          path: staging/*.zip
          if-no-files-found: error

  release:
    name: Create GitHub Release
    needs: build
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Download all artifacts
        uses: actions/download-artifact@v4
        with:
          path: artifacts/
          merge-multiple: true

      - name: Compute SHA256SUMS
        run: |
          VERSION="${{ github.ref_name }}"
          VERSION_NUM="${VERSION#v}"
          PROVIDER_NAME="mycloud"
          SUMS_FILE="terraform-provider-${PROVIDER_NAME}_${VERSION_NUM}_SHA256SUMS"
          cd artifacts
          sha256sum *.zip > "${SUMS_FILE}"
          echo "SUMS_FILE=${SUMS_FILE}" >> $GITHUB_ENV

      - name: Sign SHA256SUMS with GPG
        env:
          GPG_PRIVATE_KEY: ${{ secrets.GPG_PRIVATE_KEY }}
          GPG_PASSPHRASE:  ${{ secrets.GPG_PASSPHRASE }}
        run: |
          echo "${GPG_PRIVATE_KEY}" | gpg --batch --import
          cd artifacts
          echo "${GPG_PASSPHRASE}" | gpg --batch --yes --passphrase-fd 0 \
            --detach-sign --armor "${SUMS_FILE}"

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          files: artifacts/*
          generate_release_notes: true
```

### Step 6: Connect to the Terraform Registry

1. Go to [registry.terraform.io](https://registry.terraform.io) → **Publish** → **Provider**
2. Select your GitHub organization and the `terraform-provider-mycloud` repository
3. The registry will detect your GPG key (from Step 2) and index the latest release
4. Future releases are picked up automatically when you push a new `v*` tag

### Step 7: Verify the published provider

```bash
# In a fresh directory, with no .terraformrc overrides:
cat > main.tf <<'EOF'
terraform {
  required_providers {
    mycloud = {
      source  = "acme/mycloud"
      version = "~> 1.0"
    }
  }
}
EOF

terraform init    # downloads and verifies the binary
terraform plan
```

---

## Platform support matrix

| Platform | Runner | SEA supported |
|---|---|---|
| Linux x86-64 | `ubuntu-latest` | ✅ |
| Linux arm64 | `ubuntu-24.04-arm` | ✅ |
| macOS arm64 (Apple Silicon) | `macos-14` | ✅ requires `codesign` |
| macOS x86-64 (Intel) | `macos-13` | ✅ requires `codesign` |
| Windows x86-64 | `windows-latest` | ✅ |
| Alpine Linux (musl) | — | ⚠️ untested (Node.js SEA uses glibc) |

> **Cross-compilation**: Node.js SEA does not support building for a different OS/arch on the same machine. Use the GitHub Actions matrix to build natively on each platform.

---

## Versioning and changelog

Follow the [Terraform provider versioning convention](https://developer.hashicorp.com/terraform/plugin/best-practices/versioning): `MAJOR.MINOR.PATCH` with a `v` prefix tag (`v1.0.0`).

Increment `MAJOR` for any breaking schema changes (removed attributes, type changes). Increment `MINOR` for new resources or attributes. Use `upgrade()` in resources to migrate old state when bumping the schema `version` field.
