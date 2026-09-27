// pipeline/dismissRecompute.ts — the SETTLE pass a reply on one of the bot's inline
// threads runs (`pull_request_review_comment`, github/reviewCommentEvent.ts): recompute
// the verdict + label from the last completed round's stored findings minus the ones
// settled on their threads, and flip `request-changes` → `merge-approved` when nothing
// blocking remains — within that event's run, with NO model call, NO git, NO new
// findings and NO thread mutations (spec 2026-09-27-code-review-dismiss-settle).
//
// FAIL CLOSED end to end: every guard below, and every guard in review/recompute.ts,
// ends the pass with a "[SKIP] settle: <reason>" line and zero GitHub writes. The only
// writes are the patched sticky (review/settledBody.ts) and the label, and only on an
// approval. Two trust checks exist because the sticky lookup is login-agnostic
// (github/comment.ts): the sticky must be Bot-authored, and only threads opened by
// that same bot may settle anything — otherwise anyone able to comment could post a
// forged state marker (or a forged fp-marked thread) and approve through this path.
import { findSticky, upsertComment } from "@/github/comment.js";
import type { CommentTarget, StickyComment } from "@/github/comment.js";
import { setVerdictLabel } from "@/github/label.js";
import { fetchReviewThreads } from "@/github/threads.js";
import type { PriorThread } from "@/github/threads.js";
import { classifyDismissals } from "@/review/dismissal.js";
import { recomputeVerdict } from "@/review/recompute.js";
import { patchSettledBody } from "@/review/settledBody.js";
import { decodeMarker } from "@/state.js";
import { asReviewState } from "./sticky.js";
import type { ReviewDeps, ReviewResult } from "./types.js";

/** The result of a pass that changed nothing (logged with its reason). */
function skip(reason: string): ReviewResult {
  process.stderr.write(`[SKIP] settle: ${reason}\n`);
  return { verdict: "skip", findingsCount: 0, commentUrl: "" };
}

/** Run the settle pass for PR `prNumber`; see the module header. Never throws. */
export async function runDismissRecompute(
  deps: ReviewDeps,
  prNumber: number,
): Promise<ReviewResult> {
  const { inputs, octokit, context } = deps;
  const target: CommentTarget = { owner: context.repo.owner, repo: context.repo.repo, prNumber };
  if (!inputs.reviewMemory) return skip("REVIEW_MEMORY is off — no stored findings to recompute");

  const sticky = await findSticky(octokit, target).catch(() => null);
  if (sticky === null) return skip("no sticky review comment");
  if (sticky.author?.type !== "Bot") return skip("sticky comment is not bot-authored");

  const headSha = await liveHead(deps, prNumber);
  if (headSha === null) return skip("could not read the PR's live head sha");

  const threads = await classifyDismissals(
    ownThreads(await fetchReviewThreads(octokit, target), sticky),
    {
      triggerPhrase: inputs.triggerPhrase,
      minPermission: inputs.minTriggerPermission,
      lookupPermission: deps.lookupPermission,
    },
  );
  const outcome = recomputeVerdict({
    state: asReviewState(decodeMarker(sticky.body)),
    headSha,
    threads,
    approveBelow: inputs.approveBelow,
  });
  if (outcome.kind === "unchanged") return skip(outcome.reason);

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
  await setVerdictLabel(octokit, "approved", target, { manageLabels: inputs.manageLabels });
  process.stdout.write(
    `  Settle: ${outcome.settled} of ${outcome.total} finding(s) settled — label merge-approved, no model call\n`,
  );
  return { verdict: outcome.verdict, findingsCount: outcome.remaining.length, commentUrl };
}

/** The PR's head sha right now, or null when it cannot be read (fail closed). */
async function liveHead(deps: ReviewDeps, prNumber: number): Promise<string | null> {
  if (!deps.lookupHeadSha) return null;
  try {
    const sha = await deps.lookupHeadSha(prNumber);
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
