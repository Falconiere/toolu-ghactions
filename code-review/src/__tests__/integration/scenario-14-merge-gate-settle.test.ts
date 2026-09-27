// scenario-14-merge-gate-settle — issue #123, end to end. merge-gate's read-only
// recompute (gate/settleCheck.ts, bundled as the merge-gate/recompute nested action)
// reads the SAME stored round the code-review settle pass does (scenario 13), and
// reports whether every finding on the live head is settled — with no model call and
// zero GitHub writes, so the gate can pass on a reply alone. Every fail-closed variant
// reports `unchanged` with its reason.
import { afterEach, describe, expect, it } from "vitest";
import { decodeMarker, encodeMarker, extractMarker } from "@/state.js";
import { inProgressBody } from "@/pipeline/bodies.js";
import { asReviewState } from "@/pipeline/sticky.js";
import { runSettleCheck } from "@/gate/settleCheck.js";
import type { SettleEvalDeps } from "@/pipeline/settleEvaluation.js";
import { cleanupRepos, prContext } from "./harness.js";
import { fakeOctokit } from "./github.js";
import type { CommentUser } from "./github.js";
import { dismiss, reviewedRound, writes } from "./settleRound.js";
import type { Round } from "./settleRound.js";

afterEach(cleanupRepos);

/** merge-gate's recompute over `round`'s store, with the live head and permission given. */
function check(round: Round, over: Partial<SettleEvalDeps> = {}) {
  return runSettleCheck({
    octokit: round.octokit,
    target: { owner: "test-org", repo: "test-repo", prNumber: 7 },
    triggerPhrase: "@toolu",
    minPermission: "write",
    approveBelow: "nit",
    lookupPermission: async () => "write",
    lookupHeadSha: async () => round.headSha,
    ...over,
  });
}

/** The round's stored state with `patch` applied, served from a fresh store. */
function storeWith(round: Round, body: string, user?: CommentUser) {
  return fakeOctokit({
    existing: [{ id: 1, body, ...(user ? { user } : {}) }],
    threads: round.threads,
  });
}

describe("scenario 14 — merge-gate recomputes settled findings read-only (#123)", () => {
  it("AC-1: one resolved + one dismissed finding → approve, with zero writes and no model call", async () => {
    const round = await reviewedRound(["medium", "medium"]);
    const [resolved, dismissed] = round.threads;
    if (!resolved) throw new Error("fixture: missing thread");
    resolved.isResolved = true;
    dismiss(dismissed);
    const before = writes(round);

    const out = await check(round);

    expect(out).toEqual({
      outcome: "approve",
      reason: "",
      verdict: "approved",
      settled: 2,
      total: 2,
    });
    expect(writes(round)).toEqual(before);
  });

  it("AC-1: an advisory remainder below approve-below still approves the label", async () => {
    const round = await reviewedRound(["high", "medium"], { approveBelow: "high" });
    dismiss(round.threads.find((t) => t.path === "src/f0.ts"));
    const out = await check(round, { approveBelow: "high" });
    expect(out).toMatchObject({ outcome: "approve", verdict: "changes", settled: 1, total: 2 });
  });

  it("AC-2: a newer push (live head differs) → unchanged stale-head", async () => {
    const round = await reviewedRound(["medium"]);
    dismiss(round.threads[0]);
    const before = writes(round);
    const out = await check(round, { lookupHeadSha: async () => "f".repeat(40) });
    expect(out).toMatchObject({ outcome: "unchanged", reason: "stale-head" });
    expect(writes(round)).toEqual(before);
  });

  it("AC-2: a failing or absent live-head lookup → unchanged no-head", async () => {
    const round = await reviewedRound(["medium"]);
    dismiss(round.threads[0]);
    const failing = async (): Promise<string> => {
      throw new Error("pulls.get 502");
    };
    expect(await check(round, { lookupHeadSha: failing })).toMatchObject({
      outcome: "unchanged",
      reason: "no-head",
    });
    expect(await check(round, { lookupHeadSha: undefined })).toMatchObject({
      outcome: "unchanged",
      reason: "no-head",
    });
  });

  it("AC-2: an incomplete round → unchanged incomplete", async () => {
    const round = await reviewedRound(["medium"]);
    dismiss(round.threads[0]);
    const marker = extractMarker(round.body) ?? "";
    const state = asReviewState(decodeMarker(marker));
    if (state === null) throw new Error("fixture: no marker");
    const body = round.body.replace(
      marker,
      encodeMarker({ ...state, pending_paths: ["src/late.ts"] }),
    );
    const { octokit, rec } = storeWith(round, body);
    expect(await check(round, { octokit })).toMatchObject({
      outcome: "unchanged",
      reason: "incomplete",
    });
    expect(writes(round, rec)).toMatchObject({ created: 0, updated: 0, added: 0, removed: 0 });
  });

  it("AC-2: one of two blocking findings still open → unchanged still-blocking", async () => {
    const round = await reviewedRound(["medium", "high"]);
    dismiss(round.threads[0]);
    expect(await check(round)).toMatchObject({ outcome: "unchanged", reason: "still-blocking" });
  });

  it("AC-2: a marker comment posted by a human is never trusted", async () => {
    const round = await reviewedRound(["medium"]);
    dismiss(round.threads[0]);
    const { octokit } = storeWith(round, round.body, { login: "mallory", type: "User" });
    expect(await check(round, { octokit })).toMatchObject({
      outcome: "unchanged",
      reason: "not-bot-sticky",
    });
  });

  it("AC-2: a review in progress on the same head → unchanged in-progress", async () => {
    const round = await reviewedRound(["medium"]);
    dismiss(round.threads[0]);
    const running = inProgressBody(prContext(round.headSha), extractMarker(round.body));
    const { octokit } = storeWith(round, running);
    expect(await check(round, { octokit })).toMatchObject({
      outcome: "unchanged",
      reason: "in-progress",
    });
  });

  it("AC-2: no sticky at all → unchanged no-sticky", async () => {
    const round = await reviewedRound(["medium"]);
    const { octokit } = fakeOctokit({ threads: round.threads });
    expect(await check(round, { octokit })).toMatchObject({
      outcome: "unchanged",
      reason: "no-sticky",
    });
  });

  it("AC-2: an unreadable comment list → unchanged comments-unreadable", async () => {
    const round = await reviewedRound(["medium"]);
    dismiss(round.threads[0]);
    const { octokit } = fakeOctokit({ threads: round.threads });
    octokit.rest.issues.listComments = async () => {
      throw new Error("HTTP 403: Resource not accessible by integration");
    };
    expect(await check(round, { octokit })).toMatchObject({
      outcome: "unchanged",
      reason: "comments-unreadable",
    });
  });
});
