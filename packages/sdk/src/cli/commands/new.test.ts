import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { newCommand } from "./new.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "terrably-new-test-"));
}

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

// ---------------------------------------------------------------------------
// Scaffolded file structure
// ---------------------------------------------------------------------------

void describe("newCommand – scaffolded file structure", () => {
  let tmpDir: string;
  let providerDir: string;

  before(async () => {
    tmpDir = makeTempDir();
    providerDir = path.join(tmpDir, "terraform-provider-mycloud");
    await newCommand("mycloud", providerDir);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it("creates package.json", () => {
    assert.ok(fs.existsSync(path.join(providerDir, "package.json")));
  });

  void it("package.json name is terraform-provider-mycloud", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(providerDir, "package.json"), "utf8")
    ) as { name: string };
    assert.equal(pkg.name, "terraform-provider-mycloud");
  });

  void it("package.json has a terrably dependency", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(providerDir, "package.json"), "utf8")
    ) as { dependencies: Record<string, string> };
    assert.ok("terrably" in pkg.dependencies, "should have terrably as a dependency");
  });

  void it("creates tsconfig.json", () => {
    assert.ok(fs.existsSync(path.join(providerDir, "tsconfig.json")));
  });

  void it("creates src/main.ts", () => {
    assert.ok(fs.existsSync(path.join(providerDir, "src", "main.ts")));
  });

  void it("creates src/provider.ts", () => {
    assert.ok(fs.existsSync(path.join(providerDir, "src", "provider.ts")));
  });

  void it("creates src/resources/item.ts", () => {
    assert.ok(fs.existsSync(path.join(providerDir, "src", "resources", "item.ts")));
  });

  void it("creates tf-workspace/main.tf", () => {
    assert.ok(fs.existsSync(path.join(providerDir, "tf-workspace", "main.tf")));
  });

  void it("creates tf-workspace/.terraformrc", () => {
    assert.ok(fs.existsSync(path.join(providerDir, "tf-workspace", ".terraformrc")));
  });

  void it("creates README.md", () => {
    assert.ok(fs.existsSync(path.join(providerDir, "README.md")));
  });

  void it("creates bin/.gitkeep placeholder", () => {
    assert.ok(fs.existsSync(path.join(providerDir, "bin", ".gitkeep")));
  });

  void it("src/main.ts imports the generated Provider class", () => {
    const content = fs.readFileSync(path.join(providerDir, "src", "main.ts"), "utf8");
    assert.ok(content.includes("MycloudProvider"), "main.ts should import MycloudProvider");
  });

  void it("src/provider.ts exports the Provider class", () => {
    const content = fs.readFileSync(path.join(providerDir, "src", "provider.ts"), "utf8");
    assert.ok(content.includes("class MycloudProvider"), "provider.ts should define MycloudProvider");
  });

  void it("src/resources/item.ts exports the Resource class", () => {
    const content = fs.readFileSync(path.join(providerDir, "src", "resources", "item.ts"), "utf8");
    assert.ok(content.includes("class MycloudItem"), "item.ts should define MycloudItem");
  });

  void it("tf-workspace/main.tf references the provider prefix", () => {
    const content = fs.readFileSync(path.join(providerDir, "tf-workspace", "main.tf"), "utf8");
    assert.ok(content.includes("mycloud"), "main.tf should use the mycloud prefix");
  });

  void it("tf-workspace/.terraformrc references the bin directory", () => {
    const content = fs.readFileSync(path.join(providerDir, "tf-workspace", ".terraformrc"), "utf8");
    assert.ok(content.includes("bin"), ".terraformrc should point at the bin/ directory");
  });
});

// ---------------------------------------------------------------------------
// Name normalisation
// ---------------------------------------------------------------------------

void describe("newCommand – name normalisation", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = makeTempDir();
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it("strips the terraform-provider- prefix so the package is not double-prefixed", async () => {
    const providerDir = path.join(tmpDir, "terraform-provider-gpcloud");
    await newCommand("terraform-provider-gpcloud", providerDir);
    const pkg = JSON.parse(
      fs.readFileSync(path.join(providerDir, "package.json"), "utf8")
    ) as { name: string };
    assert.equal(pkg.name, "terraform-provider-gpcloud");
    assert.ok(
      !pkg.name.startsWith("terraform-provider-terraform-provider-"),
      "name must not be double-prefixed"
    );
  });

  void it("generates PascalCase class names for hyphenated provider names", async () => {
    const providerDir = path.join(tmpDir, "terraform-provider-my-cloud");
    await newCommand("my-cloud", providerDir);
    const providerTs = fs.readFileSync(path.join(providerDir, "src", "provider.ts"), "utf8");
    const itemTs = fs.readFileSync(path.join(providerDir, "src", "resources", "item.ts"), "utf8");
    assert.ok(providerTs.includes("MyCloudProvider"), "provider class should be MyCloudProvider");
    assert.ok(itemTs.includes("MyCloudItem"), "resource class should be MyCloudItem");
  });

  void it("generates PascalCase for underscore-separated names", async () => {
    const providerDir = path.join(tmpDir, "terraform-provider-my-store");
    await newCommand("my_store", providerDir);
    const content = fs.readFileSync(path.join(providerDir, "src", "provider.ts"), "utf8");
    assert.ok(content.includes("MyStoreProvider"), "provider class should be MyStoreProvider");
  });

  void it("lowercases the provider name in the directory name", async () => {
    const providerDir = path.join(tmpDir, "terraform-provider-lowercase");
    await newCommand("LOWERCASE", providerDir);
    const pkg = JSON.parse(
      fs.readFileSync(path.join(providerDir, "package.json"), "utf8")
    ) as { name: string };
    // shortName is always lowercased, so the package name should be lowercase
    assert.equal(pkg.name, "terraform-provider-lowercase");
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

void describe("newCommand – error cases", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = makeTempDir();
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it("exits 1 when the target directory already exists", async () => {
    const providerDir = path.join(tmpDir, "terraform-provider-exists");
    fs.mkdirSync(providerDir, { recursive: true });
    const restore = interceptExit();
    try {
      await newCommand("exists", providerDir);
      assert.fail("should have exited");
    } catch (e) {
      if (!(e instanceof ProcessExitError)) throw e;
    } finally {
      assert.equal(restore(), 1);
    }
  });
});
