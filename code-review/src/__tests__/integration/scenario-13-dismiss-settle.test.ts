// scenario-13-dismiss-settle — issue #125, end to end. A REAL completed review round
// (runReview against a scratch repo + the local model server) asks for changes and
// posts its inline threads; then a `pull_request_review_comment` reply runs the SETTLE
// pass on the same persisted GitHub store. Settling the last open thread must flip the
// label to merge-approved within that run — with no model call, no git, no new
// findings, no thread mutations — and every fail-closed variant must write nothing.
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { runReview } from "@/pipeline.js";
import type { ReviewDeps } from "@/pipeline.js";
import { writeFile } from "@/git/__tests__/helpers.js";
import { decodeMarker, encodeMarker, extractMarker } from "@/state.js";
import type { ReviewState } from "@/state.js";
import { extractFpMarker } from "@/review/fpmarker.js";
import { inProgressBody } from "@/pipeline/bodies.js";
import { asReviewState } from "@/pipeline/sticky.js";
import type { ActionInputs } from "@/inputs.js";
import {
  baseInputs,
  cleanupRepos,
  lastBody,
  prContext,
  scratchRepo,
  settleContext,
} from "./harness.js";
import { fakeOctokit } from "./github.js";
import type { CommentUser, Recorded, SeedThread } from "./github.js";
import { changes, modelServer, type ScriptedFinding } from "./model.js";

afterEach(cleanupRepos);

const DISMISS = "@toolu dismiss — intentional, see ADR-12";
const path = (n: number): string => `src/f${n}.ts`;

function finding(n: number, severity: ScriptedFinding["severity"]): ScriptedFinding {
  return {
    path: path(n),
    line: 1,
    severity,
    confidence: "high",
    category: "correctness",
    quoted_line: `export const f${n} = ${n};`,
    text: `Export f${n} leaks an internal constant (${severity}).`,
  };
}

/** Round 1: a real review that asks for changes on `severities.length` files, then the
 *  bot threads GitHub would show for the inline comments it posted. */
async function reviewedRound(
  severities: ScriptedFinding["severity"][],
  inputs: Partial<ActionInputs> = {},
) {
  const { dir, headSha } = scratchRepo((d) => {
    severities.forEach((_, i) => writeFile(d, path(i), `export const f${i} = ${i};\n`));
  });
  const threads: SeedThread[] = [];
  const { octokit, rec } = fakeOctokit({ threads });
  const server = modelServer({ reply: () => changes(severities.map((s, i) => finding(i, s))) });
  const round1 = await runReview({
    inputs: baseInputs({ manageLabels: true, ...inputs }),
    octokit,
    context: prContext(headSha),
    cwd: dir,
    fetch: server.fetch,
    lookupPermission: async () => "write",
  });
  expect(round1.verdict).toBe("changes");
  const posted = rec.reviews.flatMap((r) => r.comments);
  expect(posted).toHaveLength(severities.length);
  posted.forEach((c, i) => {
    threads.push({
      threadId: `T${i}`,
      rootCommentId: 5000 + i,
      fp: extractFpMarker(c.body) ?? "",
      path: c.path,
      line: c.line ?? null,
      rootBody: c.body,
    });
  });
  return { dir, headSha, octokit, rec, threads, server, body: lastBody(rec) };
}

type Round = Awaited<ReturnType<typeof reviewedRound>>;

/** The settle run: a reply on thread `root`, with the live head and permission given. */
function settle(round: Round, over: Partial<ReviewDeps> = {}, inputs: Partial<ActionInputs> = {}) {
  return runReview({
    // No API key: the settle workflow never holds the model secret, and the pass must
    // not depend on it (readInputs allows it empty on this event).
    inputs: baseInputs({ manageLabels: true, apiKey: "", ...inputs }),
    octokit: round.octokit,
    context: settleContext(round.headSha, DISMISS, 5000),
    // A directory that does not exist: the settle pass must never touch git.
    cwd: join(round.dir, "no-such-dir"),
    fetch: round.server.fetch,
    lookupPermission: async () => "write",
    lookupHeadSha: async () => round.headSha,
    ...over,
  });
}

