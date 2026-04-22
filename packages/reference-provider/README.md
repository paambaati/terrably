# reference-provider

A working Terraform provider written in TypeScript using `terrably`, targeting a fake "DummyCloud" REST API.

## Resource schema

```hcl
resource "dummycloud_server" "example" {
  name = "my-server"   # required
  size = "small"       # required — "small" | "medium" | "large"
  # computed:
  # id, status, created_at
}
```

## Running the provider manually

```bash
# Build
pnpm exec tsc

# Start the fake API
node dist/api-server/index.js &

# Start the provider in dev mode
TF_PLUGIN_MAGIC_COOKIE=d602bf8f470bc67ca7faa0386276bbdd4330efaf76d1a219cb4d6991ca9872b2 \
TF_PLUGIN_DEBUG=1 \
  node dist/src/main.js
# → prints: export TF_REATTACH_PROVIDERS='...'

# In a separate shell, set that env var and run Terraform
export TF_REATTACH_PROVIDERS='...'
terraform -chdir=tests/fixtures init
terraform -chdir=tests/fixtures apply
```

## Running E2E tests

> Requires `terraform` CLI in PATH.

```bash
pnpm exec tsc
node dist/tests/e2e.js
```
