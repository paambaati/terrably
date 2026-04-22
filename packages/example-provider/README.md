# example-provider

A minimal copy-pasteable starting point for writing a Terraform provider with `terrably`.

## Structure

```
src/
  main.ts              Entry point — calls serve()
  provider.ts          ExampleProvider — declares config schema, lists resources
  resources/
    item.ts            example_item resource — create / read / update / delete
scripts/
  build-sea.mjs        Builds a self-contained SEA binary (no Node.js needed on target)
bin/
  terraform-provider-example   SEA binary output (created by build:sea; git-ignored)
tf-workspace/
  main.tf              Sample Terraform config that exercises the provider
  .terraformrc         Dev override so Terraform finds the local binary
```

## Quickstart

```bash
# 1. Install dependencies
pnpm install

# 2. Build the SEA binary  (requires Node.js >= 22)
pnpm build:sea
# → bin/terraform-provider-example  (~130 MB, self-contained, no Node.js needed)

# 3. Try it with Terraform
cd tf-workspace
TF_CLI_CONFIG_FILE=.terraformrc terraform plan
TF_CLI_CONFIG_FILE=.terraformrc terraform apply -auto-approve
```

## Why a SEA binary?

The `bin/` directory holds the output of `node --build-sea`.  This embeds the
Node.js runtime into the binary so the machine running `terraform apply` does not
need Node.js installed.  A bash wrapper script is **not** used because it requires
both bash and Node.js on the target — the same portability problems that SEA solves.

## Customising

1. **Rename the provider** — update `getFullName()` and `getModelPrefix()` in
   `src/provider.ts`, then pass `--name mycloud` to `build-sea.mjs`.
2. **Add attributes** — add `Attribute` entries to `getSchema()` in your resource.
3. **Wire up real API calls** — replace the placeholder logic in `create`, `read`,
   `update`, `delete` with real HTTP (or SDK) calls.
4. **Add more resources** — duplicate `src/resources/item.ts`, register the new
   class in `getResources()`.
