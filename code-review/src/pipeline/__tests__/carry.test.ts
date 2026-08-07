// carry.test.ts — the strict carry-forward guard (spec §Carry-forward): prior
// findings on paths this round did NOT review come back so their threads are not
// falsely resolved, but only if they still look like validated findings. The
// untrusted inputs are built through `JSON.parse` (the marker's own shape: loose
// objects narrowed only by a type annotation), never by hand-typed literals that
// the compiler would have rejected on the way in.
import { describe, expect, it } from "vitest";
import { carryForward } from "@/pipeline/carry.js";
import { buildLedger } from "@/review/ledger.js";
import type { CoverageLedger } from "@/review/ledger.js";
import type { StampedFinding } from "@/pipeline/reviewCall.js";
import type { Finding as StoredFinding } from "@/state.js";
import { fingerprint } from "@/state.js";

/** A this-round model finding, stamped exactly as reviewCall.ts stamps it. */
function stamped(over: Partial<StampedFinding> = {}): StampedFinding {
  const f = {
    path: "src/a.ts",
    line: 10,
    severity: "medium" as const,
    category: "correctness",
    text: "a finding",
    ...over,
  };
  return { ...f, fp: over.fp ?? fingerprint(f) };
}

const ledger = (entries: [string, CoverageLedger["entries"][string]][]): CoverageLedger =>
  buildLedger(entries);

describe("carryForward", () => {
  it("re-injects a well-formed prior finding on a path that was NOT reviewed", () => {
    const prior: StoredFinding[] = JSON.parse(
      '[{"path":"src/carried.ts","line":4,"severity":"high","category":"correctness","text":"leaked handle","fp":"fp-carried"}]',
    );
    const r = carryForward({
      modelFindings: [stamped()],
      priorFindings: prior,
      ledger: ledger([
        ["src/a.ts", { status: "reviewed" }],
        ["src/carried.ts", { status: "carried" }],
      ]),
    });
    expect(r.findings.map((f) => f.fp)).toEqual([stamped().fp, "fp-carried"]);
    expect(r.findings[1]).toEqual({
      path: "src/carried.ts",
      line: 4,
      severity: "high",
      category: "correctness",
      text: "leaked handle",
      fp: "fp-carried",
    });
    expect(r.carriedWithoutFinding).toEqual([]);
  });

  it("re-injects a prior finding whose path the ledger never mentions", () => {
    // A path no stratum recorded is by definition a path nothing reviewed.
    const prior: StoredFinding[] = JSON.parse(
      '[{"path":"src/unknown.ts","line":1,"severity":"nit","text":"stray","fp":"fp-unknown"}]',
    );
    const r = carryForward({ modelFindings: [], priorFindings: prior, ledger: ledger([]) });
    expect(r.findings.map((f) => f.fp)).toEqual(["fp-unknown"]);
  });

  it("never re-injects a prior finding on a REVIEWED path", () => {
    const prior: StoredFinding[] = JSON.parse(
      '[{"path":"src/a.ts","line":10,"severity":"high","text":"stale","fp":"fp-stale"}]',
    );
    const r = carryForward({
      modelFindings: [],
      priorFindings: prior,
      ledger: ledger([["src/a.ts", { status: "reviewed" }]]),
    });
    expect(r.findings).toEqual([]);
    expect(r.carriedWithoutFinding).toEqual([]);
  });

  it("filters passthrough garbage into carriedWithoutFinding instead of the findings", () => {
    // Straight from an editable sticky comment: no line, an off-enum severity, an
    // empty text, a string line, a missing fp — each one would break a downstream
    // consumer that assumes a validated finding.
    const prior: StoredFinding[] = JSON.parse(
      `[{"path":"src/no-line.ts","severity":"high","text":"anchorless","fp":"fp-1"},
        {"path":"src/bad-sev.ts","line":2,"severity":"URGENT","text":"shouty","fp":"fp-2"},
        {"path":"src/empty.ts","line":3,"severity":"low","text":"","fp":"fp-3"},
        {"path":"src/str-line.ts","line":"7","severity":"low","text":"quoted line","fp":"fp-4"},
        {"path":"src/no-fp.ts","line":5,"severity":"low","text":"unstamped"},
        {"line":6,"severity":"low","text":"pathless","fp":"fp-6"}]`,
    );
    const r = carryForward({ modelFindings: [], priorFindings: prior, ledger: ledger([]) });
    expect(r.findings).toEqual([]);
    expect(r.carriedWithoutFinding).toEqual([
      "src/bad-sev.ts",
      "src/empty.ts",
      "src/no-fp.ts",
      "src/no-line.ts",
      "src/str-line.ts",
    ]); // the pathless entry has nothing to ledger against — dropped outright
  });

  it("strips unknown marker keys rather than carrying them into a validated path", () => {
    const prior: StoredFinding[] = JSON.parse(
      '[{"path":"src/x.ts","line":1,"severity":"low","text":"ok","fp":"fp-x","__proto_ish":"<img onerror>","suggestion":"const a = 1;"}]',
    );
    const r = carryForward({ modelFindings: [], priorFindings: prior, ledger: ledger([]) });
    expect(r.findings).toEqual([
      {
        path: "src/x.ts",
        line: 1,
        severity: "low",
        text: "ok",
        fp: "fp-x",
        suggestion: "const a = 1;",
      },
    ]);
  });

  it("dedupes by fp with the MODEL finding winning, and reports a path once", () => {
    const model = stamped({ path: "src/dup.ts", line: 20, text: "this round's wording" });
    const prior: StoredFinding[] = JSON.parse(
      `[{"path":"src/dup.ts","line":1,"severity":"low","text":"last round's wording","fp":"${model.fp}"},
        {"path":"src/junk.ts","line":1,"severity":"low","text":"first"},
        {"path":"src/junk.ts","line":2,"severity":"low","text":"second"}]`,
    );
    const r = carryForward({
      modelFindings: [model],
      priorFindings: prior,
      ledger: ledger([["src/dup.ts", { status: "carried" }]]),
    });
    expect(r.findings).toEqual([model]);
    expect(r.carriedWithoutFinding).toEqual(["src/junk.ts"]);
  });
});
