// github/event.ts — normalize a `pull_request` OR `issue_comment` event into a
// single review decision. Port of resolve-event.sh.
//
// A `pull_request` event always runs a FULL review of HEAD. An `issue_comment`
// event is an `@toolu review …` re-trigger; because issue_comment runs with the
// repo's secrets, the permission gate FAILS CLOSED — ANY uncertainty (the
// permission lookup throwing, or returning no permission string) means
// run=false. A bot-authored comment never triggers, and an @mention that
// carries an instruction runs a SCOPED review (full_review=false).

/** The fields of the GitHub event payload this resolver reads (loose by design). */
export interface EventContext {
  /** The event name, e.g. "pull_request" or "issue_comment". */
  eventName: string;
  /** The parsed event payload (`$GITHUB_EVENT_PATH` JSON), or null when absent. */
  payload: EventPayload | null;
}

/** Loose payload shape — only the fields the resolver touches are typed. */
export interface EventPayload {
  pull_request?: {
    number?: number;
    base?: { ref?: string };
    head?: { sha?: string; ref?: string };
  };
  issue?: { number?: number; pull_request?: unknown };
  comment?: { id?: number; body?: string; user?: { login?: string; type?: string } };
}

/** Tunables, mirroring the env vars resolve-event.sh reads (passed in, never env). */
export interface ResolveOptions {
  /** The mention phrase (default "@toolu"); the trigger is "<phrase> review". */
  triggerPhrase?: string;
  /** Permission floor: "write" accepts {admin,write}; "admin" accepts {admin}. */
  minTriggerPermission?: "write" | "admin";
  /** The action's own bot login, used to ignore self-authored comments. */
  ownLogin?: string;
  /**
   * Look up a commenter's repo permission, returning the GitHub permission string
   * ("admin" | "write" | "read" | "none") or throwing on any API error. Injected
   * so tests drive the fail-closed paths with no network. Used only on @mention.
   */
  lookupPermission?: (commenter: string) => Promise<string>;
  /**
   * Resolve the PR base ref for an @mention re-trigger (the bash GETs the PR).
   * Best-effort — a throw is swallowed and base_ref falls back to "".
   */
  lookupBaseRef?: (prNumber: number) => Promise<string>;
}

/** The single review decision emitted by {@link resolveEvent}. */
export interface EventResolution {
  /** Whether to run a review at all. */
  run: boolean;
  /** Machine-readable reason (always set when run=false; set to the trigger when run=true). */
  reason?: string;
  /** The git ref to review ("HEAD" for pull_request, "FETCH_HEAD" for an @mention). */
  review_head?: string;
  /** The PR base ref to diff against. */
  base_ref?: string;
  /** The trimmed instruction text after "<phrase> review" (@mention only). */
  instruction?: string;
  /** True for a whole-PR review; false when an @mention instruction scopes it. */
  full_review: boolean;
  /** The PR number, when resolved. */
  pr_number?: number;
  /** The triggering commenter login (@mention only). */
  commenter?: string;
  /** The triggering comment id (@mention only, on the allowed path). */
  comment_id?: number;
}

/**
 * Resolve an event into a review decision.
 *
 * `pull_request` → run a full review of HEAD. `issue_comment` → gate on the
 * `@toolu review` trigger and a fail-closed permission floor. Any other event,
 * a missing payload, a bot author, a non-PR comment, a missing trigger, or a
 * failed/insufficient permission check all yield `run:false`. Never throws.
 */
export async function resolveEvent(
  ctx: EventContext,
  opts: ResolveOptions = {},
): Promise<EventResolution> {
  if (!ctx.payload) return deny("no-event-payload");

  switch (ctx.eventName) {
    case "pull_request":
      return resolvePullRequest(ctx.payload);
    case "issue_comment":
      return resolveIssueComment(ctx.payload, opts);
    default:
      return deny("unsupported-event");
  }
}

/** A `pull_request` event: full review of HEAD, base from `.pull_request.base.ref`. */
function resolvePullRequest(payload: EventPayload): EventResolution {
  const prNumber = payload.pull_request?.number;
  if (!prNumber) return deny("no-pr-number");
  return {
    run: true,
    reason: "pull_request",
    review_head: "HEAD",
    base_ref: payload.pull_request?.base?.ref ?? "",
    full_review: true,
    pr_number: prNumber,
  };
}

/**
 * An `issue_comment` event. Cheap guards first (bot author, not-a-PR, no
 * trigger), then the fail-closed permission gate, then the allowed decision.
 */
async function resolveIssueComment(
  payload: EventPayload,
  opts: ResolveOptions,
): Promise<EventResolution> {
  const triggerPhrase = opts.triggerPhrase ?? "@toolu";
  const minPermission = opts.minTriggerPermission ?? "write";
  const ownLogin = opts.ownLogin ?? "github-actions[bot]";

  // Guard 1: ignore bot authors (the action's own comments included).
  const commenter = payload.comment?.user?.login ?? "";
  const userType = payload.comment?.user?.type ?? "";
  if (userType === "Bot" || commenter === ownLogin) return deny("bot-author");

  // Guard 2: the comment must be on a pull request, not a plain issue.
  if (payload.issue?.pull_request == null) return deny("not-a-pull-request");

  // Guard 3: the body must contain "<phrase> review" (case-insensitive). The
  // instruction is the trimmed remainder, sliced from the ORIGINAL body so it
  // keeps its case.
  const body = payload.comment?.body ?? "";
  const triggerLc = `${triggerPhrase.toLowerCase()} review`;
  const idx = body.toLowerCase().indexOf(triggerLc);
  if (idx < 0) return deny("no-trigger");
  const instruction = body.slice(idx + triggerLc.length).trim();

  const prNumber = payload.issue?.number;
  const commentId = payload.comment?.id;

  // Permission gate — FAIL CLOSED. A throw (curl error / non-2xx in the bash)
  // or a falsy permission string both deny.
  let permission = "";
  try {
    permission = (await opts.lookupPermission?.(commenter)) ?? "";
  } catch {
    return deny("permission-check-failed", { commenter });
  }
  if (!permission) return deny("permission-check-failed", { commenter });

  const allowed =
    minPermission === "admin"
      ? permission === "admin"
      : permission === "admin" || permission === "write";
  if (!allowed) return deny("insufficient-permission", { commenter });

  // Allowed. Resolve the base ref best-effort (a throw → "").
  let baseRef = "";
  if (prNumber !== undefined && opts.lookupBaseRef) {
    try {
      baseRef = await opts.lookupBaseRef(prNumber);
    } catch {
      baseRef = "";
    }
  }

  return {
    run: true,
    reason: "mention",
    review_head: "FETCH_HEAD",
    base_ref: baseRef,
    // full_review=false ONLY when an instruction scopes the review.
    full_review: instruction === "",
    instruction,
    ...(prNumber !== undefined ? { pr_number: prNumber } : {}),
    commenter,
    ...(commentId !== undefined ? { comment_id: commentId } : {}),
  };
}

/** Build a run=false decision with a reason and optional commenter. */
function deny(reason: string, extra: { commenter?: string } = {}): EventResolution {
  return {
    run: false,
    reason,
    full_review: false,
    ...(extra.commenter !== undefined ? { commenter: extra.commenter } : {}),
  };
}
