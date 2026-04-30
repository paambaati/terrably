import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { publishCommand } from "./publish.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "terrably-publish-test-"));
}

function writePackageJson(dir: string, name: string, version: string): void {
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name, version }, null, 2) + "\n"
  );
}

function writeFakeBinary(dir: string, name: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, "#!/bin/sh\necho fake\n");
  fs.chmodSync(p, 0o755);
}

/**
 * Overrides process.exit to throw instead of actually exiting.
 * Returns a restore function that also returns the captured exit code.
 */
class ProcessExitError extends Error {
  constructor(public readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

function interceptExit(): () => number | undefined {
  const orig = process.exit.bind(process);
  let captured: number | undefined;
  process.exit = ((code?: number) => {
    captured = code;
    throw new ProcessExitError(code);
  }) as typeof process.exit;
  return () => {
    process.exit = orig;
    return captured;
  };
}

/** Capture process.stderr.write output within a callback. */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = origWrite;
  }
  return chunks.join("");
}

// ---------------------------------------------------------------------------
// Happy path: single linux_amd64 binary
// ---------------------------------------------------------------------------

void describe("publishCommand – single binary (local output)", () => {
  let tmpDir: string;
  let origCwd: string;

  before(async () => {
    origCwd = process.cwd();
    tmpDir = makeTempDir();
    process.chdir(tmpDir);
    writePackageJson(tmpDir, "terraform-provider-test", "1.2.3");
    writeFakeBinary(path.join(tmpDir, "bin"), "terraform-provider-test_linux_amd64");
    // Run publish once; all it() blocks in this group just assert on results.
    await publishCommand({ githubRelease: false });
  });

  after(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it("creates manifest.json", () => {
    assert.ok(
      fs.existsSync(path.join(tmpDir, "release", "terraform-provider-test_1.2.3_manifest.json"))
    );
  });

  void it("manifest.json has version: 1", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "release", "terraform-provider-test_1.2.3_manifest.json"), "utf8")
    ) as { version: number; metadata: { protocol_versions: string[] } };
    assert.equal(manifest.version, 1);
  });

  void it("manifest.json defaults to protocol version 6.0", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "release", "terraform-provider-test_1.2.3_manifest.json"), "utf8")
    ) as { version: number; metadata: { protocol_versions: string[] } };
    assert.deepEqual(manifest.metadata.protocol_versions, ["6.0"]);
  });

  void it("creates SHA256SUMS", () => {
    assert.ok(
      fs.existsSync(path.join(tmpDir, "release", "terraform-provider-test_1.2.3_SHA256SUMS"))
    );
  });

  void it("SHA256SUMS lines match `{64-hex}  {filename}` format", () => {
    const content = fs.readFileSync(
      path.join(tmpDir, "release", "terraform-provider-test_1.2.3_SHA256SUMS"), "utf8"
    );
    for (const line of content.trim().split("\n")) {
      assert.match(line, /^[0-9a-f]{64}  \S+$/, `unexpected SHA256SUMS line: ${line}`);
    }
  });

  void it("SHA256SUMS contains the zip filename", () => {
    const content = fs.readFileSync(
      path.join(tmpDir, "release", "terraform-provider-test_1.2.3_SHA256SUMS"), "utf8"
    );
    assert.ok(
      content.includes("terraform-provider-test_1.2.3_linux_amd64.zip"),
      "SHA256SUMS should list the zip"
    );
  });

  void it("SHA256SUMS contains the manifest filename", () => {
    const content = fs.readFileSync(
      path.join(tmpDir, "release", "terraform-provider-test_1.2.3_SHA256SUMS"), "utf8"
    );
    assert.ok(
      content.includes("terraform-provider-test_1.2.3_manifest.json"),
      "SHA256SUMS should list the manifest"
    );
  });

  void it("creates a zip archive for the binary", () => {
    assert.ok(
      fs.existsSync(path.join(tmpDir, "release", "terraform-provider-test_1.2.3_linux_amd64.zip"))
    );
  });
});

