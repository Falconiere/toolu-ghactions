import { describe, it, expect } from "vitest";
import { splitDiffByFile, packGroups, packChunks } from "@/git/chunk.js";
import { groupRelatedSegments } from "@/git/relate.js";

// Segments come from SHAPED diffs (line-primed, `Lnnn: ` prefixes) — build them the
// way production does: shaped text through splitDiffByFile. The fixture mirrors the
// real failure: a parent declaring `#[path = "…"] mod …;` and its child packed into
// DIFFERENT chunks, so the model reviewing the child alone reported the parent
// deleted and every `use super::…` unresolved.

/** One shaped `diff --git` block adding the given (already-marked) body lines. */
function shapedBlock(path: string, bodyLines: string[]): string {
  return (
    `diff --git a/${path} b/${path}\n` +
    `new file mode 100644\n` +
    `--- /dev/null\n` +
    `+++ b/${path}\n` +
    `@@ -0,0 +1,${bodyLines.length} @@\n` +
    bodyLines.map((l, i) => `L${i + 1}: +${l}`).join("\n") +
    "\n"
  );
}

const PARENT = shapedBlock("tests/helpers/live_harness.rs", [
  `#[path = "live_harness_api.rs"]`,
  "mod api;",
  "pub struct LiveHarness;",
]);
const CHILD = shapedBlock("tests/helpers/live_harness_api.rs", [
  "use super::LiveHarness;",
  "pub fn call(h: &LiveHarness) {}",
]);
const UNRELATED = shapedBlock("src/other.ts", ["export const x = 1"]);

describe("groupRelatedSegments", () => {
  it("groups a #[path] mod declaration with its target file", () => {
    const groups = groupRelatedSegments(splitDiffByFile(PARENT + CHILD + UNRELATED));
    const rust = groups.find((g) => g.some((s) => s.path.endsWith("live_harness.rs")));
    expect(rust?.map((s) => s.path).sort()).toEqual([
      "tests/helpers/live_harness.rs",
      "tests/helpers/live_harness_api.rs",
    ]);
    // The unrelated file stays a singleton.
    const other = groups.find((g) => g.some((s) => s.path === "src/other.ts"));
    expect(other).toHaveLength(1);
  });

  it("groups a plain `mod x;` with dir/x.rs", () => {
    const parent = shapedBlock("src/lib.rs", ["mod engine;"]);
    const child = shapedBlock("src/engine.rs", ["pub fn run() {}"]);
    const groups = groupRelatedSegments(splitDiffByFile(parent + child));
    expect(groups).toHaveLength(1);
    expect(groups[0]?.map((s) => s.path).sort()).toEqual(["src/engine.rs", "src/lib.rs"]);
  });

  it("groups a `use super::…` child with its same-dir mod.rs (reverse direction)", () => {
    const parent = shapedBlock("src/net/mod.rs", ["pub struct Client;"]);
    const child = shapedBlock("src/net/http.rs", ["use super::Client;"]);
    const groups = groupRelatedSegments(splitDiffByFile(parent + child));
    expect(groups).toHaveLength(1);
  });

  it("ignores declarations on removed (L---:) lines — old content creates no edge", () => {
    const parent =
      `diff --git a/src/lib.rs b/src/lib.rs\n` +
      `--- a/src/lib.rs\n` +
      `+++ b/src/lib.rs\n` +
      `@@ -1,1 +1,1 @@\n` +
      `L---: -mod engine;\n` +
      `L1: +pub fn nothing() {}\n`;
    const child = shapedBlock("src/engine.rs", ["pub fn run() {}"]);
    const groups = groupRelatedSegments(splitDiffByFile(parent + child));
    expect(groups).toHaveLength(2);
  });

  it("leaves non-Rust segments ungrouped", () => {
    const a = shapedBlock("a.ts", ["mod fake;"]);
    const b = shapedBlock("mod.ts", ["x"]);
    const groups = groupRelatedSegments(splitDiffByFile(a + b));
    expect(groups).toHaveLength(2);
  });
});

describe("packGroups", () => {
  it("never splits a group across chunks — an over-budget group rides alone", () => {
    const segments = splitDiffByFile(PARENT + CHILD + UNRELATED);
    const groups = groupRelatedSegments(segments);
    // Budget below the pair's combined size: ungrouped packing would separate them.
    const pairLines = segments
      .filter((s) => s.path.includes("live_harness"))
      .reduce((n, s) => n + s.lines, 0);
    const { chunks } = packGroups(groups, pairLines - 1, 0);
    const withParent = chunks.find((c) =>
      c.some((s) => s.path === "tests/helpers/live_harness.rs"),
    );
    expect(withParent?.map((s) => s.path)).toContain("tests/helpers/live_harness_api.rs");
  });

  it("singleton groups reproduce packChunks exactly", () => {
    const segments = splitDiffByFile(PARENT + CHILD + UNRELATED);
    const viaGroups = packGroups(
      segments.map((s) => [s]),
      10,
      0,
    );
    const viaChunks = packChunks(segments, 10, 0);
    expect(viaGroups).toEqual(viaChunks);
  });
});