/** Snapshot every GitHub mutation + model call, to prove a run added none. */
function writes(round: Round, rec: Recorded = round.rec) {
  return {
    model: round.server.calls.length,
    created: rec.created.length,
    updated: rec.updated.length,
    reviews: rec.reviews.length,
    replies: rec.replies.length,
    resolved: rec.resolved.length,
    added: rec.addedLabels.length,
    removed: rec.removedLabels.length,
  };
}

function dismiss(thread: SeedThread | undefined, author = "human-dev"): void {
  if (!thread) throw new Error("fixture: missing thread");
  thread.replies = [{ author, body: DISMISS }];
}

describe("scenario 13 — @toolu dismiss settles the verdict without a model call (#125)", () => {
  it("AC-1: dismissing the last open thread flips the label to merge-approved in that run", async () => {
    const round = await reviewedRound(["medium"]);
    dismiss(round.threads[0]);
    const before = writes(round);

    const result = await settle(round);

    expect(result.verdict).toBe("approved");
    const after = writes(round);
    expect(after.model).toBe(before.model); // no model call
    expect(after.reviews).toBe(before.reviews); // no new findings posted
    expect(after.replies).toBe(before.replies); // no bot reply
    expect(after.resolved).toBe(before.resolved); // no thread resolution
    expect(after.updated).toBe(before.updated + 1);
    expect(round.rec.removedLabels.at(-1)).toBe("request-changes");
    expect(round.rec.addedLabels.at(-1)).toEqual(["merge-approved"]);

    const body = lastBody(round.rec);
    expect(body).toContain("**Verdict:** ✅ Approved");
    expect(body).toContain("> ✅ **Settled:** 1 of 1 finding(s)");
    expect(body.split("\n")).toContain("`merge-approved`");
    expect(extractMarker(body)).toBe(extractMarker(round.body)); // marker byte-identical
  });

  it("is idempotent: a second reply re-asserts the label but does not rewrite the comment", async () => {
    const round = await reviewedRound(["medium"]);
    dismiss(round.threads[0]);
    await settle(round);
    const before = writes(round);
    expect((await settle(round)).verdict).toBe("approved");
    expect(writes(round).updated).toBe(before.updated);
  });

  it("AC-2: a newer push (live head differs) changes nothing", async () => {
    const round = await reviewedRound(["medium"]);
    dismiss(round.threads[0]);
    const before = writes(round);
    const result = await settle(round, { lookupHeadSha: async () => "f".repeat(40) });
    expect(result.verdict).toBe("skip");
    expect(writes(round)).toEqual(before);
  });

  it("AC-2: a failing or absent live-head lookup fails closed", async () => {
    const round = await reviewedRound(["medium"]);
    dismiss(round.threads[0]);
    const before = writes(round);
    const failing = async (): Promise<string> => {
      throw new Error("pulls.get 502");
    };
    expect((await settle(round, { lookupHeadSha: failing })).verdict).toBe("skip");
    expect((await settle(round, { lookupHeadSha: undefined })).verdict).toBe("skip");
    expect(writes(round)).toEqual(before);
  });

  it("AC-3: an incomplete round, an errored round, or no sticky at all changes nothing", async () => {
    const round = await reviewedRound(["medium"]);
    dismiss(round.threads[0]);
    const state = asReviewState(decodeMarker(extractMarker(round.body) ?? ""));
    if (state === null) throw new Error("fixture: no marker");
    const variants: ReviewState[] = [
      { ...state, pending_paths: ["src/late.ts"] },
      { ...state, history: state.history.map((h) => ({ ...h, verdict: "error" })) },
    ];
    for (const variant of variants) {
      const marker = extractMarker(round.body) ?? "";
      const { octokit, rec } = fakeOctokit({
        existing: [{ id: 1, body: round.body.replace(marker, encodeMarker(variant)) }],
        threads: round.threads,
      });
      const r = await settle(round, { octokit });
      expect(r.verdict).toBe("skip");
      expect(writes(round, rec)).toMatchObject({ updated: 0, added: 0, removed: 0 });
    }
    const empty = fakeOctokit({ threads: round.threads });
    expect((await settle(round, { octokit: empty.octokit })).verdict).toBe("skip");
    expect(writes(round, empty.rec)).toMatchObject({
      created: 0,
      updated: 0,
      added: 0,
      removed: 0,
    });
  });

  it("AC-4: dismissing one of two blocking findings changes nothing", async () => {
    const round = await reviewedRound(["medium", "high"]);
    dismiss(round.threads[0]);
    const before = writes(round);
    expect((await settle(round)).verdict).toBe("skip");
    expect(writes(round)).toEqual(before);
  });

  it("AC-4: a remainder below APPROVE_BELOW flips the label while the verdict still reads changes", async () => {
    const round = await reviewedRound(["high", "medium"], { approveBelow: "high" });
    expect(round.rec.addedLabels.at(-1)).toEqual(["request-changes"]);
    dismiss(round.threads.find((t) => t.path === path(0)));
    const result = await settle(round, {}, { approveBelow: "high" });
    expect(result.verdict).toBe("changes");
    expect(round.rec.addedLabels.at(-1)).toEqual(["merge-approved"]);
    const body = lastBody(round.rec);
    expect(body).toContain("⚠️ Changes requested");
    expect(body).toContain("> ✅ **Settled:** 1 of 2 finding(s)");
  });

  it("AC-6: a marker comment posted by a human is never trusted", async () => {
    const round = await reviewedRound(["medium"]);
    dismiss(round.threads[0]);
    const mallory: CommentUser = { login: "mallory", type: "User" };
    const { octokit, rec } = fakeOctokit({
      existing: [{ id: 1, body: round.body, user: mallory }],
      threads: round.threads,
    });
    expect((await settle(round, { octokit })).verdict).toBe("skip");
    expect(writes(round, rec)).toMatchObject({ updated: 0, added: 0, removed: 0 });
  });

  it("AC-6: a settled thread opened by another login does not count", async () => {
    const round = await reviewedRound(["medium"]);
    const [real] = round.threads;
    if (!real) throw new Error("fixture");
    // Mallory re-opens the finding's fingerprint under her own root comment and
    // "dismisses" it there; the bot's real thread stays open.
    round.threads.splice(0, 1, {
      ...real,
      threadId: "TX",
      botLogin: "mallory",
      replies: [{ author: "human-dev", body: DISMISS }],
    });
    round.threads.push(real);
    const before = writes(round);
    expect((await settle(round)).verdict).toBe("skip");
    expect(writes(round)).toEqual(before);
  });

  it("AC-8: a dismiss from a read-only user settles nothing", async () => {
    const round = await reviewedRound(["medium"]);
    dismiss(round.threads[0], "drive-by");
    const before = writes(round);
    expect((await settle(round, { lookupPermission: async () => "read" })).verdict).toBe("skip");
    expect(writes(round)).toEqual(before);
  });

  it("AC-9: an in-progress sticky is left alone", async () => {
    const round = await reviewedRound(["medium"]);
    dismiss(round.threads[0]);
    const running = inProgressBody(prContext(round.headSha), extractMarker(round.body));
    const { octokit, rec } = fakeOctokit({
      existing: [{ id: 1, body: running }],
      threads: round.threads,
    });
    expect((await settle(round, { octokit })).verdict).toBe("skip");
    expect(writes(round, rec)).toMatchObject({ updated: 0, added: 0, removed: 0 });
  });
});