// ---------------------------------------------------------------------------
// Happy path: multiple platform binaries
// ---------------------------------------------------------------------------

void describe("publishCommand – multiple platform binaries", () => {
  let tmpDir: string;
  let origCwd: string;

  before(async () => {
    origCwd = process.cwd();
    tmpDir = makeTempDir();
    process.chdir(tmpDir);
    writePackageJson(tmpDir, "terraform-provider-multi", "2.0.0");
    const binDir = path.join(tmpDir, "bin");
    writeFakeBinary(binDir, "terraform-provider-multi_linux_amd64");
    writeFakeBinary(binDir, "terraform-provider-multi_darwin_arm64");
    writeFakeBinary(binDir, "terraform-provider-multi_windows_amd64.exe");
    await publishCommand({ githubRelease: false });
  });

  after(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it("creates a zip for linux_amd64", () => {
    assert.ok(fs.existsSync(path.join(tmpDir, "release", "terraform-provider-multi_2.0.0_linux_amd64.zip")));
  });

  void it("creates a zip for darwin_arm64", () => {
    assert.ok(fs.existsSync(path.join(tmpDir, "release", "terraform-provider-multi_2.0.0_darwin_arm64.zip")));
  });

  void it("creates a zip for windows_amd64", () => {
    assert.ok(fs.existsSync(path.join(tmpDir, "release", "terraform-provider-multi_2.0.0_windows_amd64.zip")));
  });

  void it("SHA256SUMS lists all three zips", () => {
    const content = fs.readFileSync(
      path.join(tmpDir, "release", "terraform-provider-multi_2.0.0_SHA256SUMS"), "utf8"
    );
    assert.ok(content.includes("terraform-provider-multi_2.0.0_linux_amd64.zip"));
    assert.ok(content.includes("terraform-provider-multi_2.0.0_darwin_arm64.zip"));
    assert.ok(content.includes("terraform-provider-multi_2.0.0_windows_amd64.zip"));
  });
});

// ---------------------------------------------------------------------------
// Option overrides
// ---------------------------------------------------------------------------

void describe("publishCommand – option overrides", () => {
  let tmpDir: string;
  let origCwd: string;

  before(() => {
    origCwd = process.cwd();
    tmpDir = makeTempDir();
    process.chdir(tmpDir);
    writePackageJson(tmpDir, "terraform-provider-opts", "3.0.0");
    writeFakeBinary(path.join(tmpDir, "bin"), "terraform-provider-opts_linux_amd64");
    // Also set up a bin dir for the --name override test
    writeFakeBinary(path.join(tmpDir, "bin-override"), "terraform-provider-custom_linux_amd64");
  });

  after(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it("respects a custom protocol version", async () => {
    await publishCommand({ githubRelease: false, out: "release-proto5", protocolVersion: "5.0" });
    const manifest = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "release-proto5", "terraform-provider-opts_3.0.0_manifest.json"), "utf8")
    ) as { metadata: { protocol_versions: string[] } };
    assert.deepEqual(manifest.metadata.protocol_versions, ["5.0"]);
  });

  void it("uses version from options over package.json", async () => {
    await publishCommand({ version: "9.9.9", githubRelease: false, out: "release-ver" });
    assert.ok(
      fs.existsSync(path.join(tmpDir, "release-ver", "terraform-provider-opts_9.9.9_manifest.json"))
    );
  });

  void it("uses name from options over package.json", async () => {
    await publishCommand({
      name: "custom",
      binariesDir: "bin-override",
      githubRelease: false,
      out: "release-name",
    });
    assert.ok(
      fs.existsSync(path.join(tmpDir, "release-name", "terraform-provider-custom_3.0.0_manifest.json"))
    );
  });

  void it("uses custom tag in git release (tag option stored, does not crash locally)", async () => {
    // tag only affects the GitHub release; locally we just verify no crash
    await publishCommand({ githubRelease: false, out: "release-tag", tag: "v99.0.0" });
    assert.ok(
      fs.existsSync(path.join(tmpDir, "release-tag", "terraform-provider-opts_3.0.0_manifest.json"))
    );
  });
});

