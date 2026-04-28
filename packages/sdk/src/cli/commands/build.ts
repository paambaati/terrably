import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as esbuild from "esbuild";

// __dirname here is <terrably-pkg>/dist/src/cli/commands/ at runtime.
// Proto files live at <terrably-pkg>/proto/ — four levels up.
const SDK_PROTO_DIR = path.resolve(__dirname, "..", "..", "..", "..", "proto");

// ── Bun single-file executable build ─────────────────────────────────────────
// Called when `terrably build` is invoked via Bun (e.g. `bun terrably build`).
// Bun compiles TypeScript natively and supports cross-compilation via --target,
// so we skip the tsc-emit + esbuild + node --build-sea pipeline entirely.
async function buildBun(opts: {
  providerRoot: string;
  providerName: string;
  outDir: string;
  tscRootDir: string | undefined;
  target: string | undefined;
}): Promise<{ binaryPath: string }> {
  const { providerRoot, providerName, outDir, tscRootDir, target } = opts;

  // ── tsc --noEmit typecheck ───────────────────────────────────────────────
  process.stdout.write("▶ Type-checking with tsc...\n");
  const tscBin = path.join(providerRoot, "node_modules", ".bin", "tsc");
  const tscCmd = fs.existsSync(tscBin) ? `"${tscBin}"` : "pnpm exec tsc";
  execSync(`${tscCmd} --noEmit`, { cwd: providerRoot, stdio: "inherit" });

  // ── Resolve TypeScript source entry point ────────────────────────────────
  // Bun compiles TS natively; point straight at the source file.
  const tsEntry = tscRootDir
    ? path.join(providerRoot, tscRootDir, "main.ts")
    : path.join(providerRoot, "src", "main.ts");
  if (!fs.existsSync(tsEntry)) {
    process.stderr.write(
      `✗ TypeScript entry point not found: ${tsEntry}\n` +
      `  Make sure src/main.ts (or the rootDir equivalent) exists.\n`,
    );
    process.exit(1);
  }

  // ── Determine output binary path ─────────────────────────────────────────
  // Bun automatically appends .exe for Windows targets; we account for that
  // when computing the expected output path for reporting.
  const isWindowsTarget = target ? target.includes("windows") : process.platform === "win32";
  const isDarwinTarget  = target ? target.includes("darwin")  : process.platform === "darwin";
  const bunOutFile    = path.join(outDir, `terraform-provider-${providerName}`);
  const bunBinaryPath = bunOutFile + (isWindowsTarget ? ".exe" : "");

  // ── Write Bun wrapper entry-point ────────────────────────────────────────
  // The wrapper uses Bun's `with { type: "file" }` import attribute to embed
  // the three .proto files into the compiled binary.  At startup the embedded
  // blobs are extracted to a temp directory so grpc-proto-loader can load them.
  const toFwd = (p: string) => p.replace(/\\/g, "/");
  const bunTmpDir      = fs.mkdtempSync(path.join(os.tmpdir(), "terrably-bun-"));
  const bunWrapperPath = path.join(bunTmpDir, "_bun_entry.ts");
  fs.writeFileSync(
    bunWrapperPath,
    // eslint-disable-next-line prefer-template
    `// ── Bun SEA preamble: extract .proto assets into a temp dir ────────────────\n` +
    `import _tfplugin6Proto      from ${JSON.stringify(toFwd(path.join(SDK_PROTO_DIR, "tfplugin6.proto")))}       with { type: "file" };\n` +
    `import _grpcControllerProto from ${JSON.stringify(toFwd(path.join(SDK_PROTO_DIR, "grpc_controller.proto")))} with { type: "file" };\n` +
    `import _grpcStdioProto      from ${JSON.stringify(toFwd(path.join(SDK_PROTO_DIR, "grpc_stdio.proto")))}      with { type: "file" };\n` +
    `import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";\n` +
    `import { join } from "node:path";\n` +
    `import { tmpdir } from "node:os";\n` +
    `\n` +
    `const _protoDir = mkdtempSync(join(tmpdir(), "tf-js-proto-"));\n` +
    `process.on("exit", () => { try { rmSync(_protoDir, { recursive: true }); } catch {} });\n` +
    `writeFileSync(join(_protoDir, "tfplugin6.proto"),       readFileSync(_tfplugin6Proto,      "utf8"));\n` +
    `writeFileSync(join(_protoDir, "grpc_controller.proto"), readFileSync(_grpcControllerProto, "utf8"));\n` +
    `writeFileSync(join(_protoDir, "grpc_stdio.proto"),      readFileSync(_grpcStdioProto,      "utf8"));\n` +
    `process.env["TF_PROTO_DIR"] = _protoDir;\n` +
    `\n` +
    `// ── Provider entry point ───────────────────────────────────────────────────\n` +
    `await import(${JSON.stringify(toFwd(tsEntry))});\n`,
    "utf8",
  );

  // ── Run bun build --compile ──────────────────────────────────────────────
  fs.mkdirSync(outDir, { recursive: true });
  const bunTargetFlag = target ? ` --target=${target}` : "";
  process.stdout.write(`▶ Building Bun executable → ${bunBinaryPath}\n`);
  try {
    execSync(
      `bun build --compile ${JSON.stringify(bunWrapperPath)}${bunTargetFlag} --outfile ${JSON.stringify(bunOutFile)}`,
      { stdio: "inherit" },
    );
  } finally {
    try { fs.rmSync(bunTmpDir, { recursive: true }); } catch { /* non-fatal */ }
  }

  // ── macOS ad-hoc codesign ────────────────────────────────────────────────
  // Only sign when the current machine is macOS and the target is also macOS
  // (or no target is specified — implying the current platform).
  if (process.platform === "darwin" && isDarwinTarget) {
    process.stdout.write("▶ Signing (ad-hoc codesign)...\n");
    execSync(`codesign --sign - --force "${bunBinaryPath}"`, { stdio: "inherit" });
  }

  return { binaryPath: bunBinaryPath };
}

