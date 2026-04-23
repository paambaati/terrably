/**
 * terrably publish
 *
 * Packages per-platform provider binaries into the exact file layout required
 * by the Terraform Registry, optionally signs the checksum file with GPG, and
 * optionally creates/updates a GitHub Release.
 *
 * Required release asset layout (from the Terraform Registry publishing docs):
 *
 *   terraform-provider-{name}_{version}_{os}_{arch}.zip
 *     └─ terraform-provider-{name}_v{version}[.exe]   ← binary inside zip
 *
 *   terraform-provider-{name}_{version}_manifest.json
 *   terraform-provider-{name}_{version}_SHA256SUMS
 *   terraform-provider-{name}_{version}_SHA256SUMS.sig   ← binary GPG detach-sign
 *
 * Binary detection (--binaries-dir):
 *   Files must be named `terraform-provider-{name}_{os}_{arch}[.exe]`.
 *   Supported os/arch values mirror the official goreleaser recommendation:
 *     linux_{amd64,arm64,arm,386}
 *     darwin_{amd64,arm64}
 *     windows_{amd64,386}    (.exe extension required)
 *     freebsd_{amd64,386,arm}
 */

import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AdmZip = require("adm-zip") as new () => AdmZipInstance;

// Minimal typings for the subset of adm-zip we use
interface AdmZipInstance {
  addFile(entryName: string, data: Buffer, comment?: string, attr?: number): void;
  toBuffer(): Buffer;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PublishOptions {
  version?: string;
  name?: string;
  binariesDir?: string;
  out?: string;
  protocolVersion?: string;
  gpgKey?: string;
  githubRelease?: boolean;
  draft?: boolean;
  tag?: string;
}

interface PlatformBinary {
  filePath: string;
  os: string;
  arch: string;
  isWindows: boolean;
}

// ---------------------------------------------------------------------------
// OS/arch detection helpers
// ---------------------------------------------------------------------------

/**
 * Valid OS/arch combos: maps the `{os}_{arch}` suffix found in filenames to
 * the canonical form Terraform expects in asset names.
 *
 * Terraform expects exactly these strings (same as `go tool dist list` subset):
 *   OS:   darwin | freebsd | linux | windows
 *   ARCH: 386 | amd64 | arm | arm64
 */
const SUPPORTED_PLATFORMS = new Set([
  "darwin_amd64",
  "darwin_arm64",
  "linux_amd64",
  "linux_arm64",
  "linux_arm",
  "linux_386",
  "windows_amd64",
  "windows_386",
  "freebsd_amd64",
  "freebsd_386",
  "freebsd_arm",
]);

// Current Node.js platform → Terraform os/arch
const NODE_TO_TF_OS: Record<string, string> = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
  freebsd: "freebsd",
};
const NODE_TO_TF_ARCH: Record<string, string> = {
  x64: "amd64",
  arm64: "arm64",
  arm: "arm",
  ia32: "386",
};

function currentPlatformSuffix(): string {
  const os = NODE_TO_TF_OS[process.platform] ?? process.platform;
  const arch = NODE_TO_TF_ARCH[process.arch] ?? process.arch;
  return `${os}_${arch}`;
}

// ---------------------------------------------------------------------------
// Binary detection
// ---------------------------------------------------------------------------

function detectBinaries(binariesDir: string, baseName: string): PlatformBinary[] {
  if (!fs.existsSync(binariesDir)) {
    throw new Error(
      `Binaries directory not found: ${binariesDir}\n` +
        `  Run \`terrably build\` on each target platform first, then collect\n` +
        `  the binaries here (see \`terrably publish --help\` for the naming convention).`
    );
  }

  const entries = fs.readdirSync(binariesDir);
  const results: PlatformBinary[] = [];

  for (const entry of entries) {
    const full = path.join(binariesDir, entry);
    if (!fs.statSync(full).isFile()) continue;

    const isWindows = entry.endsWith(".exe");
    const stripped = isWindows ? entry.slice(0, -4) : entry;

    // Match `terraform-provider-{name}_{os}_{arch}`
    const prefix = `${baseName}_`;
    if (!stripped.startsWith(prefix)) continue;

    const suffix = stripped.slice(prefix.length); // e.g. "linux_amd64"
    if (!SUPPORTED_PLATFORMS.has(suffix)) continue;

    const [os, arch] = suffix.split("_") as [string, string];
    results.push({ filePath: full, os, arch, isWindows });
  }

  // If no platform-suffixed binaries found, check for a plain binary and
  // treat it as the current platform (useful for quick local testing).
  if (results.length === 0) {
    const plainName = baseName + (process.platform === "win32" ? ".exe" : "");
    const plainPath = path.join(binariesDir, plainName);
    if (fs.existsSync(plainPath)) {
      const platform = currentPlatformSuffix();
      const [os, arch] = platform.split("_") as [string, string];
      const isWindows = process.platform === "win32";
      process.stderr.write(
        `⚠️  No platform-suffixed binaries found. Using ${plainName} as ${platform}.\n` +
          `   For a multi-platform release, name each binary ` +
          `\`${baseName}_{os}_{arch}[.exe]\`.\n`
      );
      results.push({ filePath: plainPath, os, arch, isWindows });
    }
  }

  if (results.length === 0) {
    throw new Error(
      `No provider binaries found in: ${binariesDir}\n` +
        `  Expected files named: ${baseName}_{os}_{arch}[.exe]\n` +
        `  Example: ${baseName}_linux_amd64, ${baseName}_darwin_arm64`
    );
  }

  return results;
}

