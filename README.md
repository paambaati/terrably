# terrably

Build Terraform & OpenTofu providers in TypeScript.

**[Read full documentation →](https://paambaati.github.io/terrably/)**

---

## Install

```bash
pnpm add terrably
```

The package ships the `terrably` CLI, which scaffolds projects, builds standalone binaries, checks your provider, and packages releases.

---

## Quick start

```bash
# Scaffold a new provider
npx terrably new mycloud
cd terraform-provider-mycloud
npm install

# Build → produces bin/terraform-provider-mycloud (~130 MB, Node.js embedded)
npx terrably build

# Verify the schema
npx terrably check
```

## CLI

```
terrably new <provider-name> [path]    Scaffold a new provider project
terrably build                         Compile + bundle + produce a shippable binary
terrably check                         Run correctness checks against the provider
terrably publish                       Package, sign, and upload a release
```

---

## Documentation

| Guide | |
|---|---|
| [Getting started](https://paambaati.github.io/terrably/docs/getting-started) | Scaffold your first provider in 10 minutes |
| [Core concepts](https://paambaati.github.io/terrably/docs/concepts/schema) | Types, schema, resource lifecycle, provider-defined functions |
| [Local testing](https://paambaati.github.io/terrably/docs/development/local-testing) | dev_overrides, dev mode, unit tests, debugger |
| [Distribution](https://paambaati.github.io/terrably/docs/distribution) | Multi-platform CI, GPG signing, Terraform Registry |
| [API reference](https://paambaati.github.io/terrably/docs/reference/state) | State, Diagnostics, serve(), structured logging |

