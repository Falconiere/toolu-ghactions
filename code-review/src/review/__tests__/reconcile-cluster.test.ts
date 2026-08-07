// reconcile-cluster.test.ts — reconcile()/dropSettled() at CLUSTER level (spec
// §Layer 3, AC-12). Real data throughout: the findings are stamped with the real
// `fingerprint()` and grouped by the real `clusterFindings()`, so the 67-member
// cluster here is the one the pipeline would build. The unclustered rules are
// pinned unchanged in reconcile.test.ts / reconcile-loose.test.ts; the goldens at
// the bottom re-run two of those scenarios through the new signature.
import { describe, expect, it } from "vitest";
import { dropSettled, reconcile } from "@/review/reconcile.js";
import type { ClusterContext, ReconcileFinding } from "@/review/reconcile.js";
import { clusterFindings } from "@/review/cluster.js";
import type { FindingCluster } from "@/review/cluster.js";
import type { StampedFinding } from "@/pipeline/reviewCall.js";
import type { PriorThread } from "@/github/threads.js";
import { fingerprint } from "@/state.js";
import { authorReply, botReply, finding, thread } from "@/review/__tests__/reconcile-helpers.js";
import { classifyDismissals } from "@/review/dismissal.js";

const PATTERN_TEXT = "missing null check before dereferencing the config object";

/** One member of the repeated pattern: same category + text, its own path/line,
 *  stamped with the real fingerprint (identical to an unclustered run's fp). */
function member(i: number, severity: StampedFinding["severity"] = "high"): StampedFinding {
  const f = {
    path: `src/pkg/file${String(i).padStart(2, "0")}.ts`,
    line: 10 + i,
    severity,
    category: "correctness",
    text: PATTERN_TEXT,
  };
  return { ...f, fp: fingerprint(f) };
}

/** The 67 repeats of AC-4/AC-12; member 3 is a blocker to prove cluster-level
 *  settlement covers member blockers too. */
function pattern67(): StampedFinding[] {
  return Array.from({ length: 67 }, (_, i) => member(i, i === 3 ? "blocker" : "high"));
}

function contextOf(
  clusters: FindingCluster[],
  priorClusters?: Record<string, string>,
): ClusterContext<StampedFinding> {
  return {
    members: new Map(clusters.map((c) => [c.exemplar.fp, c.members])),
    ...(priorClusters ? { priorClusters } : {}),
  };
}

/** The marker's `clusters` field for a round: member fp -> exemplar fp. */
function clusterMap(clusters: FindingCluster[]): Record<string, string> {
  return Object.fromEntries(
    clusters.flatMap((c) => c.members.map((m) => [m.fp, c.exemplar.fp] as const)),
  );
}

