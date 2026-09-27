// pipeline/settleEvaluation.ts — the READ-ONLY half of the settle recompute, shared by
// the code-review settle pass (pipeline/dismissRecompute.ts, which then writes the
// sticky + label) and merge-gate's recompute (gate/settleCheck.ts, which writes
// nothing). One implementation, so both callers agree on what "settled" means.
//
// It locates the sticky, trusts it only when Bot-authored and not mid-review, reads the
// PR's LIVE head, keeps only the threads that same bot opened, classifies dismissals,
// and runs review/recompute.ts. Every refusal is a typed skip reason (fail closed).
// Two trust checks exist because the sticky lookup is login-agnostic
// (github/comment.ts): otherwise anyone able to comment could post a forged state
// marker (or a forged fp-marked thread) and approve through this cheap path.
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

  const threads = await classifyDismissals(
    ownThreads(await fetchReviewThreads(deps.octokit, deps.target), sticky),
    {
      triggerPhrase: deps.triggerPhrase,
      minPermission: deps.minPermission,
      lookupPermission: deps.lookupPermission,
    },
  );
  const outcome = recomputeVerdict({
    state: asReviewState(decodeMarker(sticky.body)),
    headSha,
    threads,
    approveBelow: deps.approveBelow,
  });
  if (outcome.kind === "unchanged") return { kind: "unchanged", reason: outcome.reason };
  return { kind: "approve", outcome, sticky };
}

/** The PR's head sha right now, or null when it cannot be read (fail closed). */
async function liveHead(deps: SettleEvalDeps): Promise<string | null> {
  if (!deps.lookupHeadSha) return null;
  try {
    const sha = await deps.lookupHeadSha(deps.target.prNumber);
    return sha === "" ? null : sha;
  } catch {
    return null;
  }
}

/** Only the threads opened by the sticky's own author. REST spells an App's login
 *  `name[bot]`, GraphQL spells the same thread root `name` — compare without it. */
function ownThreads(threads: PriorThread[], sticky: StickyComment): PriorThread[] {
  const bot = bare(sticky.author?.login ?? "");
  if (bot === "") return [];
  return threads.filter((t) => bare(t.botLogin) === bot);
}

function bare(login: string): string {
  return login.replace(/\[bot\]$/, "");
}
