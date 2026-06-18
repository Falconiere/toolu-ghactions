// build.mjs — bundle the action into a single dist/index.js with esbuild.
// esbuild (not ncc) because the Vercel AI SDK and its deps are ESM-only and
// esbuild bundles ESM inputs into a self-contained CJS file reliably. Output is
// CJS so the node24 action runtime loads dist/index.js with no extra config.
import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: false,
  legalComments: "none",
  // GitHub provides the runner's git binary at runtime; everything else inlines.
});
console.log("built dist/index.js");