describe("reconcile — cluster coverage", () => {
  it("one thread matching ONE member covers all 67: 1 reply, 0 creates, 0 resolves", () => {
    const members = pattern67();
    const clusters = clusterFindings(members);
    expect(clusters).toHaveLength(1); // 67 repeats collapsed to one exemplar
    const reps = clusters.map((c) => c.exemplar);
    const hit = members[42];
    if (!hit) throw new Error("fixture: member 42 missing");
    const t = thread({ fp: hit.fp, path: hit.path, line: hit.line, replies: [authorReply] });

    const plan = reconcile(reps, [t], contextOf(clusters));
    expect(plan.toCreate).toEqual([]); // no member may be re-posted
    expect(plan.toResolve).toEqual([]);
    expect(plan.toReply).toHaveLength(1);
    expect(plan.toReply[0]?.finding.fp).toBe(clusters[0]?.exemplar.fp);
    expect(plan.toReply[0]?.promoted).toBeUndefined();
  });

  it("keeps the thread OPEN with a promoted representative when only the exemplar is fixed", () => {
    const round1 = clusterFindings(pattern67());
    const exemplar1 = round1[0]?.exemplar;
    if (!exemplar1) throw new Error("fixture: no round-1 exemplar");
    const t = thread({ fp: exemplar1.fp, path: exemplar1.path, line: exemplar1.line });

    // Round 2: the exemplar's own finding is gone, the other 66 persist.
    const survivors = pattern67().filter((m) => m.fp !== exemplar1.fp);
    const round2 = clusterFindings(survivors, clusterMap(round1));
    const promoted = round2[0]?.exemplar;
    expect(survivors).toHaveLength(66);
    expect(promoted?.fp).not.toBe(exemplar1.fp);

    const plan = reconcile(
      round2.map((c) => c.exemplar),
      [t],
      contextOf(round2, clusterMap(round1)),
    );
    expect(plan.toResolve).toEqual([]); // the pattern survives — never report it fixed
    expect(plan.toCreate).toEqual([]);
    expect(plan.toReply).toEqual([{ thread: t, finding: promoted, promoted: true }]);
  });

  it("resolves the thread once EVERY member fp is gone", () => {
    const round1 = clusterFindings(pattern67());
    const exemplar1 = round1[0]?.exemplar;
    if (!exemplar1) throw new Error("fixture: no round-1 exemplar");
    const t = thread({ fp: exemplar1.fp, path: exemplar1.path, line: exemplar1.line });

    const plan = reconcile([], [t], contextOf([], clusterMap(round1)));
    expect(plan.toResolve).toEqual([t]);
    expect(plan.toReply).toEqual([]);
  });

  it("leaves a SECOND thread on a live cluster untouched (never resolved as fixed)", () => {
    const members = pattern67();
    const clusters = clusterFindings(members);
    const [a, b] = [members[1], members[2]];
    if (!a || !b) throw new Error("fixture: members missing");
    const first = thread({ threadId: "T_a", fp: a.fp, path: a.path, line: a.line });
    const extra = thread({ threadId: "T_b", fp: b.fp, path: b.path, line: b.line });

    const plan = reconcile(
      clusters.map((c) => c.exemplar),
      [first, extra],
      contextOf(clusters),
    );
    expect(plan.toResolve).toEqual([]);
    expect(plan.toCreate).toEqual([]);
  });

  // A cluster's EXTRA open thread is never resolved (its members are still live), but
  // it is still an unresolved bot thread — so the module's own contract holds for it:
  // unresolved thread + author had the last word → the author gets an answer. Silence
  // would strand a real question on a thread the bot has decided never to close.
  it("replies on a SECOND open thread of a live cluster when the author had the last word", () => {
    const members = pattern67();
    const clusters = clusterFindings(members);
    const [a, b] = [members[1], members[2]];
    if (!a || !b) throw new Error("fixture: members missing");
    const first = thread({ threadId: "T_a", fp: a.fp, path: a.path, line: a.line, replies: [] });
    // The real reply shape: the bot argued, the author answered after it. `thread()`
    // defaults to no replies, so this is spelled out rather than inherited.
    const extra = thread({
      threadId: "T_b",
      rootCommentId: 200,
      fp: b.fp,
      path: b.path,
      line: b.line,
      replies: [botReply, authorReply],
    });

    const plan = reconcile(
      clusters.map((c) => c.exemplar),
      [first, extra],
      contextOf(clusters),
    );
    expect(plan.toResolve).toEqual([]);
    expect(plan.toCreate).toEqual([]);
    // Exactly one reply, on the EXTRA thread, against the cluster's representative.
    expect(plan.toReply).toHaveLength(1);
    expect(plan.toReply[0]?.thread.threadId).toBe("T_b");
    expect(plan.toReply[0]?.finding.fp).toBe(clusters[0]?.exemplar.fp);
    expect(plan.toReply[0]?.promoted).toBeUndefined();
  });

  it("stays silent on a SECOND open thread whose last word was the BOT's", () => {
    const members = pattern67();
    const clusters = clusterFindings(members);
    const [a, b] = [members[1], members[2]];
    if (!a || !b) throw new Error("fixture: members missing");
    const first = thread({ threadId: "T_a", fp: a.fp, path: a.path, line: a.line, replies: [] });
    const extra = thread({
      threadId: "T_b",
      rootCommentId: 200,
      fp: b.fp,
      path: b.path,
      line: b.line,
      replies: [authorReply, botReply], // the bot already answered — nothing owed
    });

    const plan = reconcile(
      clusters.map((c) => c.exemplar),
      [first, extra],
      contextOf(clusters),
    );
    expect(plan.toReply).toEqual([]);
    expect(plan.toResolve).toEqual([]);
    expect(plan.toCreate).toEqual([]);
  });
});