// ---------------------------------------------------------------------------
// ZIP creation
// ---------------------------------------------------------------------------

function createZip(
  binaryPath: string,
  binaryNameInZip: string,
  zipPath: string
): void {
  if (process.platform !== "win32") {
    // Use the system `zip` command on Unix/macOS.
    //
    // adm-zip does not set the "version made by" OS byte to Unix (3) in the
    // ZIP central directory header. Go's archive/zip only honours the Unix
    // permission bits in the external-attributes field when that OS byte is 3,
    // so binaries zipped with adm-zip are extracted with 0000 permissions and
    // Terraform cannot open them to compute a checksum.
    //
    // The system `zip` command sets the OS byte to Unix and preserves the
    // execute bit correctly.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "terrably-zip-"));
    const tmpBinary = path.join(tmpDir, binaryNameInZip);
    try {
      fs.copyFileSync(binaryPath, tmpBinary);
      fs.chmodSync(tmpBinary, 0o755);
      execSync(`zip -j ${JSON.stringify(zipPath)} ${JSON.stringify(tmpBinary)}`, { stdio: "pipe" });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } else {
    // On Windows the build host has no system `zip`.  Use adm-zip instead.
    // Windows Terraform ignores Unix permissions, so the missing OS byte
    // is not a problem for .exe providers.
    const zip = new AdmZip();
    const binaryData = fs.readFileSync(binaryPath);
    zip.addFile(binaryNameInZip, binaryData, "");
    fs.writeFileSync(zipPath, zip.toBuffer());
  }
}

// ---------------------------------------------------------------------------
// SHA256 helpers
// ---------------------------------------------------------------------------

function sha256File(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

// ---------------------------------------------------------------------------
// GPG signing
// ---------------------------------------------------------------------------

function gpgSign(checksumPath: string, sigPath: string, gpgKey: string): void {
  // Produces a BINARY (not ASCII-armored) detached signature — required by the
  // Terraform Registry. ASCII-armored sigs are rejected.
  const cmd = [
    "gpg",
    "--batch",
    "--yes",
    "--local-user", gpgKey,
    "--output", `"${sigPath}"`,
    "--detach-sign",
    `"${checksumPath}"`,
  ].join(" ");
  execSync(cmd, { stdio: "pipe" });
}

// ---------------------------------------------------------------------------
// GitHub Release helpers
// ---------------------------------------------------------------------------

interface GitHubRelease {
  id: number;
  upload_url: string;
  html_url: string;
}

async function getOrCreateRelease(
  owner: string,
  repo: string,
  tag: string,
  token: string,
  draft: boolean
): Promise<GitHubRelease> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "terrably-cli/0.1.0",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  // Check if release already exists for this tag
  const listResp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`,
    { headers }
  );

  if (listResp.ok) {
    return (await listResp.json()) as GitHubRelease;
  }

  // Create new release
  const body = JSON.stringify({
    tag_name: tag,
    name: tag,
    draft,
    prerelease: tag.includes("-"),
    generate_release_notes: false,
  });

  const createResp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/releases`,
    { method: "POST", headers, body }
  );

  if (!createResp.ok) {
    const text = await createResp.text();
    throw new Error(`GitHub API error creating release: ${createResp.status} ${text}`);
  }

  return (await createResp.json()) as GitHubRelease;
}