// ---------------------------------------------------------------------------
// --include option
// ---------------------------------------------------------------------------

void describe("publishCommand – --include option", () => {
  let tmpDir: string;
  let origCwd: string;

  before(() => {
    origCwd = process.cwd();
    tmpDir = makeTempDir();
    process.chdir(tmpDir);
    writePackageJson(tmpDir, "terraform-provider-inc", "1.0.0");
    writeFakeBinary(path.join(tmpDir, "bin"), "terraform-provider-inc_linux_amd64");
    fs.writeFileSync(path.join(tmpDir, "EXTRA.md"), "# Extra docs\n");
  });

  after(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it("does not warn when --include path exists", async () => {
    const stderr = await captureStderr(async () => {
      await publishCommand({ githubRelease: false, out: "release-inc-ok", extraAssets: "EXTRA.md" });
    });
    assert.ok(!stderr.includes("Extra asset not found"), "should not warn for an existing file");
  });

  void it("warns about a missing --include path but does not exit", async () => {
    const stderr = await captureStderr(async () => {
      await publishCommand({ githubRelease: false, out: "release-inc-missing", extraAssets: "does-not-exist.md" });
    });
    assert.ok(stderr.includes("Extra asset not found"), "should warn about the missing file");
  });

  void it("handles a comma-separated list of includes: existing + missing", async () => {
    const stderr = await captureStderr(async () => {
      await publishCommand({
        githubRelease: false,
        out: "release-inc-multi",
        extraAssets: "EXTRA.md,missing-file.md",
      });
    });
    assert.ok(stderr.includes("Extra asset not found"), "should warn about the missing file");
    assert.ok(!stderr.includes("EXTRA.md"), "should not warn about the existing file");
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

void describe("publishCommand – error cases", () => {
  let tmpDir: string;
  let origCwd: string;

  before(() => {
    origCwd = process.cwd();
    tmpDir = makeTempDir();
    process.chdir(tmpDir);
  });

  after(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it("exits 1 when no package.json and no --name passed", async () => {
    const restore = interceptExit();
    try {
      await publishCommand({ githubRelease: false });
      assert.fail("should have exited");
    } catch (e) {
      if (!(e instanceof ProcessExitError)) throw e;
    } finally {
      assert.equal(restore(), 1);
    }
  });

  void it("throws when binaries directory does not exist", async () => {
    writePackageJson(tmpDir, "terraform-provider-err", "1.0.0");
    await assert.rejects(
      () => publishCommand({ binariesDir: "no-such-dir", githubRelease: false }),
      /Binaries directory not found/
    );
  });

  void it("throws when binaries directory is empty", async () => {
    writePackageJson(tmpDir, "terraform-provider-err", "1.0.0");
    fs.mkdirSync(path.join(tmpDir, "empty-bin"), { recursive: true });
    await assert.rejects(
      () => publishCommand({ binariesDir: "empty-bin", githubRelease: false }),
      /No provider binaries found/
    );
  });

  void it("exits 1 when --github-release is set but GITHUB_TOKEN is missing", async () => {
    writePackageJson(tmpDir, "terraform-provider-err", "1.0.0");
    writeFakeBinary(path.join(tmpDir, "bin"), "terraform-provider-err_linux_amd64");
    const savedToken = process.env["GITHUB_TOKEN"];
    delete process.env["GITHUB_TOKEN"];
    const restore = interceptExit();
    try {
      await publishCommand({ githubRelease: true });
      assert.fail("should have exited");
    } catch (e) {
      if (!(e instanceof ProcessExitError)) throw e;
    } finally {
      if (savedToken !== undefined) process.env["GITHUB_TOKEN"] = savedToken;
      assert.equal(restore(), 1);
    }
  });
});