describe("dropSettled — cluster settlement", () => {
  it("a settled thread on ONE member suppresses the whole cluster, blockers included", () => {
    const members = pattern67();
    const clusters = clusterFindings(members);
    const hit = members[10];
    const blocker = members[3];
    if (!hit || !blocker) throw new Error("fixture: members missing");
    expect(blocker.severity).toBe("blocker");
    const t = thread({ fp: hit.fp, path: hit.path, line: hit.line, isResolved: true });

    const clustered = dropSettled(
      clusters.map((c) => c.exemplar),
      [t],
      contextOf(clusters),
    );
    expect(clustered.kept).toEqual([]);
    expect(clustered.suppressed).toHaveLength(1); // the representative stands for all 67
    expect(clusters[0]?.members).toContain(blocker);

    // Without the cluster context the same thread reaches only its own member —
    // this is exactly what the cluster rule adds.
    const unclustered = dropSettled(members, [t]);
    expect(unclustered.suppressed).toEqual([hit]);
    expect(unclustered.kept).toContain(blocker);
  });

  // "exhausted" is the BOT conceding a stalemate, not a human ruling — so unlike a
  // GitHub resolution or an explicit `@toolu dismiss`, it must never take a
  // showstopper off the board. The dismissal here is produced by the REAL
  // classifier from a real reply chain (author → bot → author), not hand-stamped.
  describe("an exhausted argument never silences a blocker cluster", () => {
    const secondAuthorReply = {
      author: authorReply.author,
      body: "Still disagree — we have discussed this enough.",
    };

    /** Classify a thread the way the pipeline does: real replies, real permission gate. */
    async function exhaustedThreadOn(m: StampedFinding): Promise<PriorThread> {
      const raw = thread({
        threadId: "T_exhausted",
        fp: m.fp,
        path: m.path,
        line: m.line,
        replies: [authorReply, botReply, secondAuthorReply],
      });
      const [classified] = await classifyDismissals([raw], {
        triggerPhrase: "@toolu",
        minPermission: "write",
        lookupPermission: async () => "write",
      });
      if (!classified) throw new Error("fixture: classifyDismissals returned nothing");
      return classified;
    }

    it("keeps the whole cluster when the exhausted thread sits on its blocker member", async () => {
      const members = pattern67();
      const blocker = members[3];
      if (!blocker) throw new Error("fixture: blocker member missing");
      expect(blocker.severity).toBe("blocker");
      const clusters = clusterFindings(members);
      const t = await exhaustedThreadOn(blocker);
      // The classification is real, not asserted into existence.
      expect(t.dismissal).toBe("exhausted");
      expect(t.isResolved).toBe(false);

      const { kept, suppressed } = dropSettled(
        clusters.map((c) => c.exemplar),
        [t],
        contextOf(clusters),
      );
      expect(suppressed).toEqual([]);
      expect(kept).toHaveLength(1);
      expect(kept[0]?.fp).toBe(clusters[0]?.exemplar.fp);
    });

    it("keeps a mixed cluster when the exhausted thread strictly matches a NON-blocker member", async () => {
      // REGRESSION. Severity is not part of the cluster key, so a cluster routinely
      // mixes severities. The exemption used to be evaluated only AFTER the
      // match-strength prong, so an exhausted thread landing on a `high` member
      // matched strictly, settled the whole cluster, and silenced the `blocker`
      // sibling — measured SUPPRESSED:1 KEPT:0. The blocker exemption is now read
      // against the WHOLE cluster before any prong runs.
      const members = pattern67();
      const nonBlocker = members[10];
      const blocker = members[3];
      if (!nonBlocker || !blocker) throw new Error("fixture: members missing");
      expect(nonBlocker.severity).toBe("high");
      expect(blocker.severity).toBe("blocker");

      const clusters = clusterFindings(members);
      expect(clusters).toHaveLength(1);
      expect(clusters[0]?.members).toContain(blocker);
      const t = await exhaustedThreadOn(nonBlocker);
      expect(t.dismissal).toBe("exhausted");
      // The thread really does match that member strictly — the prong the exemption
      // now runs ahead of. Without the fix this alone settled the cluster.
      expect(t.fp).toBe(nonBlocker.fp);

      const { kept, suppressed } = dropSettled(
        clusters.map((c) => c.exemplar),
        [t],
        contextOf(clusters),
      );
      expect(suppressed).toEqual([]);
      expect(kept).toHaveLength(1);
      expect(kept[0]?.fp).toBe(clusters[0]?.exemplar.fp);
    });

    it("a HUMAN resolution on the same non-blocker member still settles the mixed cluster", () => {
      // The exemption is scoped to the argument-stalemate path only. A GitHub
      // resolution is a human ruling, and dismissing the exemplar dismisses the
      // pattern, blockers included (spec §Layer 3) — unchanged by the fix.
      const members = pattern67();
      const nonBlocker = members[10];
      if (!nonBlocker) throw new Error("fixture: member missing");
      const clusters = clusterFindings(members);
      const t = thread({
        fp: nonBlocker.fp,
        path: nonBlocker.path,
        line: nonBlocker.line,
        isResolved: true,
      });

      const { kept, suppressed } = dropSettled(
        clusters.map((c) => c.exemplar),
        [t],
        contextOf(clusters),
      );
      expect(kept).toEqual([]);
      expect(suppressed).toHaveLength(1);
    });

    it("an EXPLICIT `@toolu dismiss` on the same non-blocker member also settles the mixed cluster", async () => {
      // The second human channel, classified for real: an authorized author reply
      // carrying the command. Also unchanged — only "exhausted" is exempt.
      const members = pattern67();
      const nonBlocker = members[10];
      if (!nonBlocker) throw new Error("fixture: member missing");
      const clusters = clusterFindings(members);
      const raw = thread({
        threadId: "T_explicit",
        fp: nonBlocker.fp,
        path: nonBlocker.path,
        line: nonBlocker.line,
        replies: [{ author: "human-dev", body: "@toolu dismiss — intentional here." }],
      });
      const [t] = await classifyDismissals([raw], {
        triggerPhrase: "@toolu",
        minPermission: "write",
        lookupPermission: async () => "write",
      });
      if (!t) throw new Error("fixture: classifyDismissals returned nothing");
      expect(t.dismissal).toBe("explicit");

      const { kept, suppressed } = dropSettled(
        clusters.map((c) => c.exemplar),
        [t],
        contextOf(clusters),
      );
      expect(kept).toEqual([]);
      expect(suppressed).toHaveLength(1);
    });

    it("does settle an all-sub-blocker cluster on the same thread (the exemption is what differs)", async () => {
      // Identical setup minus the blocker severity: now the exhausted thread DOES
      // settle the pattern, proving the case above turns on the blocker, not on
      // "exhausted" being ignored wholesale.
      const members = Array.from({ length: 67 }, (_, i) => member(i));
      const target = members[3];
      if (!target) throw new Error("fixture: member missing");
      expect(target.severity).toBe("high");
      const clusters = clusterFindings(members);
      const t = await exhaustedThreadOn(target);
      expect(t.dismissal).toBe("exhausted");

      const { kept, suppressed } = dropSettled(
        clusters.map((c) => c.exemplar),
        [t],
        contextOf(clusters),
      );
      expect(kept).toEqual([]);
      expect(suppressed).toHaveLength(1);
    });
  });
});

