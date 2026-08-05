// settlement.test.ts — proves settlement.ts's matching/attribution logic,
// exercised through the public partitionFindings() entry point: every
// Settlement value derives correctly, all three isSettled prongs are covered,
// and an AMBIGUOUS settled-thread match (two settled threads on one path both
// covering one finding) is refused rather than silently attributed to the
// wrong physical thread. Split from partition.test.ts (which stayed under the
// file-size budget until this module's worth of coverage was added).
import { describe, expect, it } from "vitest";
import { dropSettled, reconcile } from "@/review/reconcile.js";
import type { Reconciliation } from "@/review/reconcile.js";
import { ACCEPTED_RESOLUTION_NOTE } from "@/github/threads.js";
import { thread, BOT } from "@/review/__tests__/reconcile-helpers.js";
import type { StampedFinding } from "@/pipeline/reviewCall.js";
import { partitionFindings } from "@/report/partition.js";
import type { PartitionedFindings, PartitionResult } from "@/report/partition.js";

// reconcile-helpers.ts's `finding()` returns the loosely-typed `ReconcileFinding`
// (severity is `string | undefined`), which does not satisfy `StampedFinding`
// (severity is a required, narrow enum) — the type partitionFindings() actually
// takes. This mirrors its defaults with the stronger shape.
function stampedFinding(over: Partial<StampedFinding> = {}): StampedFinding {
  return {
    path: "src/a.ts",
    line: 10,
    severity: "medium",
    category: "correctness",
    text: "a finding",
    fp: "fp-default",
    ...over,
  };
}

function expectOk(result: PartitionResult): PartitionedFindings {
  if (!result.ok) throw new Error(`expected a partition, got a violation: ${result.reason}`);
  return result.partitions;
}

describe("partitionFindings — settlement values (all three isSettled prongs)", () => {
  it("emits 'explicit'/'exhausted' straight off a dismissed toResolve thread", () => {
    const explicit = thread({ fp: "fp-explicit", dismissal: "explicit" });
    const exhausted = thread({ threadId: "T_2", fp: "fp-exhausted", dismissal: "exhausted" });
    const applied: Reconciliation<StampedFinding> = {
      toCreate: [],
      toReply: [],
      toResolve: [explicit, exhausted],
    };
    const priorThreads = [explicit, exhausted];
    const p = expectOk(
      partitionFindings({ applied, findings: [], suppressed: [], priorThreads, prior: null }),
    );
    expect(p.dismissed.map((d) => [d.fp, d.settlement])).toEqual([
      ["fp-explicit", "explicit"],
      ["fp-exhausted", "exhausted"],
    ]);
    expect(p.fixed).toEqual([]);
  });

  it("emits 'resolved' for a suppressed finding matched to an isResolved:true, dismissal:undefined thread", () => {
    // isResolved threads never reach applied.toResolve (reconcile() `continue`s on
    // them) — this settlement can only arise via the `suppressed` side.
    const f = stampedFinding({ fp: "fp-sup", path: "src/y.ts", line: 5 });
    const t = thread({ fp: "fp-sup-t", path: "src/y.ts", line: 5, isResolved: true });
    const applied: Reconciliation<StampedFinding> = { toCreate: [], toReply: [], toResolve: [] };
    const p = expectOk(
      partitionFindings({ applied, findings: [], suppressed: [f], priorThreads: [t], prior: null }),
    );
    expect(p.dismissed).toEqual([
      {
        fp: "fp-sup",
        path: "src/y.ts",
        line: 5,
        severity: "medium",
        category: "correctness",
        settlement: "resolved",
      },
    ]);
  });

  it("emits 'resolved' via the accepted-resolution-note prong — the third isSettled disjunct, not isResolved or dismissal", () => {
    // The bot's own note posted after an EARLIER resolveThread mutation failed
    // (github/threads.ts's ACCEPTED_RESOLUTION_NOTE): isResolved is false and
    // dismissal is undefined, so only this third disjunct explains suppression.
    const f = stampedFinding({ fp: "fp-accepted" });
    const t = thread({
      fp: "fp-accepted",
      replies: [{ author: BOT, body: ACCEPTED_RESOLUTION_NOTE }],
    });
    const applied: Reconciliation<StampedFinding> = { toCreate: [], toReply: [], toResolve: [] };
    const p = expectOk(
      partitionFindings({ applied, findings: [], suppressed: [f], priorThreads: [t], prior: null }),
    );
    expect(p.dismissed).toEqual([
      {
        fp: "fp-accepted",
        path: "src/a.ts",
        line: 10,
        severity: "medium",
        category: "correctness",
        settlement: "resolved",
      },
    ]);
  });

  it("emits 'resolved' via the category-tag-on-a-detached-thread prong, reusing reconcile.ts's matchesSettled (not a reimplementation)", () => {
    // Body format is buildComment()'s exact render (github/review.ts): "**severity** _(category)_: text".
    const f = stampedFinding({ fp: "fp-detached-cur", path: "src/z.ts", line: 300 });
    const t = thread({
      fp: "fp-detached-orig",
      path: "src/z.ts",
      line: null,
      isResolved: true,
      isOutdated: true,
      rootBody: "**medium** _(CORRECTNESS)_: some text\n\n<!-- toolu-fp:fp-detached-orig -->",
    });
    const applied: Reconciliation<StampedFinding> = { toCreate: [], toReply: [], toResolve: [] };
    const p = expectOk(
      partitionFindings({ applied, findings: [], suppressed: [f], priorThreads: [t], prior: null }),
    );
    expect(p.dismissed).toEqual([
      {
        fp: "fp-detached-cur",
        path: "src/z.ts",
        line: 300,
        severity: "medium",
        category: "correctness",
        settlement: "resolved",
      },
    ]);
  });
});

