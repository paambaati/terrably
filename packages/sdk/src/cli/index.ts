#!/usr/bin/env node
/**
 * terrably CLI
 *
 * Commands:
 *   terrably new <provider-name>                    Scaffold a new provider project
 *   terrably build [--name <name>] [--out <dir>]    Build a self-contained SEA binary
 *   terrably check [--binary <path>] [--terraform]  Run correctness checks
 *   terrably publish [options]                      Package + sign + upload a release
 */

import { cac } from "cac";
import { newCommand } from "./commands/new.js";
import { buildCommand } from "./commands/build.js";
import { checkCommand } from "./commands/check.js";
import { publishCommand } from "./commands/publish.js";

const cli = cac("terrably");

// ---------------------------------------------------------------------------
// terrably new <provider-name>
// ---------------------------------------------------------------------------

cli
  .command("new <provider-name> [path]", "Scaffold a new provider project into a new directory")
  .example("terrably new mycloud")
  .example("terrably new mycloud ~/projects/mycloud")
  .example("terrably new terraform-provider-mycloud")
  .action(async (providerName: string, targetPath: string | undefined) => {
    await newCommand(providerName, targetPath);
  });

// ---------------------------------------------------------------------------
// terrably build
// ---------------------------------------------------------------------------

cli
  .command("build", "Compile TypeScript, bundle, and produce a self-contained SEA binary")
  .option("--name <name>", "Provider name (default: read from package.json)")
  .option("--out <dir>",   "Output directory (default: bin/)")
  .example("terrably build")
  .example("terrably build --name mycloud --out dist/bin")
  .action(async (options: { name?: string; out?: string }) => {
    await buildCommand(options);
  });

// ---------------------------------------------------------------------------
// terrably check
// ---------------------------------------------------------------------------

cli
  .command("check", "Run correctness checks against the provider")
  .option("--binary <path>", "Path to a pre-built SEA binary (default: runs src/main.ts via tsx)")
  .option("--terraform",     "Also run `terraform validate` (requires terraform in PATH)")
  .example("terrably check")
  .example("terrably check --binary bin/terraform-provider-mycloud")
  .example("terrably check --terraform")
  .action(async (options: { binary?: string; terraform?: boolean }) => {
    await checkCommand(options);
  });

// ---------------------------------------------------------------------------
// terrably publish
// ---------------------------------------------------------------------------

cli
  .command("publish", "Package, sign, and upload a provider release to GitHub")
  .option("--release-version <version>",   "Version to release, e.g. 1.2.3 (default: from package.json)")
  .option("--name <name>",                "Provider name (default: from package.json)")
  .option("--binaries-dir <dir>",         "Directory containing per-platform binaries (default: bin/)")
  .option("--out <dir>",                  "Output directory for release assets (default: release/)")
  .option("--protocol-version <version>", "Terraform protocol version: 5.0 or 6.0 (default: 6.0)")
  .option("--gpg-key <fingerprint>",      "GPG key fingerprint/email for signing (default: $GPG_FINGERPRINT)")
  .option("--github-release",             "Create GitHub Release and upload all assets (requires $GITHUB_TOKEN)")
  .option("--draft",                      "Create release as draft (use with --github-release)")
  .option("--tag <tag>",                  "Git tag to use (default: v{version})")
  .example("terrably publish --release-version 1.0.0")
  .example("terrably publish --release-version 1.0.0 --gpg-key you@example.com --github-release")
  .example("terrably publish --release-version 1.0.0 --binaries-dir dist/binaries --draft --github-release")
  .action(async (options: {
    releaseVersion?: string;
    name?: string;
    binariesDir?: string;
    out?: string;
    protocolVersion?: string;
    gpgKey?: string;
    githubRelease?: boolean;
    draft?: boolean;
    tag?: string;
  }) => {
    await publishCommand({ ...options, version: options.releaseVersion });
  });

// ---------------------------------------------------------------------------
// Global flags + boot
// ---------------------------------------------------------------------------

cli.version("0.1.0");
cli.help();

// Unknown command handler
cli.on("command:*", () => {
  process.stderr.write(`terrably: unknown command '${cli.args.join(" ")}'\n`);
  cli.outputHelp();
  process.exit(1);
});

(async () => {
  try {
    cli.parse(process.argv, { run: false });
    await cli.runMatchedCommand();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`terrably: ✗ ${msg}\n`);
    cli.outputHelp();
    process.exit(1);
  }
})();