describe("reconcile — unclustered goldens (byte-identical to the pre-cluster plan)", () => {
  const kept = finding({ fp: "fp-keep", path: "src/k.ts", line: 1 });
  const fresh = finding({ fp: "fp-fresh", path: "src/f.ts", line: 2 });
  const singletons: ClusterContext<ReconcileFinding> = {
    members: new Map([
      [kept.fp, [kept]],
      [fresh.fp, [fresh]],
    ]),
    priorClusters: {},
  };

  it("the mixed run (reconcile.test.ts) is unchanged with and without a context", () => {
    const keptThread = thread({
      threadId: "T_keep",
      fp: "fp-keep",
      path: "src/k.ts",
      line: 1,
      replies: [authorReply],
    });
    const droppedThread = thread({ threadId: "T_drop", fp: "fp-drop", path: "src/d.ts", line: 3 });
    const threads = [keptThread, droppedThread];

    const plan = reconcile([kept, fresh], threads);
    expect(plan.toCreate).toEqual([fresh]);
    expect(plan.toReply).toEqual([{ thread: keptThread, finding: kept }]);
    expect(plan.toResolve).toEqual([droppedThread]);
    expect(reconcile([kept, fresh], threads, singletons)).toEqual(plan);
  });

  it("duplicate-thread cleanup still resolves the extra for a SINGLETON cluster", () => {
    const first = thread({ threadId: "T_first", fp: "fp-keep", replies: [authorReply] });
    const dup = thread({ threadId: "T_dup", rootCommentId: 200, fp: "fp-keep", replies: [] });
    const threads = [first, dup];

    const plan = reconcile([kept], threads);
    expect(plan.toResolve.map((t) => t.threadId)).toEqual(["T_dup"]);
    expect(reconcile([kept], threads, singletons)).toEqual(plan);
  });
});
