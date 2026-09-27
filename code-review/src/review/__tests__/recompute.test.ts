import { describe, it, expect } from "vitest";
import { diffState, fingerprint } from "@/state.js";
import type { Finding, ReviewState } from "@/state.js";
import type { PriorThread } from "@/github/threads.js";
import { recomputeVerdict } from "@/review/recompute.js";

// The stored state is built by the REAL diffState — exactly the marker a completed
// review round writes — and the threads are PriorThreads shaped as fetchReviewThreads +
// classifyDismissals hand them over. No part of the recompute is stubbed.
const HEAD = "9891331d0123456789abcdef0123456789abcdef";
const BOT = "toolu-bot";

function finding(path: string, line: number, severity: string, text: string): Finding {
  return { path, line, severity, category: "correctness", text, confidence: "high" };
}

function stored(
  findings: Finding[],
  over: { verdict?: string; complete?: boolean; clusters?: Record<string, string> } = {},
): ReviewState {
  return diffState({
    prior: null,
    current_findings: findings,
    scope: { in_scope_paths: [], full_review: true },
    head_sha: HEAD,
    verdict: over.verdict ?? "changes",
    now: () => 1_790_000_000_000,
    complete: over.complete ?? true,
    ...(over.complete === false ? { pending_paths: ["src/late.ts"] } : {}),
    ...(over.clusters ? { clusters: over.clusters } : {}),
  }).next_state;
}

function thread(f: Finding, over: Partial<PriorThread> = {}): PriorThread {
  return {
    threadId: `T_${String(f.path)}_${String(f.line)}`,
    rootCommentId: 100 + Number(f.line ?? 0),
    fp: fingerprint(f),
    path: String(f.path),
    line: typeof f.line === "number" ? f.line : null,
    isResolved: false,
    isOutdated: false,
    rootBody: `**finding** ${String(f.text)}`,
    replies: [{ author: "human-dev", body: "@toolu dismiss — intentional" }],
    botLogin: BOT,
    ...over,
  };
}

const MEDIUM = finding("src/a.ts", 3, "medium", "Rename this export for clarity.");
const HIGH = finding("src/b.ts", 9, "high", "Unbounded retry loop can spin forever.");
const BLOCKER = finding("src/c.ts", 5, "blocker", "SQL built by string concatenation.");

const run = (state: ReviewState | null, threads: PriorThread[], over: { head?: string } = {}) =>
  recomputeVerdict({ state, headSha: over.head ?? HEAD, threads, approveBelow: "nit" });

describe("recomputeVerdict — guards (fail closed)", () => {
  it("no stored state → unchanged", () => {
    expect(run(null, [])).toEqual({ kind: "unchanged", reason: "no-state" });
  });

  it("a newer head than the reviewed one → unchanged (stale)", () => {
    const state = stored([MEDIUM]);
    expect(
      run(state, [thread(MEDIUM, { dismissal: "explicit" })], { head: "f".repeat(40) }),
    ).toEqual({
      kind: "unchanged",
      reason: "stale-head",
    });
  });

  it("an incomplete last round (exception paths recorded) → unchanged", () => {
    const state = stored([MEDIUM], { complete: false });
    expect(run(state, [thread(MEDIUM, { dismissal: "explicit" })])).toEqual({
      kind: "unchanged",
      reason: "incomplete",
    });
  });

  it("a marker with no completed round at this head → unchanged", () => {
    const state: ReviewState = { ...stored([MEDIUM]), history: [] };
    expect(run(state, [thread(MEDIUM, { dismissal: "explicit" })]).kind).toBe("unchanged");
    expect(run({ ...state, reviewed_sha: undefined }, []).kind).toBe("unchanged");
  });

  it("a last verdict of error or approved is never turned into an approval", () => {
    for (const verdict of ["error", "approved"]) {
      const state = stored([MEDIUM], { verdict });
      expect(run(state, [thread(MEDIUM, { dismissal: "explicit" })])).toEqual({
        kind: "unchanged",
        reason: "not-changes",
      });
    }
  });
});

describe("recomputeVerdict — settlement", () => {
  it("dismissing the only finding approves, with nothing remaining", () => {
    const out = run(stored([MEDIUM]), [thread(MEDIUM, { dismissal: "explicit" })]);
    expect(out).toMatchObject({
      kind: "approve",
      verdict: "approved",
      remaining: [],
      settled: 1,
      total: 1,
    });
  });

  it("a thread resolved on GitHub settles its finding too", () => {
    const out = run(stored([MEDIUM]), [thread(MEDIUM, { isResolved: true, replies: [] })]);
    expect(out).toMatchObject({ kind: "approve", verdict: "approved" });
  });

  it("an unsettled second finding keeps the verdict blocked", () => {
    const out = run(stored([MEDIUM, HIGH]), [
      thread(MEDIUM, { dismissal: "explicit" }),
      thread(HIGH, { replies: [] }),
    ]);
    expect(out).toEqual({ kind: "unchanged", reason: "still-blocking" });
  });

  it("a remainder strictly below APPROVE_BELOW approves the label while the verdict stays changes", () => {
    const low = finding("src/d.ts", 2, "medium", "Prefer a const here.");
    const out = recomputeVerdict({
      state: stored([HIGH, low]),
      headSha: HEAD,
      threads: [thread(HIGH, { dismissal: "explicit" })],
      approveBelow: "high",
    });
    expect(out).toMatchObject({ kind: "approve", verdict: "changes", settled: 1, total: 2 });
    expect(out.kind === "approve" ? out.remaining.map((f) => f.path) : []).toEqual(["src/d.ts"]);
  });

  it("nothing settled → unchanged even when the remainder is already advisory", () => {
    const out = recomputeVerdict({
      state: stored([MEDIUM]),
      headSha: HEAD,
      threads: [],
      approveBelow: "high",
    });
    expect(out).toEqual({ kind: "unchanged", reason: "nothing-settled" });
  });

  it("an argued-out thread settles a non-blocker but never a blocker", () => {
    expect(run(stored([MEDIUM]), [thread(MEDIUM, { dismissal: "exhausted" })]).kind).toBe(
      "approve",
    );
    expect(run(stored([BLOCKER]), [thread(BLOCKER, { dismissal: "exhausted" })])).toEqual({
      kind: "unchanged",
      reason: "nothing-settled",
    });
  });

  it("an explicit dismiss is a human ruling and settles a blocker", () => {
    expect(run(stored([BLOCKER]), [thread(BLOCKER, { dismissal: "explicit" })]).kind).toBe(
      "approve",
    );
  });

  it("dismissing a cluster's exemplar settles every member", () => {
    const members = ["src/m1.ts", "src/m2.ts", "src/m3.ts"].map((p) =>
      finding(p, 4, "medium", "Missing await on the returned promise."),
    );
    const [exemplar] = members;
    if (!exemplar) throw new Error("fixture");
    const exemplarFp = fingerprint(exemplar);
    const clusters = Object.fromEntries(members.map((m) => [fingerprint(m), exemplarFp]));
    const out = run(stored(members, { clusters }), [thread(exemplar, { dismissal: "explicit" })]);
    expect(out).toMatchObject({ kind: "approve", verdict: "approved", settled: 3, total: 3 });
  });

  it("a stored finding with no severity stays blocking (fail closed)", () => {
    const bare: Finding = { path: "src/e.ts", line: 1, category: "correctness", text: "Odd." };
    const out = run(stored([MEDIUM, bare]), [thread(MEDIUM, { dismissal: "explicit" })]);
    expect(out).toEqual({ kind: "unchanged", reason: "still-blocking" });
  });
});
