/**
 * Provider entry point.
 *
 * Normal mode (Terraform manages the process):
 *   TF_PLUGIN_MAGIC_COOKIE=d602bf8f... node dist/src/main.js
 *
 * Dev/debug mode (manually started, Terraform reattaches):
 *   TF_PLUGIN_MAGIC_COOKIE=d602bf8f... TF_PLUGIN_DEBUG=1 node dist/src/main.js --dev
 */

import { serve } from "terrably";
import { DummyCloudProvider } from "./provider.js";

const dev = process.argv.includes("--dev") || process.env["TF_PLUGIN_DEBUG"] === "1";

serve(new DummyCloudProvider(), { dev }).catch((err) => {
  process.stderr.write(`Fatal: ${String(err)}\n`);
  process.exit(1);
});