describe("partitionFindings — thread identity (fp alone is not sufficient identity)", () => {
  it("a dismissed-but-unresolved thread whose finding is reworded is reported ONCE, under the thread's OLD fp", () => {
    // Reproduction: dropSettled() suppresses the reworded re-raise under its OWN
    // (new) fp; reconcile(), seeing no finding left to match the thread, resolves
    // the SAME thread under ITS OWN (old) fp. fp-only tracking would report both —
    // one physical dismissal, two review_findings rows, countDismissed inflated.
    const reworded = stampedFinding({ fp: "fp-reworded" });
    const t = thread({ fp: "fp-original", dismissal: "explicit" });
    const { kept, suppressed } = dropSettled([reworded], [t]);
    expect(kept).toEqual([]);
    const applied = reconcile(kept, [t]);
    expect(applied.toResolve).toEqual([t]);

    const p = expectOk(
      partitionFindings({ applied, findings: kept, suppressed, priorThreads: [t], prior: null }),
    );
    // The OLD fp survives: it's what the human actually dismissed, and the
    // identity the platform's review_findings row already exists under — the
    // reworded fp would orphan that row for text the model merely reworded.
    expect(p.dismissed).toEqual([
      { fp: "fp-original", path: "src/a.ts", line: 10, settlement: "explicit" },
    ]);
  });

  it("reproduces for a blocker too, via the exact matches() path+line prong (not just the loose prongs)", () => {
    const reworded = stampedFinding({
      fp: "fp-rew-b",
      path: "src/b.ts",
      line: 20,
      severity: "blocker",
    });
    const t = thread({ fp: "fp-orig-b", path: "src/b.ts", line: 20, dismissal: "explicit" });
    const { kept, suppressed } = dropSettled([reworded], [t]);
    expect(suppressed).toEqual([reworded]); // an EXPLICIT dismissal silences a blocker on an exact match
    const applied = reconcile(kept, [t]);
    const p = expectOk(
      partitionFindings({ applied, findings: kept, suppressed, priorThreads: [t], prior: null }),
    );
    expect(p.dismissed).toEqual([
      { fp: "fp-orig-b", path: "src/b.ts", line: 20, settlement: "explicit" },
    ]);
  });

  it("[Blocker 1 repro] refuses to guess when two settled threads loosely match one suppressed finding, rather than absorbing into the wrong one and losing it", () => {
    // T_wrong and T_right are both settled (dismissal:"explicit") and, being on
    // the same path within NEARBY_LINE_RADIUS (10), both loosely cover X — the
    // reworded re-raise of T_right's REAL dismissal. B is an unrelated live
    // blocker that also nearby-matches T_right, keeping it "matched" every run
    // so it never itself reaches toResolve (matching the actual repro shape).
    const tWrong = thread({ threadId: "T_wrong", fp: "fp-tw", line: 20, dismissal: "explicit" });
    const tRight = thread({ threadId: "T_right", fp: "fp-tr", line: 5, dismissal: "explicit" });
    const x = stampedFinding({ fp: "fp-x", line: 12 });
    const b = stampedFinding({ fp: "fp-b", line: 8, severity: "blocker" });
    const { kept, suppressed } = dropSettled([x, b], [tWrong, tRight]);
    expect(suppressed).toEqual([x]);
    const applied = reconcile(kept, [tWrong, tRight]);
    expect(applied.toResolve).toEqual([tWrong]); // T_right never reaches toResolve this run

    const result = partitionFindings({
      applied,
      findings: kept,
      suppressed,
      priorThreads: [tWrong, tRight],
      prior: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a violation, got a partition");
    expect(result.reason).toContain("fp-x");
  });
});
