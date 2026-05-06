# terrably

[![Tests](https://github.com/paambaati/terraform-provider-gpcloud/actions/workflows/e2e-terrably-upgrade.yml/badge.svg)](https://github.com/paambaati/terraform-provider-gpcloud/actions/workflows/e2e-terrably-upgrade.yml) [![NPM](https://img.shields.io/npm/v/terrably)](https://www.npmjs.com/package/terrably)

Build Terraform & OpenTofu providers in TypeScript, using Node.js or Bun.

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

# Build → produces bin/terraform-provider-mycloud
npx terrably build

# Verify the schema
npx terrably check

# Pubish the provider
npx terrably publish
```

## CLI

```
terrably new <provider-name> [path]    Scaffold a new provider project
terrably build                         Compile + bundle + produce a shippable binary
terrably check                         Run correctness checks against the provider
terrably publish                       Package, sign, and upload a release
```

---

## Credits

This project would not be possible without studying https://github.com/hfern/tf, so thank you [@hfern](https://github.com/hfern).
