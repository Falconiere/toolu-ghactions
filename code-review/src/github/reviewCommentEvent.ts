// github/reviewCommentEvent.ts — resolve a `pull_request_review_comment` delivery (a
// reply on an inline review thread) into the deterministic SETTLE pass: recompute the
// verdict/label from the last completed review's stored findings, with NO model call
// (spec docs/toolu/specs/2026-09-27-code-review-dismiss-settle-design.md). Split out
// of event.ts, which dispatches here, to keep both files within the line budget.
//
// There is deliberately NO permission gate at this trigger: the settle pass only READS
// stored state and thread replies, and every settlement channel it honours (an
// explicit `<phrase> dismiss`, an argued-out reply) keeps its own FAIL-CLOSED
// permission gate in review/dismissal.ts. Gating here would only add an API call.
import type { EventPayload, EventResolution, ResolveOptions } from "./event.js";

/**
 * Resolve a review-comment event. Only a just-CREATED, human, REPLY comment settles
 * anything: a bot reply (the action's own resolve notes) must never loop, a top-level
 * review comment opens a new thread rather than answering one, and an edit/delete
 * is not a new settling reply. Never throws.
 */
export function resolveReviewComment(
  payload: EventPayload,
  opts: Pick<ResolveOptions, "ownLogin">,
): EventResolution {
  const ownLogin = opts.ownLogin ?? "github-actions[bot]";
  const action = payload.action ?? "created";
  if (action !== "created") return deny("unsupported-action");

  const commenter = payload.comment?.user?.login ?? "";
  if (payload.comment?.user?.type === "Bot" || commenter === ownLogin) return deny("bot-author");
  if (payload.comment?.in_reply_to_id == null) return deny("not-a-reply");

  const prNumber = payload.pull_request?.number;
  if (!prNumber) return deny("no-pr-number");
  const headSha = payload.pull_request?.head?.sha;

  return {
    run: true,
    reason: "review-comment-settle",
    settle: true,
    base_ref: payload.pull_request?.base?.ref ?? "",
    full_review: false,
    pr_number: prNumber,
    commenter,
    ...(headSha !== undefined && headSha !== "" ? { head_sha: headSha } : {}),
  };
}

/** A run=false decision with its machine-readable reason. */
function deny(reason: string): EventResolution {
  return { run: false, reason, full_review: false };
}
