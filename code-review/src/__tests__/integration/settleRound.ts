// settleRound.ts — the shared round-1 fixture for the settle scenarios (13: the
// code-review settle pass, 14: merge-gate's read-only recompute). A REAL completed
// review round (runReview against a scratch repo + the local model server) asks for
// changes and posts its inline threads; the scenarios then settle those threads and
// run their pass on the same persisted GitHub store.
import { expect } from "vitest";
import { runReview } from "@/pipeline.js";
import { writeFile } from "@/git/__tests__/helpers.js";
import { extractFpMarker } from "@/review/fpmarker.js";
import type { ActionInputs } from "@/inputs.js";
import { baseInputs, lastBody, prContext, scratchRepo } from "./harness.js";
import { fakeOctokit } from "./github.js";
import type { Recorded, SeedThread } from "./github.js";
import { changes, modelServer, type ScriptedFinding } from "./model.js";

export const DISMISS = "@toolu dismiss — intentional, see ADR-12";
export const path = (n: number): string => `src/f${n}.ts`;

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
export async function reviewedRound(
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

export type Round = Awaited<ReturnType<typeof reviewedRound>>;

/** Snapshot every GitHub mutation + model call, to prove a run added none. */
export function writes(round: Round, rec: Recorded = round.rec) {
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

/** A human `@toolu dismiss` reply on `thread`. */
export function dismiss(thread: SeedThread | undefined, author = "human-dev"): void {
  if (!thread) throw new Error("fixture: missing thread");
  thread.replies = [{ author, body: DISMISS }];
}
