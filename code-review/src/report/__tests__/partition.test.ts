// partition.test.ts — proves partitionFindings() is a real partition: every fp
// lands in exactly one bucket, every input fp lands somewhere, and the two
// documented reconcile() edge cases (a duplicate-open-thread fp split across
// buckets, and a loosely-matched finding reconcile() drops entirely) resolve
// deterministically instead of double-counting or vanishing. Settlement-value
// derivation and thread-identity ambiguity (settlement.ts's concerns) are
// covered in the sibling settlement.test.ts.
import { describe, expect, it } from "vitest";
import { reconcile } from "@/review/reconcile.js";
import type { Reconciliation } from "@/review/reconcile.js";
import { thread, authorReply } from "@/review/__tests__/reconcile-helpers.js";
import type { StampedFinding } from "@/pipeline/reviewCall.js";
import type { ReviewState } from "@/state.js";
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

function reviewState(findings: ReviewState["findings"]): ReviewState {
  return { schema: "toolu-review-state", version: 1, findings, history: [] };
}

function expectOk(result: PartitionResult): PartitionedFindings {
  if (!result.ok) throw new Error(`expected a partition, got a violation: ${result.reason}`);
  return result.partitions;
}

describe("partitionFindings — fixed", () => {
  it("detects a fix via toResolve with no dismissal, independent of fullReview", () => {
    // diffState()'s `resolved` bucket is empty whenever scope.full_review is
    // false; partitionFindings never reads fullReview at all, so detection here
    // does not depend on it.
    const t = thread({ fp: "fp-fixed-1" });
    const applied: Reconciliation<StampedFinding> = { toCreate: [], toReply: [], toResolve: [t] };
    const p = expectOk(
      partitionFindings({ applied, findings: [], suppressed: [], priorThreads: [t], prior: null }),
    );
    expect(p.fixed).toEqual([{ fp: "fp-fixed-1", path: "src/a.ts", line: 10 }]);
    expect(p.dismissed).toEqual([]);
  });

  it("enriches from prior.findings — RAW, never through normalizeCategory", () => {
    const t = thread({ fp: "fp-fixed-2" });
    const applied: Reconciliation<StampedFinding> = { toCreate: [], toReply: [], toResolve: [t] };
    // "SECURITY VULN" is not a ReportCategory member — proves it passes through
    // unnormalized, since partition.ts must never call normalizeCategory().
    const prior = reviewState([
      { fp: "fp-fixed-2", severity: "high", category: "SECURITY VULN", source: "llm" },
    ]);
    const p = expectOk(
      partitionFindings({ applied, findings: [], suppressed: [], priorThreads: [t], prior }),
    );
    expect(p.fixed[0]).toEqual({
      fp: "fp-fixed-2",
      path: "src/a.ts",
      line: 10,
      severity: "high",
      category: "SECURITY VULN",
      source: "llm",
    });
  });

  it("omits severity/category/source rather than guessing when the marker rotated past this fp", () => {
    const t = thread({ fp: "fp-rotated" });
    const applied: Reconciliation<StampedFinding> = { toCreate: [], toReply: [], toResolve: [t] };
    const prior = reviewState([{ fp: "fp-unrelated", severity: "low" }]);
    const p = expectOk(
      partitionFindings({ applied, findings: [], suppressed: [], priorThreads: [t], prior }),
    );
    expect(p.fixed).toEqual([{ fp: "fp-rotated", path: "src/a.ts", line: 10 }]);
  });
});

describe("partitionFindings — the two reconcile() edge cases", () => {
  it("reconcile.ts:189-196 — a duplicate-open-thread fp (toReply AND toResolve) lands in exactly one bucket", () => {
    const f = stampedFinding({ fp: "fp-dup" });
    const first = thread({ threadId: "T_first", fp: "fp-dup", replies: [authorReply] });
    const dup = thread({ threadId: "T_dup", fp: "fp-dup", replies: [authorReply] });
    const applied = reconcile([f], [first, dup]);
    expect(applied.toReply.map((r) => r.thread.threadId)).toEqual(["T_first"]);
    expect(applied.toResolve.map((t) => t.threadId)).toEqual(["T_dup"]);

    const p = expectOk(
      partitionFindings({
        applied,
        findings: [f],
        suppressed: [],
        priorThreads: [first, dup],
        prior: null,
      }),
    );
    // Precedence (dismissed → fixed → open → new): the toResolve entry claims the
    // fp as `fixed` first, so the toReply entry for the SAME fp never reaches `open`.
    expect(p.fixed.map((r) => r.fp)).toEqual(["fp-dup"]);
    expect(p.open).toEqual([]);
    expect(p.new).toEqual([]);
    expect(p.dismissed).toEqual([]);
  });

  it("reconcile.ts:169-174 — a loosely-matched already-resolved-thread blocker reaches no reconcile() bucket, but lands in open", () => {
    const f = stampedFinding({
      fp: "fp-orph",
      path: "src/x.ts",
      line: 12,
      severity: "blocker",
    });
    const t = thread({ fp: "fp-orph-t", path: "src/x.ts", line: 10, isResolved: true });
    const applied = reconcile([f], [t]);
    expect(applied.toCreate).toEqual([]);
    expect(applied.toReply).toEqual([]);
    expect(applied.toResolve).toEqual([]); // vanished from every reconcile() bucket

    const p = expectOk(
      partitionFindings({ applied, findings: [f], suppressed: [], priorThreads: [t], prior: null }),
    );
    expect(p.open).toEqual([
      {
        fp: "fp-orph",
        path: "src/x.ts",
        line: 12,
        severity: "blocker",
        category: "correctness",
      },
    ]);
  });
});