// ── Node.js Single Executable Application build ───────────────────────────────
// Requires Node.js ≥ 25.5.0 (--build-sea flag was added in that release).
// Pipeline: tsc → esbuild bundle → SEA entry-point → node --build-sea → codesign
async function buildNode(opts: {
  providerRoot: string;
  providerName: string;
  outDir: string;
  binaryPath: string;
  tscOutAbs: string;
  tscRootDir: string | undefined;
}): Promise<{ binaryPath: string }> {
  const { providerRoot, binaryPath, tscOutAbs, tscRootDir } = opts;

  // ── Node.js version check ────────────────────────────────────────────────
  // --build-sea was added in Node.js 25.5.0 (https://nodejs.org/api/cli.html#build-seaconfig).
  // The older workflow (--experimental-sea-config + postject) works on older
  // versions but terrably uses --build-sea for simplicity.
  const [nodeMajorStr = "0", nodeMinorStr = "0", nodePatchStr = "0"] = process.versions.node.split(".");
  const nodeVersion = parseInt(nodeMajorStr, 10) * 10000
                    + parseInt(nodeMinorStr, 10) * 100
                    + parseInt(nodePatchStr, 10);
  if (nodeVersion < 25 * 10000 + 5 * 100) {
    process.stderr.write(
      `✗ Node.js ≥ 25.5.0 is required to build a Single Executable Application.\n` +
      `  The --build-sea flag was added in Node.js 25.5.0.\n` +
      `  You are running ${process.version}.\n` +
      `  Install Node.js 25.5.0+: https://nodejs.org/en/download\n`,
    );
    process.exit(1);
  }

  // ── Step 1: tsc ──────────────────────────────────────────────────────────
  process.stdout.write("▶ Compiling TypeScript...\n");
  const tscBin = path.join(providerRoot, "node_modules", ".bin", "tsc");
  const tscCmd = fs.existsSync(tscBin) ? `"${tscBin}"` : "pnpm exec tsc";
  // Pass --noEmit false explicitly so that providers whose tsconfig.json has
  // noEmit: true (e.g. when they rely on a separate bundler for their own
  // tooling) still produce compiled output for the SEA build.
  execSync(`${tscCmd} --noEmit false`, { cwd: providerRoot, stdio: "inherit" });

  // ── Step 2: esbuild bundle ───────────────────────────────────────────────
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

  // ── Step 3: Generate SEA entry-point ─────────────────────────────────────
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

  // ── Step 4: Write sea-config.json ────────────────────────────────────────
  process.stdout.write("▶ Writing sea-config.json...\n");
  fs.mkdirSync(opts.outDir, { recursive: true });
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

  // ── Step 5: node --build-sea ─────────────────────────────────────────────
  process.stdout.write(`▶ Building SEA binary → ${binaryPath}\n`);
  execSync(`node --build-sea "${seaConfigPath}"`, { stdio: "inherit" });

  // ── Step 6: macOS ad-hoc codesign ────────────────────────────────────────
  if (process.platform === "darwin") {
    process.stdout.write("▶ Signing (ad-hoc codesign)...\n");
    execSync(`codesign --sign - --force "${binaryPath}"`, { stdio: "inherit" });
  }

  return { binaryPath };
}

function printBuildSummary(binaryPath: string): void {
  const sizeMb = (fs.statSync(binaryPath).size / 1024 / 1024).toFixed(1);
  process.stdout.write(`\n✅  ${binaryPath}  (${sizeMb} MB)\n`);
  process.stdout.write(`\nSmoke test:\n`);
  process.stdout.write(
    `  TF_PLUGIN_MAGIC_COOKIE=d602bf8f470bc67ca7faa0386276bbdd4330efaf76d1a219cb4d6991ca9872b2 \\\n` +
    `    "${binaryPath}"\n\n`,
  );
}

// ── Public entry point ────────────────────────────────────────────────────────
export async function buildCommand(options: { name?: string; out?: string; target?: string }): Promise<void> {
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

  const outDir = path.resolve(providerRoot, options.out ?? "bin");

  // ── Resolve tsconfig output directory ────────────────────────────────────
  // Read tsconfig.json once here so all steps use the same outDir/rootDir
  // rather than hardcoding "dist/src", which is wrong when rootDir is set.
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

  let result: { binaryPath: string };
  if (typeof process.versions.bun !== "undefined") {
    result = await buildBun({ providerRoot, providerName, outDir, tscRootDir, target: options.target });
  } else {
    const binaryName = `terraform-provider-${providerName}${process.platform === "win32" ? ".exe" : ""}`;
    const binaryPath = path.join(outDir, binaryName);
    const tscOutAbs  = path.resolve(providerRoot, tscOutDir);
    result = await buildNode({ providerRoot, providerName, outDir, binaryPath, tscOutAbs, tscRootDir });
  }
  printBuildSummary(result.binaryPath);
}
