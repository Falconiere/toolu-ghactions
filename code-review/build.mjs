// build.mjs — bundle the action into run/index.cjs and sanitize-sarif/index.cjs
// with esbuild. esbuild (not ncc) because the Vercel AI SDK and its deps are
// ESM-only and esbuild bundles ESM inputs into a self-contained CJS file
// reliably. The output is CJS (uses require()), so it MUST carry the .cjs
// extension: package.json has "type": "module" (the source is ESM), which would
// otherwise make Node load a .js bundle as ESM and crash on `require`. node24
// runs .cjs as CommonJS.
import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: false,
  legalComments: "none",
  // GitHub provides the runner's git binary at runtime; everything else inlines.
};

await build({
  entryPoints: ["src/main.ts"],
  outfile: "run/index.cjs",
  ...common,
});
console.log("built run/index.cjs");

await build({
  entryPoints: ["src/mechanical/sanitize-cli.ts"],
  outfile: "sanitize-sarif/index.cjs",
  ...common,
});
console.log("built sanitize-sarif/index.cjs");