describe("partitionFindings — exhaustiveness and disjointness", () => {
  it("a multi-round scenario places every input fp in exactly one bucket", () => {
    const fresh = stampedFinding({ fp: "fp-new-1", path: "src/n.ts", line: 1 });
    // `kept`/`droppedThread`/`dismissedThread` match/don't-match by fp alone —
    // the default path ("src/a.ts") never collides with a real finding's path here.
    const kept = stampedFinding({ fp: "fp-keep-1" });
    const orphan = stampedFinding({
      fp: "fp-orph",
      path: "src/x.ts",
      line: 12,
      severity: "blocker",
    });
    const keepThread = thread({ threadId: "T_keep", fp: "fp-keep-1", replies: [authorReply] });
    const droppedThread = thread({ threadId: "T_drop", fp: "fp-fixed-1" });
    const dismissedThread = thread({
      threadId: "T_dismiss",
      fp: "fp-dism-1",
      dismissal: "explicit",
    });
    const orphanThread = thread({ fp: "fp-orph-t", path: "src/x.ts", line: 10, isResolved: true });
    const suppressedThread = thread({
      threadId: "T_sup",
      fp: "fp-sup-t",
      path: "src/s.ts",
      line: 5,
      isResolved: true,
    });
    const suppressed = stampedFinding({ fp: "fp-sup", path: "src/s.ts", line: 5 });
    const priorThreads = [
      keepThread,
      droppedThread,
      dismissedThread,
      orphanThread,
      suppressedThread,
    ];

    const applied = reconcile([fresh, kept, orphan], priorThreads);
    const p = expectOk(
      partitionFindings({
        applied,
        findings: [fresh, kept, orphan],
        suppressed: [suppressed],
        priorThreads,
        prior: null,
      }),
    );

    const seen = new Map<string, keyof PartitionedFindings>();
    for (const bucket of ["new", "open", "fixed", "dismissed"] as const) {
      for (const f of p[bucket]) {
        expect(seen.has(f.fp)).toBe(false); // disjoint: no fp appears twice
        seen.set(f.fp, bucket);
      }
    }
    expect(Object.fromEntries(seen)).toEqual({
      "fp-new-1": "new",
      "fp-keep-1": "open",
      "fp-orph": "open",
      "fp-fixed-1": "fixed",
      "fp-dism-1": "dismissed",
      "fp-sup": "dismissed",
    }); // exhaustive: every fp accounted for, each in exactly one bucket

    // Thread identity: fp is the join key, but a PHYSICAL thread must still
    // back at most one row across all four buckets — an fp-set check alone
    // cannot see this (see partition.ts's `reusedThreadId`).
    const threadBackedFps: [string, string][] = [
      ["fp-keep-1", keepThread.threadId],
      ["fp-fixed-1", droppedThread.threadId],
      ["fp-dism-1", dismissedThread.threadId],
      ["fp-sup", suppressedThread.threadId],
    ];
    for (const [fp] of threadBackedFps) expect(seen.has(fp)).toBe(true);
    expect(new Set(threadBackedFps.map(([, id]) => id)).size).toBe(threadBackedFps.length);
  });
});

describe("partitionFindings — the violation path", () => {
  it("signals a violation instead of guessing or throwing", () => {
    // (a) a suppressed finding no settled thread can explain.
    const unaccountable = stampedFinding({ fp: "fp-unaccountable" });
    const a = partitionFindings({
      applied: { toCreate: [], toReply: [], toResolve: [] },
      findings: [],
      suppressed: [unaccountable],
      priorThreads: [],
      prior: null,
    });
    expect(a.ok).toBe(false);
    if (a.ok) throw new Error("expected a violation");
    expect(a.reason).toContain("fp-unaccountable");

    // (b) applied.toCreate carries a fp `findings` doesn't account for.
    const stray = stampedFinding({ fp: "fp-stray" });
    const b = partitionFindings({
      applied: { toCreate: [stray], toReply: [], toResolve: [] },
      findings: [],
      suppressed: [],
      priorThreads: [],
      prior: null,
    });
    expect(b.ok).toBe(false);
  });
});
