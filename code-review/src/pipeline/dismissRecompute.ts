// pipeline/dismissRecompute.ts — the SETTLE pass a reply on one of the bot's inline
// threads runs (`pull_request_review_comment`, github/reviewCommentEvent.ts): recompute
// the verdict + label from the last completed round's stored findings minus the ones
// settled on their threads, and flip `request-changes` → `merge-approved` when nothing
// blocking remains — within that event's run, with NO model call, NO git, NO new
// findings and NO thread mutations (spec 2026-09-27-code-review-dismiss-settle).
//
// FAIL CLOSED end to end: every guard in pipeline/settleEvaluation.ts (the read-only
// half, shared with merge-gate's recompute) and review/recompute.ts ends the pass with a
// "[SKIP] settle: <reason>" line and zero GitHub writes. The only writes are the patched
// sticky (review/settledBody.ts) and the label, and only on an approval.
import { upsertComment } from "@/github/comment.js";
import type { CommentTarget } from "@/github/comment.js";
import { setVerdictLabel } from "@/github/label.js";
import { patchSettledBody } from "@/review/settledBody.js";
import { evaluateSettle } from "./settleEvaluation.js";
import type { SettleEvaluation } from "./settleEvaluation.js";
import type { ReviewDeps, ReviewResult } from "./types.js";

/** The result of a pass that changed nothing (logged with its reason). */
function skip(reason: string): ReviewResult {
  process.stderr.write(`[SKIP] settle: ${reason}\n`);
  return { verdict: "skip", findingsCount: 0, commentUrl: "" };
}

/** Human-readable log text for an evaluation that stopped before approving. */
const SKIP_TEXT: Record<Extract<SettleEvaluation, { kind: "skip" }>["reason"], string> = {
  "comments-unreadable": "could not list PR comments",
  "no-sticky": "no sticky review comment",
  "not-bot-sticky": "sticky comment is not bot-authored",
  "in-progress": "a review is in progress",
  "no-head": "could not read the PR's live head sha",
};

/** Run the settle pass for PR `prNumber`; see the module header. Never throws. */
export async function runDismissRecompute(
  deps: ReviewDeps,
  prNumber: number,
): Promise<ReviewResult> {
  const { inputs, octokit, context } = deps;
  const target: CommentTarget = { owner: context.repo.owner, repo: context.repo.repo, prNumber };
  if (!inputs.reviewMemory) return skip("REVIEW_MEMORY is off — no stored findings to recompute");

  const evaluation = await evaluateSettle({
    octokit,
    target,
    triggerPhrase: inputs.triggerPhrase,
    minPermission: inputs.minTriggerPermission,
    approveBelow: inputs.approveBelow,
    ...(deps.lookupPermission ? { lookupPermission: deps.lookupPermission } : {}),
    ...(deps.lookupHeadSha ? { lookupHeadSha: deps.lookupHeadSha } : {}),
  });
  if (evaluation.kind === "skip") {
    const text = SKIP_TEXT[evaluation.reason];
    return skip(evaluation.detail ? `${text} (${evaluation.detail})` : text);
  }
  if (evaluation.kind === "unchanged") return skip(evaluation.reason);
  const { outcome, sticky } = evaluation;

  const patched = patchSettledBody(sticky.body, outcome);
  if (patched === null) return skip("sticky comment layout not recognised");
  let commentUrl = sticky.url;
  if (patched !== sticky.body) {
    try {
      commentUrl = await upsertComment(octokit, target, patched, sticky.id);
    } catch (err) {
      return skip(`sticky update failed (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  // "approve" means the LABEL resolves to approved (review/recompute.ts): either nothing
  // remains, or everything left is below APPROVE_BELOW — the #124 rule, under which the
  // comment may still read "Changes requested" while the label is merge-approved.
  await setVerdictLabel(octokit, "approved", target, { manageLabels: inputs.manageLabels });
  process.stdout.write(
    `  Settle: ${outcome.settled} of ${outcome.total} finding(s) settled — label merge-approved, no model call\n`,
  );
  return { verdict: outcome.verdict, findingsCount: outcome.remaining.length, commentUrl };
}
