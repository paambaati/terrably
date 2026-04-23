import * as fs from "node:fs";
import * as path from "node:path";
import nunjucks from "nunjucks";

/** "my-cloud" → "MyCloud" */
function toPascalCase(s: string): string {
  return s
    .split(/[-_]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

/** Each entry: [template path relative to templates/, output path relative to project root] */
const SCAFFOLD_FILES: [string, string][] = [
  ["README.md.njk",                 "README.md"],
  ["package.json.njk",              "package.json"],
  ["tsconfig.json.njk",             "tsconfig.json"],
  [".gitignore.njk",                ".gitignore"],
  ["src/main.ts.njk",               "src/main.ts"],
  ["src/provider.ts.njk",           "src/provider.ts"],
  ["src/resources/item.ts.njk",     "src/resources/item.ts"],
  ["tf-workspace/main.tf.njk",      "tf-workspace/main.tf"],
  ["tf-workspace/.terraformrc.njk", "tf-workspace/.terraformrc"],
];

export async function newCommand(providerName: string, targetPath?: string): Promise<void> {
  // Accept either "mycloud" or "terraform-provider-mycloud"
  const shortName   = providerName.replace(/^terraform-provider-/, "").toLowerCase();
  const dirName     = `terraform-provider-${shortName}`;
  const targetDir   = targetPath
    ? path.resolve(process.cwd(), targetPath)
    : path.resolve(process.cwd(), dirName);

  if (fs.existsSync(targetDir)) {
    process.stderr.write(`✗ Directory '${dirName}' already exists.\n`);
    process.exit(1);
  }

  const context = {
    shortName,
    dirName,
    prefix:          shortName,
    providerCls:     `${toPascalCase(shortName)}Provider`,
    resourceCls:     `${toPascalCase(shortName)}Item`,
    absBinDir:       path.join(targetDir, "bin"),
    // __dirname at runtime is dist/src/cli/commands/ — go up 4 levels to reach
    // the package root, where package.json is always present in any npm install.
    terrablyVersion: (JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../../package.json"), "utf8")) as { version: string }).version,
  };

  const templatesDir = path.resolve(__dirname, "..", "templates");
  const env = nunjucks.configure(templatesDir, { autoescape: false });

  process.stdout.write(`▶ Scaffolding ${dirName}...\n`);

  for (const d of ["src/resources", "tf-workspace", "bin"]) {
    fs.mkdirSync(path.join(targetDir, d), { recursive: true });
  }

  for (const [tmpl, out] of SCAFFOLD_FILES) {
    fs.writeFileSync(path.join(targetDir, out), env.render(tmpl, context));
  }

  // empty placeholder so git tracks the bin/ directory
  fs.writeFileSync(path.join(targetDir, "bin", ".gitkeep"), "");

  process.stdout.write(`
✅  ${dirName} created.

Next steps –

  cd ${dirName}
  pnpm install
  pnpm build               # compile + bundle → bin/terraform-provider-${shortName}
  cd tf-workspace
  TF_CLI_CONFIG_FILE=.terraformrc terraform plan

Tip: run \`terrably check\` (from the provider root) to verify the provider
before building the binary.
`);
}
