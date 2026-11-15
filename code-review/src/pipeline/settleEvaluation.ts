// pipeline/settleEvaluation.ts — the READ-ONLY half of the settle recompute. The
// code-review settle pass (pipeline/dismissRecompute.ts) runs it, then writes the
// sticky + label.
//
// It locates the sticky, trusts it only when Bot-authored and not mid-review, reads the
// PR's LIVE head, reads only the threads that same bot opened (github/threads.ts filters
// on the sticky's author), classifies dismissals, and runs review/recompute.ts. Every
// refusal is a typed skip reason (fail closed) — an unreadable thread list included.
// The trust checks exist because otherwise anyone able to comment could post a forged
// state marker (or a forged fp-marked thread) and approve through this cheap path.
import { errorMessage } from "@/errors.js";
import { findSticky } from "@/github/comment.js";
import type { CommentClient, CommentTarget, StickyComment } from "@/github/comment.js";
import { fetchReviewThreads } from "@/github/threads.js";
import type { PriorThread, ThreadClient } from "@/github/threads.js";
import type { Severity } from "@/llm/schema.js";
import { classifyDismissals } from "@/review/dismissal.js";
import { recomputeVerdict } from "@/review/recompute.js";
import type { RecomputeOutcome, UnchangedReason } from "@/review/recompute.js";
import { isInProgressBody } from "@/review/settledBody.js";
import { decodeMarker } from "@/state.js";
import { asReviewState } from "./sticky.js";

/** What {@link evaluateSettle} reads. Both lookups fail closed when absent. */
export interface SettleEvalDeps {
  octokit: CommentClient & ThreadClient;
  target: CommentTarget;
  /** TRIGGER_PHRASE — the `<phrase> dismiss` command prefix. */
  triggerPhrase: string;
  /** MIN_TRIGGER_PERMISSION — the floor a dismissing login must clear. */
  minPermission: "write" | "admin";
  /** APPROVE_BELOW — findings below it do not block the label. */
  approveBelow: Severity;
  lookupPermission?: (login: string) => Promise<string>;
  /** The PR's LIVE head sha (not the event payload's). */
  lookupHeadSha?: (prNumber: number) => Promise<string>;
}

/** Why the evaluation stopped before recomputing. */
export type SettleSkipReason =
  | "comments-unreadable"
  | "no-sticky"
  | "not-bot-sticky"
  | "in-progress"
  | "no-head";

/** The evaluation's decision; only "approve" carries what a caller may act on. */
export type SettleEvaluation =
  | { kind: "skip"; reason: SettleSkipReason; detail?: string }
  | { kind: "unchanged"; reason: UnchangedReason }
  | {
      kind: "approve";
      outcome: Extract<RecomputeOutcome, { kind: "approve" }>;
      sticky: StickyComment;
    };

/** Evaluate the settle recompute for `deps.target`; see the module header. Never throws
 *  on a GitHub error — each read failure maps to a skip or to "nothing settled". */
export async function evaluateSettle(deps: SettleEvalDeps): Promise<SettleEvaluation> {
  let sticky: StickyComment | null;
  try {
    sticky = await findSticky(deps.octokit, deps.target);
  } catch (err) {
    return {
      kind: "skip",
      reason: "comments-unreadable",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (sticky === null) return { kind: "skip", reason: "no-sticky" };
  // Proceed ONLY on an explicit "Bot" author: a "User", an empty or an absent type all
  // skip — an author we cannot identify as the bot is never trusted (fail closed).
  if (sticky.author?.type !== "Bot") return { kind: "skip", reason: "not-bot-sticky" };
  // A review running on this PR may still change the findings; its in-progress body
  // carries the PRIOR marker, so recomputing it would judge a round being replaced.
  if (isInProgressBody(sticky.body)) return { kind: "skip", reason: "in-progress" };

  const headSha = await liveHead(deps);
  if (headSha === null) return { kind: "skip", reason: "no-head" };

  let own: PriorThread[];
  try {
    own = await fetchReviewThreads(deps.octokit, deps.target, sticky.author.login);
  } catch (err) {
    return { kind: "skip", reason: "comments-unreadable", detail: errorMessage(err) };
  }
  const threads = await classifyDismissals(own, {
    triggerPhrase: deps.triggerPhrase,
    minPermission: deps.minPermission,
    lookupPermission: deps.lookupPermission,
  });
  const outcome = recomputeVerdict({
    state: asReviewState(decodeMarker(sticky.body)),
    headSha,
    threads,
    approveBelow: deps.approveBelow,
  });
  if (outcome.kind === "unchanged") return { kind: "unchanged", reason: outcome.reason };
  return { kind: "approve", outcome, sticky };
}

/**
 * The review path's freshness check (pipeline.ts): true when `sha` is no longer the
 * PR's live head, logged as `[SKIP] stale-head`. An unknown sha, or a lookup that is
 * absent or fails, is NOT stale — the review proceeds exactly as it always has.
 */
export async function staleHead(
  deps: Pick<SettleEvalDeps, "target" | "lookupHeadSha">,
  sha: string | undefined,
): Promise<boolean> {
  if (sha === undefined || sha === "") return false;
  const live = await liveHead(deps);
  if (live === null || live === sha) return false;
  process.stderr.write(`[SKIP] stale-head: reviewed ${sha}, but the PR head is now ${live}\n`);
  return true;
}

/** The PR's head sha right now, or null when it cannot be read (the settle path then
 *  fails closed). */
async function liveHead(
  deps: Pick<SettleEvalDeps, "target" | "lookupHeadSha">,
): Promise<string | null> {
  if (!deps.lookupHeadSha) return null;
  try {
    const sha = await deps.lookupHeadSha(deps.target.prNumber);
    return sha === "" ? null : sha;
  } catch {
    return null;
  }
}
