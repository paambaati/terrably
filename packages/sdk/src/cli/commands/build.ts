import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as esbuild from "esbuild";

// __dirname here is <terrably-pkg>/dist/src/cli/commands/ at runtime.
// Proto files live at <terrably-pkg>/proto/ — four levels up.
const SDK_PROTO_DIR = path.resolve(__dirname, "..", "..", "..", "..", "proto");

export async function buildCommand(options: { name?: string; out?: string }): Promise<void> {
  const providerRoot = process.cwd();

  // ── Resolve provider name ─────────────────────────────────────────────────
  let providerName = options.name;
  if (!providerName) {
    const pkgPath = path.join(providerRoot, "package.json");
    if (!fs.existsSync(pkgPath)) {
      process.stderr.write(
        "✗ No package.json found. Run terrably build from your provider's root.\n",
      );
      process.exit(1);
    }
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { name?: string };
    providerName = (pkg.name ?? "").replace(/^terraform-provider-/, "").replace(/^@[^/]+\//, "");
    if (!providerName) {
      process.stderr.write("✗ Cannot determine provider name. Pass --name <name>.\n");
      process.exit(1);
    }
  }

  const outDir     = path.resolve(providerRoot, options.out ?? "bin");
  const binaryName = `terraform-provider-${providerName}${process.platform === "win32" ? ".exe" : ""}`;
  const binaryPath = path.join(outDir, binaryName);

  // ── Resolve tsconfig output directory ────────────────────────────────────
  // Read tsconfig.json once here so all steps below use the same outDir/rootDir
  // rather than hardcoding "dist/src" which is wrong when rootDir is set.
  const tsconfigPath = path.join(providerRoot, "tsconfig.json");
  let tscOutDir  = "dist";   // TypeScript default
  let tscRootDir: string | undefined;
  if (fs.existsSync(tsconfigPath)) {
    const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf8")) as {
      compilerOptions?: { outDir?: string; rootDir?: string };
    };
    tscOutDir  = tsconfig.compilerOptions?.outDir  ?? "dist";
    tscRootDir = tsconfig.compilerOptions?.rootDir;
  }
  // Intermediate terrably build artifacts live alongside tsc output.
  const tscOutAbs = path.resolve(providerRoot, tscOutDir);

  // ── Node.js version check ─────────────────────────────────────────────────
  // --build-sea was added in Node.js 25.5.0 (https://nodejs.org/api/cli.html#build-seaconfig).
  // The older workflow (--experimental-sea-config + postject) works on older
  // versions but terrably uses --build-sea for simplicity.
  const [nodeMajorStr = "0", nodeMinorStr = "0", nodePatchStr = "0"] = process.versions.node.split(".");
  const nodeMajor = parseInt(nodeMajorStr, 10);
  const nodeMinor = parseInt(nodeMinorStr, 10);
  const nodePatch = parseInt(nodePatchStr, 10);
  const nodeVersion = nodeMajor * 10000 + nodeMinor * 100 + nodePatch;
  const minVersion  = 25 * 10000 + 5 * 100 + 0;
  if (nodeVersion < minVersion) {
    process.stderr.write(
      `✗ Node.js ≥ 25.5.0 is required to build a Single Executable Application.\n` +
      `  The --build-sea flag was added in Node.js 25.5.0.\n` +
      `  You are running ${process.version}.\n` +
      `  Install Node.js 25.5.0+: https://nodejs.org/en/download\n`,
    );
    process.exit(1);
  }

  // ── Step 1: tsc ───────────────────────────────────────────────────────────
  process.stdout.write("▶ Compiling TypeScript...\n");
  const tscBin = path.join(providerRoot, "node_modules", ".bin", "tsc");
  const tscCmd = fs.existsSync(tscBin) ? `"${tscBin}"` : "pnpm exec tsc";
  // Pass --noEmit false explicitly so that providers whose tsconfig.json has
  // noEmit: true (e.g. when they rely on a separate bundler for their own
  // tooling) still produce compiled output for the SEA build.
  execSync(`${tscCmd} --noEmit false`, { cwd: providerRoot, stdio: "inherit" });

  // ── Step 2: esbuild bundle ────────────────────────────────────────────────
  process.stdout.write("▶ Bundling with esbuild...\n");

  // Derive the compiled entry point from the resolved tsconfig paths.
  //   rootDir="src", outDir="dist"  →  dist/main.js       (terrably scaffold)
  //   rootDir not set, outDir="dist" →  dist/src/main.js  (no rootDir set)
  let compiledEntry: string;
  if (tscRootDir) {
    const relFromRoot = path.relative(tscRootDir, path.join("src", "main.ts"));
    compiledEntry = path.join(tscOutAbs, relFromRoot.replace(/\.ts$/, ".js"));
  } else {
    compiledEntry = path.join(tscOutAbs, "src", "main.js");
  }

  if (!fs.existsSync(compiledEntry)) {
    process.stderr.write(
      `✗ Compiled entry point not found: ${compiledEntry}\n` +
      `  Make sure "tsc" ran successfully and the output matches your tsconfig.json.\n`,
    );
    process.exit(1);
  }

  const bundleOut = path.join(tscOutAbs, "_sea_bundle.cjs");
  const esbuildResult = await esbuild.build({
    entryPoints: [compiledEntry],
    bundle:   true,
    platform: "node",
    format:   "cjs",
    outfile:  bundleOut,
    packages: "bundle",
    external: ["*.node"],
    metafile: true,
  });

  // ── Check for unbundleable externals ─────────────────────────────────────
  // esbuild records every import it left unresolved in the metafile with
  // external: true. Node.js built-in modules are legitimately external and
  // work fine inside a SEA binary. Everything else that is external cannot be
  // embedded and will cause a runtime crash on the end user's machine.
  // builtinModules covers bare names ("fs") and node:-prefixed names
  // ("node:fs") — both forms appear in the wild.
  const { builtinModules } = await import("node:module");
  const builtinSet = new Set([
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
  ]);

  type ExternalRef = { external: string; importedFrom: string };
  const externalRefs: ExternalRef[] = [];
  for (const [inputFile, meta] of Object.entries(esbuildResult.metafile.inputs)) {
    for (const imp of meta.imports) {
      if (imp.external && !builtinSet.has(imp.path)) {
        externalRefs.push({ external: imp.path, importedFrom: inputFile });
      }
    }
  }
  if (externalRefs.length > 0) {
    const lines = [...new Set(externalRefs.map((r) => `    • ${r.external}  (imported by ${r.importedFrom})`))];
    process.stderr.write(
      `✗ Native addons are not supported in terrably builds.` +
      `  The following imports cannot be bundled into a Node.js Single Executable Application –\n` +
      lines.join("\n") + "\n" +
      `\n` +
      `  To fix this, replace each native dependency with a pure-JS alternative.\n` +
      `  Alternatively, check \`pnpm why <package>\` to find what pulls them in.\n`,
    );
    process.exit(1);
  }

  // ── Step 3: Generate SEA entry-point ──────────────────────────────────────
  process.stdout.write("▶ Generating SEA entry-point...\n");
  const bundleCode  = fs.readFileSync(bundleOut, "utf8");

  const seaEntryPath = path.join(tscOutAbs, "_sea_entry.cjs");
  fs.writeFileSync(
    seaEntryPath,
    `"use strict";
// ── SEA preamble: extract .proto assets into a temp dir ─────────────────────
const _sea  = require("node:sea");
const _os   = require("node:os");
const _fs   = require("node:fs");
const _path = require("node:path");

if (_sea.isSea()) {
  const protoDir = _fs.mkdtempSync(_path.join(_os.tmpdir(), "tf-js-proto-"));
  process.on("exit", () => { try { _fs.rmSync(protoDir, { recursive: true }); } catch {} });
  for (const name of ["tfplugin6.proto", "grpc_controller.proto", "grpc_stdio.proto"]) {
    _fs.writeFileSync(_path.join(protoDir, name), _sea.getAsset(name, "utf8"));
  }
  // serve() reads TF_PROTO_DIR when opts.protoDir is not set
  process.env["TF_PROTO_DIR"] = protoDir;
}

// ── Bundled provider ─────────────────────────────────────────────────────────
${bundleCode}
`,
    "utf8",
  );

  // ── Step 5: Write sea-config.json ─────────────────────────────────────────
  process.stdout.write("▶ Writing sea-config.json...\n");
  fs.mkdirSync(outDir, { recursive: true });
  const seaConfig = {
    main:   seaEntryPath,
    output: binaryPath,
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    useSnapshot:  false,
    assets: {
      "tfplugin6.proto":       path.join(SDK_PROTO_DIR, "tfplugin6.proto"),
      "grpc_controller.proto": path.join(SDK_PROTO_DIR, "grpc_controller.proto"),
      "grpc_stdio.proto":      path.join(SDK_PROTO_DIR, "grpc_stdio.proto"),
    },
  };
  const seaConfigPath = path.join(tscOutAbs, "sea-config.json");
  fs.writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2));

  // ── Step 6: node --build-sea ──────────────────────────────────────────────
  process.stdout.write(`▶ Building SEA binary → ${binaryPath}\n`);
  execSync(`node --build-sea "${seaConfigPath}"`, { stdio: "inherit" });

  // ── Step 7: macOS ad-hoc codesign ─────────────────────────────────────────
  if (process.platform === "darwin") {
    process.stdout.write("▶ Signing (ad-hoc codesign)...\n");
    execSync(`codesign --sign - --force "${binaryPath}"`, { stdio: "inherit" });
  }

  const sizeMb = (fs.statSync(binaryPath).size / 1024 / 1024).toFixed(1);
  process.stdout.write(`\n✅  ${binaryPath}  (${sizeMb} MB)\n`);
  process.stdout.write(`\nSmoke test:\n`);
  process.stdout.write(
    `  TF_PLUGIN_MAGIC_COOKIE=d602bf8f470bc67ca7faa0386276bbdd4330efaf76d1a219cb4d6991ca9872b2 \\\n` +
    `    "${binaryPath}"\n\n`,
  );
}
