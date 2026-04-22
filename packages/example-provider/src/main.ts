import { serve } from "terrably";
import { ExampleProvider } from "./provider.js";

serve(new ExampleProvider()).catch((err: unknown) => {
  process.stderr.write(`Fatal: ${String(err)}
`);
  process.exit(1);
});
