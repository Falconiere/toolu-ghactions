import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("modules bundled by scripts/injection-probe.mjs", () => {
  it("never pull in @actions/* (its CommonJS http stack cannot load in the probe's ESM bundle)", async () => {
    // The probe bundles these two modules as ESM and imports the result. @actions/core
    // drags in `tunnel`, whose dynamic require("net") throws there — and the probe job
    // only runs with a provider secret, so nothing else would catch the regression.
    const result = await build({
      entryPoints: [join(SRC, "prompt.ts"), join(SRC, "llm", "reviewWithModel.ts")],
      bundle: true,
      write: false,
      metafile: true,
      platform: "node",
      format: "esm",
      outdir: "unused",
      logLevel: "silent",
    });
    const actions = Object.keys(result.metafile.inputs).filter((p) =>
      p.includes("node_modules/@actions/"),
    );
    expect(actions).toEqual([]);
  });
});
