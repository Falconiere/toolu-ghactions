// reconcile-loose.test.ts — the LOOSE matching prongs (line radius + detached-
// thread category) on both resolved-thread suppression (dropResolved) and open-
// thread reconciliation (reconcile). A re-raised finding is usually reworded
// (new fp) and line-drifted, so strict-only matching either resurrects settled
// findings forever or resolve-then-reinvents open ones — the non-convergence
// these prongs exist to stop. Split from reconcile.test.ts (file-size budget).
import { describe, expect, it } from "vitest";
import { dropResolved, reconcile } from "@/review/reconcile.js";
import { authorReply, finding, thread } from "@/review/__tests__/reconcile-helpers.js";

describe("dropResolved loose matching (resolved-thread convergence)", () => {
  it("suppresses a reworded finding within the line radius of a resolved thread", () => {
    // New fp (reworded) + drifted line: both strict prongs miss, radius covers it.
    const f = finding({ fp: "fp-reworded", line: 17 });
    const t = thread({ fp: "fp-original", line: 10, isResolved: true });
    const { kept, suppressed } = dropResolved([f], [t]);
    expect(kept).toEqual([]);
    expect(suppressed).toEqual([f]);
  });

  it("keeps a finding outside the line radius", () => {
    const f = finding({ fp: "fp-reworded", line: 25 });
    const t = thread({ fp: "fp-original", line: 10, isResolved: true });
    const { kept, suppressed } = dropResolved([f], [t]);
    expect(kept).toEqual([f]);
    expect(suppressed).toEqual([]);
  });

  it("never loose-suppresses a blocker (radius hit but severity blocker)", () => {
    const f = finding({ fp: "fp-reworded", line: 11, severity: "blocker" });
    const t = thread({ fp: "fp-original", line: 10, isResolved: true });
    const { kept } = dropResolved([f], [t]);
    expect(kept).toEqual([f]);
  });

  it("still suppresses a blocker on an exact fingerprint match (strict prong)", () => {
    const f = finding({ fp: "fp-shared", severity: "blocker" });
    const t = thread({ fp: "fp-shared", isResolved: true });
    const { suppressed } = dropResolved([f], [t]);
    expect(suppressed).toEqual([f]);
  });

  it("suppresses via same path + same category when the resolved thread is detached", () => {
    // Outdated resolved thread: line null, so only the category prong can cover it.
    const f = finding({ fp: "fp-reworded", line: 300, category: "correctness" });
    const t = thread({
      fp: "fp-original",
      line: null,
      isResolved: true,
      isOutdated: true,
      rootBody: "**medium** _(CORRECTNESS)_: some text\n\n<!-- toolu-fp:fp-original -->",
    });
    const { suppressed } = dropResolved([f], [t]);
    expect(suppressed).toEqual([f]);
  });

  it("keeps a detached-thread mismatch (different category)", () => {
    const f = finding({ fp: "fp-reworded", line: 300, category: "performance" });
    const t = thread({
      fp: "fp-original",
      line: null,
      isResolved: true,
      isOutdated: true,
      rootBody: "**medium** _(CORRECTNESS)_: some text\n\n<!-- toolu-fp:fp-original -->",
    });
    const { kept } = dropResolved([f], [t]);
    expect(kept).toEqual([f]);
  });

  it("parses the summary-style `_(CATEGORY · confidence)_` tag too", () => {
    const f = finding({ fp: "fp-reworded", line: 300, category: "doc/comment accuracy" });
    const t = thread({
      fp: "fp-original",
      line: null,
      isResolved: true,
      rootBody: "**low** _(DOC/COMMENT ACCURACY · high)_: text\n\n<!-- toolu-fp:fp-original -->",
    });
    const { suppressed } = dropResolved([f], [t]);
    expect(suppressed).toEqual([f]);
  });

  it("an UNRESOLVED nearby thread never suppresses", () => {
    const f = finding({ fp: "fp-reworded", line: 11 });
    const t = thread({ fp: "fp-original", line: 10, isResolved: false });
    const { kept } = dropResolved([f], [t]);
    expect(kept).toEqual([f]);
  });

  it("a resolved thread in a different path never suppresses", () => {
    const f = finding({ fp: "fp-reworded", line: 10, path: "src/b.ts" });
    const t = thread({ fp: "fp-original", line: 10, path: "src/a.ts", isResolved: true });
    const { kept } = dropResolved([f], [t]);
    expect(kept).toEqual([f]);
  });
});

describe("reconcile loose matching (open-thread convergence)", () => {
  it("a reworded + line-drifted persisting finding maps to its open thread — no resolve-then-reinvent churn", () => {
    // The model re-raised the same complaint reworded (new fp) after a push shifted
    // the anchor 3 lines. Strict-only matching resolved the old thread as "addressed"
    // and re-posted a duplicate — the churn that made reviews look non-convergent.
    const f = finding({ fp: "fp-reworded", line: 13 });
    const t = thread({ fp: "fp-original", line: 10, replies: [authorReply] });
    const plan = reconcile([f], [t]);
    expect(plan.toCreate).toEqual([]); // not re-posted as a duplicate
    expect(plan.toResolve).toEqual([]); // not falsely resolved
    expect(plan.toReply.map((r) => r.thread.threadId)).toEqual(["T_1"]); // answered in place
  });

  it("beyond the line radius the finding is genuinely new: create + resolve the old thread", () => {
    const f = finding({ fp: "fp-reworded", line: 25 });
    const t = thread({ fp: "fp-original", line: 10 });
    const plan = reconcile([f], [t]);
    expect(plan.toCreate).toEqual([f]);
    expect(plan.toResolve).toEqual([t]);
  });

  it("a detached (outdated) open thread covers a same-path same-category finding", () => {
    const f = finding({ fp: "fp-reworded", line: 300, category: "correctness" });
    const t = thread({
      fp: "fp-original",
      line: null,
      isOutdated: true,
      rootBody: "**medium** _(CORRECTNESS)_: some text\n\n<!-- toolu-fp:fp-original -->",
    });
    const plan = reconcile([f], [t]);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toResolve).toEqual([]);
    // No reply either: the thread has no author reply to answer, so the open
    // thread itself keeps stating the finding. "Covered, no action" is the
    // intended plan — the finding still counts toward the verdict; only a
    // duplicate inline post is avoided.
    expect(plan.toReply).toEqual([]);
  });

  it("open-thread loose matching applies to blockers too (nothing is hidden by it)", () => {
    // Unlike resolved-thread suppression, the loose open match only changes WHERE the
    // finding is posted — it still counts toward the verdict — so blockers participate.
    const f = finding({ fp: "fp-reworded", line: 12, severity: "blocker" });
    const t = thread({ fp: "fp-original", line: 10, replies: [authorReply] });
    const plan = reconcile([f], [t]);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toReply).toHaveLength(1);
  });

  it("strict match wins over a nearby candidate when both exist", () => {
    const exact = finding({ fp: "fp-exact", line: 30, text: "exact" });
    const nearby = finding({ fp: "fp-nearby", line: 11, text: "nearby" });
    const t = thread({ fp: "fp-exact", line: 10, replies: [authorReply] });
    const plan = reconcile([nearby, exact], [t]);
    // The thread maps to its exact-fp finding; the nearby one is genuinely new.
    expect(plan.toReply.map((r) => r.finding.text)).toEqual(["exact"]);
    expect(plan.toCreate.map((f) => f.text)).toEqual(["nearby"]);
  });
});