async function uploadReleaseAsset(
  uploadUrl: string,
  assetPath: string,
  assetName: string,
  token: string
): Promise<void> {
  // Strip the {?name,label} template from the upload URL
  const url = uploadUrl.replace(/\{[^}]+\}$/, "") + `?name=${encodeURIComponent(assetName)}`;

  const data = fs.readFileSync(assetPath);
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/octet-stream",
      "User-Agent": "terrably-cli/0.1.0",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: data,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to upload ${assetName}: ${resp.status} ${text}`);
  }
}

// Parse GitHub remote URL → { owner, repo }
function parseGitHubRemote(): { owner: string; repo: string } | null {
  try {
    const remoteUrl = execSync("git remote get-url origin", {
      stdio: ["pipe", "pipe", "pipe"],
    })
      .toString()
      .trim();

    // HTTPS: https://github.com/owner/repo.git
    let m = remoteUrl.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    if (m) return { owner: m[1]!, repo: m[2]! };

    // SSH: git@github.com:owner/repo.git
    m = remoteUrl.match(/git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    if (m) return { owner: m[1]!, repo: m[2]! };
  } catch {
    // no git remote
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function publishCommand(options: PublishOptions): Promise<void> {
  const providerRoot = process.cwd();

  // ── Resolve provider name ─────────────────────────────────────────────────
  let providerShortName = options.name;
  if (!providerShortName) {
    const pkgPath = path.join(providerRoot, "package.json");
    if (!fs.existsSync(pkgPath)) {
      process.stderr.write("✗ No package.json found. Run from your provider's root, or pass --name.\n");
      process.exit(1);
    }
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { name?: string; version?: string };
    providerShortName = (pkg.name ?? "")
      .replace(/^terraform-provider-/, "")
      .replace(/^@[^/]+\//, "");
    if (!providerShortName) {
      process.stderr.write("✗ Cannot determine provider name. Pass --name <name>.\n");
      process.exit(1);
    }
  }

  // ── Resolve version ───────────────────────────────────────────────────────
  let version = options.version;
  if (!version) {
    const pkgPath = path.join(providerRoot, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
      version = pkg.version;
    }
  }
  if (!version) {
    process.stderr.write("✗ Cannot determine version. Pass --version <version>.\n");
    process.exit(1);
  }
  // Strip leading "v" for use in filenames (registry uses bare version in names)
  const ver = version.replace(/^v/, "");
  // Tag always has "v" prefix
  const tag = options.tag ?? `v${ver}`;

  const baseName = `terraform-provider-${providerShortName}`;
  const binariesDir = path.resolve(providerRoot, options.binariesDir ?? "bin");
  const outDir = path.resolve(providerRoot, options.out ?? "release");
  const protocolVersion = options.protocolVersion ?? "6.0";

  process.stdout.write(`\n▶ Publishing ${baseName} version ${ver}\n`);
  process.stdout.write(`  Binaries:  ${binariesDir}\n`);
  process.stdout.write(`  Output:    ${outDir}\n\n`);

  // ── Detect binaries ───────────────────────────────────────────────────────
  const binaries = detectBinaries(binariesDir, baseName);
  process.stdout.write(`  Found ${binaries.length} platform binary(ies):\n`);
  for (const b of binaries) {
    process.stdout.write(`    ${b.os}_${b.arch}  ←  ${path.basename(b.filePath)}\n`);
  }
  process.stdout.write("\n");

  fs.mkdirSync(outDir, { recursive: true });

  const assetFiles: string[] = [];

  // ── Step 1: Create per-platform zips ──────────────────────────────────────
  process.stdout.write("▶ Creating zip archives...\n");
  for (const bin of binaries) {
    const zipName = `${baseName}_${ver}_${bin.os}_${bin.arch}.zip`;
    const zipPath = path.join(outDir, zipName);
    const binaryNameInZip = `${baseName}_v${ver}${bin.isWindows ? ".exe" : ""}`;

    createZip(bin.filePath, binaryNameInZip, zipPath);
    assetFiles.push(zipPath);
    process.stdout.write(`  ${zipName}\n`);
  }

  // ── Step 2: Write terraform-registry-manifest.json ────────────────────────
  process.stdout.write("\n▶ Writing manifest...\n");
  const manifestName = `${baseName}_${ver}_manifest.json`;
  const manifestPath = path.join(outDir, manifestName);
  const manifest = {
    version: 1,
    metadata: {
      protocol_versions: [protocolVersion],
    },
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  assetFiles.push(manifestPath);
  process.stdout.write(`  ${manifestName}\n`);

  // ── Step 3: Generate SHA256SUMS ───────────────────────────────────────────
  process.stdout.write("\n▶ Computing SHA256SUMS...\n");
  const checksumsName = `${baseName}_${ver}_SHA256SUMS`;
  const checksumsPath = path.join(outDir, checksumsName);

  // sha256sum format: `{hex}  {filename}` (two spaces, matching `sha256sum` output)
  const checksumLines: string[] = [];
  for (const assetPath of assetFiles) {
    const hex = sha256File(assetPath);
    const filename = path.basename(assetPath);
    checksumLines.push(`${hex}  ${filename}`);
  }
  fs.writeFileSync(checksumsPath, checksumLines.join("\n") + "\n");
  process.stdout.write(`  ${checksumsName}\n`);

  // ── Step 4: GPG sign ──────────────────────────────────────────────────────
  const gpgKey = options.gpgKey ?? process.env["GPG_FINGERPRINT"];
  const sigName = `${checksumsName}.sig`;
  const sigPath = path.join(outDir, sigName);

  if (gpgKey) {
    process.stdout.write("\n▶ Signing SHA256SUMS with GPG...\n");
    try {
      gpgSign(checksumsPath, sigPath, gpgKey);
      process.stdout.write(`  ${sigName}\n`);
    } catch (e) {
      process.stderr.write(
        `✗ GPG signing failed: ${String(e)}\n` +
          `  The Terraform Registry REQUIRES a signed checksum file.\n` +
          `  Ensure the key is in your GPG keyring and the fingerprint is correct.\n`
      );
      process.exit(1);
    }
  } else {
    process.stdout.write(
      `\n⚠️  Skipping GPG signature (no --gpg-key or $GPG_FINGERPRINT set).\n` +
        `   The Terraform Registry REQUIRES a signature. Set GPG_FINGERPRINT or\n` +
        `   pass --gpg-key before publishing to the registry.\n`
    );
  }

  // ── Step 5: GitHub Release ────────────────────────────────────────────────
  if (options.githubRelease) {
    const token = process.env["GITHUB_TOKEN"];
    if (!token) {
      process.stderr.write("✗ --github-release requires GITHUB_TOKEN to be set.\n");
      process.exit(1);
    }

    const remote = parseGitHubRemote();
    if (!remote) {
      process.stderr.write(
        "✗ Cannot determine GitHub owner/repo from git remote.\n" +
          "  Ensure your git remote 'origin' points to a GitHub repository.\n"
      );
      process.exit(1);
    }

    const { owner, repo } = remote;
    process.stdout.write(`\n▶ Creating GitHub Release ${tag} on ${owner}/${repo}...\n`);

    const release = await getOrCreateRelease(
      owner, repo, tag, token, options.draft ?? false
    );
    process.stdout.write(`  Release URL: ${release.html_url}\n`);

    // Collect all assets: zips + manifest + checksums + sig
    const allAssets = [
      ...assetFiles,
      checksumsPath,
      ...(fs.existsSync(sigPath) ? [sigPath] : []),
    ];

    process.stdout.write("\n▶ Uploading release assets...\n");
    for (const assetPath of allAssets) {
      const assetName = path.basename(assetPath);
      process.stdout.write(`  Uploading ${assetName}...`);
      await uploadReleaseAsset(release.upload_url, assetPath, assetName, token);
      process.stdout.write(" done\n");
    }

    process.stdout.write(
      `\n✅  Release published: ${release.html_url}\n` +
        (options.draft ? "   (draft — publish it on GitHub when ready)\n" : "")
    );
  } else {
    // Print summary of local files
    const allLocal = [
      ...assetFiles,
      checksumsPath,
      ...(fs.existsSync(sigPath) ? [sigPath] : []),
    ];
    process.stdout.write(`\n✅  Release assets written to: ${outDir}/\n\n`);
    for (const f of allLocal) {
      const sizeKb = (fs.statSync(f).size / 1024).toFixed(0);
      process.stdout.write(`  ${path.basename(f).padEnd(60)} ${sizeKb.padStart(7)} KB\n`);
    }
    process.stdout.write(`\nNext steps –\n`);
    process.stdout.write(`  1. Upload these files to a GitHub Release tagged ${tag}\n`);
    process.stdout.write(`  2. Or run with --github-release to do it automatically\n`);
  }
}
