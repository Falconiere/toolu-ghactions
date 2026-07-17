// incremental.test.ts — the incremental-review scope filter: genuinely NEW
// findings only from lines changed since the last reviewed sha; adjudication of
// prior threads/findings always stays in play; null scope = full review.
import { describe, expect, it } from "vitest";
import { dropOutOfScope } from "@/review/incremental.js";
import type { IncrementalScope } from "@/review/incremental.js";
import { finding, thread } from "@/review/__tests__/reconcile-helpers.js";

const EMPTY: IncrementalScope = new Map();

describe("dropOutOfScope", () => {
  it("null scope keeps everything (full review)", () => {
    const f = finding({ fp: "fp-any" });
    const r = dropOutOfScope([f], null, [], []);
    expect(r.kept).toEqual([f]);
    expect(r.dropped).toEqual([]);
  });

  it("an EMPTY scope (nothing changed since last review) drops a fresh finding", () => {
    // This is the convergence core: no changes since the last round → no new
    // findings can exist, whatever the model invents.
    const f = finding({ fp: "fp-invented" });
    const r = dropOutOfScope([f], EMPTY, [], []);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual([f]);
  });

  it("keeps a finding anchored to a line changed since the last review", () => {
    const f = finding({ path: "src/a.ts", line: 12 });
    const scope: IncrementalScope = new Map([["src/a.ts", new Set([11, 12, 13])]]);
    const r = dropOutOfScope([f], scope, [], []);
    expect(r.kept).toEqual([f]);
  });

  it("drops a finding in a since-changed file but on an unchanged line", () => {
    const f = finding({ path: "src/a.ts", line: 50 });
    const scope: IncrementalScope = new Map([["src/a.ts", new Set([11, 12, 13])]]);
    const r = dropOutOfScope([f], scope, [], []);
    expect(r.dropped).toEqual([f]);
  });

  it("keeps an out-of-scope finding covered by a prior thread (nearby rewording)", () => {
    // Adjudication of an existing discussion must survive the scope filter.
    const f = finding({ fp: "fp-reworded", line: 13 });
    const t = thread({ fp: "fp-original", line: 10 });
    const r = dropOutOfScope([f], EMPTY, [t], []);
    expect(r.kept).toEqual([f]);
  });

  it("keeps an out-of-scope finding matching a prior-state finding by fingerprint", () => {
    // Inline comments off: no threads exist, but the marker's findings do.
    const f = finding({ fp: "fp-carried" });
    const r = dropOutOfScope([f], EMPTY, [], [{ path: "src/a.ts", fp: "fp-carried" }]);
    expect(r.kept).toEqual([f]);
  });

  it("keeps an out-of-scope finding near a prior-state finding (same path, radius)", () => {
    const f = finding({ fp: "fp-reworded", line: 15 });
    const r = dropOutOfScope([f], EMPTY, [], [{ path: "src/a.ts", line: 10, fp: "fp-old" }]);
    expect(r.kept).toEqual([f]);
  });

  it("drops an out-of-scope finding far from any prior finding", () => {
    const f = finding({ fp: "fp-new", line: 100 });
    const r = dropOutOfScope([f], EMPTY, [], [{ path: "src/a.ts", line: 10, fp: "fp-old" }]);
    expect(r.dropped).toEqual([f]);
  });

  it("splits a mixed batch: in-scope kept, carried kept, invention dropped", () => {
    const inScope = finding({ fp: "fp-a", path: "src/new.ts", line: 5 });
    const carried = finding({ fp: "fp-b", path: "src/a.ts", line: 11 });
    const invented = finding({ fp: "fp-c", path: "src/other.ts", line: 40 });
    const scope: IncrementalScope = new Map([["src/new.ts", new Set([5])]]);
    const t = thread({ fp: "fp-old", path: "src/a.ts", line: 10 });
    const r = dropOutOfScope([inScope, carried, invented], scope, [t], []);
    expect(r.kept).toEqual([inScope, carried]);
    expect(r.dropped).toEqual([invented]);
  });
});
