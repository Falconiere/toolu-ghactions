// github/event.ts — normalize a `pull_request` OR `issue_comment` event into a
// single review decision. Port of resolve-event.sh.
//
// A `pull_request` event always runs a FULL review of HEAD. An `issue_comment`
// event is an `@toolu review …` re-trigger — or an `@toolu resume`, which reruns
// only the last round's exception paths behind the SAME permission gate (spec
// §True incremental + resumable); because issue_comment runs with the
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
  /**
   * The webhook's repository object. Present on every real repo-scoped delivery
   * (`pull_request` and `issue_comment` alike) — `id` is GitHub's numeric,
   * globally-sequential repo id, read by `main.ts`'s `buildContext()` for
   * review-run reporting (see `report/payload.ts`'s "IDENTITY GAP").
   */
  repository?: { id?: number; full_name?: string };
  pull_request?: {
    number?: number;
    base?: { ref?: string };
    head?: { sha?: string; ref?: string };
    /** The PR's title/body — UNTRUSTED author text. Read by the Layer 1
     *  cartographer (sanitized + fenced, src/review/cartographer.ts). */
    title?: string;
    body?: string;
    /** The PR's opener. Read by `buildContext()` on a `pull_request` event —
     *  on an `issue_comment` re-trigger the author lives on `issue.user` instead
     *  (see that field's own doc). */
    user?: { login?: string };
  };
  issue?: {
    number?: number;
    pull_request?: unknown;
    /**
     * The PR's opener, on an `issue_comment` event. GitHub represents a pull
     * request's comment thread as its "issue" twin, whose `user` is the account
     * that opened the PR — NOT the commenter (`comment.user`, below). Real
     * `issue_comment` deliveries always carry this on an issue/PR that exists.
     */
    user?: { login?: string };
    /** The PR's title/body on an `issue_comment` event (GitHub mirrors a PR's
     *  fields onto its "issue" twin) — UNTRUSTED, same use as `pull_request`'s. */
    title?: string;
    body?: string;
  };
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
  /**
   * The PR HEAD sha (`.pull_request.head.sha`, pull_request events only). The
   * incremental-review series must converge on this, NOT on GITHUB_SHA: on
   * pull_request events GITHUB_SHA is the ephemeral test-merge commit, orphaned
   * on every push, so a stored merge sha never resolves (or ancestor-checks) on
   * the next run and the incremental scope would silently stay null forever.
   */
  head_sha?: string;
  /** The trimmed instruction text after "<phrase> review" (@mention only). */
  instruction?: string;
  /** True for a whole-PR review; false when an @mention instruction scopes it,
   *  and always false on a `<phrase> resume` (which reviews exception paths only). */
  full_review: boolean;
  /**
   * Set by the `<phrase> resume` trigger: review ONLY the last round's exception
   * paths (`unreviewed_paths` ∪ `pending_paths`) and do NOT clear the reviewed
   * state (spec §True incremental + resumable). Absent on every other path —
   * `<phrase> review` remains the full re-review escape hatch.
   */
  resume?: boolean;
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
  const headSha = payload.pull_request?.head?.sha;
  return {
    run: true,
    reason: "pull_request",
    review_head: "HEAD",
    base_ref: payload.pull_request?.base?.ref ?? "",
    full_review: true,
    pr_number: prNumber,
    ...(headSha !== undefined && headSha !== "" ? { head_sha: headSha } : {}),
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

  // Guard 3: the body must contain "<phrase> review" or "<phrase> resume"
  // (case-insensitive). The instruction is the trimmed remainder, sliced from the
  // ORIGINAL body so it keeps its case.
  const trigger = findTrigger(payload.comment?.body ?? "", triggerPhrase.toLowerCase());
  if (trigger === null) return deny("no-trigger");
  const { resume, instruction } = trigger;

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
  if (!meetsPermission(permission, minPermission)) {
    return deny("insufficient-permission", { commenter });
  }

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
    reason: resume ? "mention-resume" : "mention",
    review_head: "FETCH_HEAD",
    base_ref: baseRef,
    // full_review=false ONLY when an instruction scopes the review — and never on a
    // resume, which re-reviews the exception paths alone.
    full_review: !resume && instruction === "",
    ...(resume ? { resume: true } : {}),
    instruction,
    ...(prNumber !== undefined ? { pr_number: prNumber } : {}),
    commenter,
    ...(commentId !== undefined ? { comment_id: commentId } : {}),
  };
}

/** Escape a user-supplied phrase for literal use inside a RegExp. Mirrors
 *  review/dismissal.ts's helper of the same name (kept local — see this
 *  module's header: no shared regex-trigger module exists yet). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find the review trigger in a comment body: `<phrase> review` (full re-review) or
 * `<phrase> resume` (spec §True incremental — re-review the exception paths only,
 * same permission gate, reviewed state NOT cleared). Both are matched
 * case-insensitively; when a body carries both, the FIRST one wins, so the
 * remainder sliced as the instruction always belongs to the trigger that fired.
 * Returns null when neither phrase appears.
 *
 * `resume` is matched with `\s+resume(?!\w)` — same technique as
 * review/dismissal.ts's `dismiss` command — so "@toolu resumed the discussion"
 * (or `resumes`/`resuming`) is ordinary prose, not the trigger: an unanchored
 * `indexOf("${phrase} resume")` would fire on the "resume" PREFIX of "resumed"
 * and hand the rest of that word ("d the discussion...") to the model as its
 * instruction. `review`'s match is intentionally left as the plain `indexOf` it
 * already was — that has the same class of weakness (e.g. "reviewed"), but it
 * is PRE-EXISTING behavior from before this fix and out of scope here.
 */
function findTrigger(
  body: string,
  phrase: string,
): { resume: boolean; instruction: string } | null {
  const lower = body.toLowerCase();
  const reviewAt = lower.indexOf(`${phrase} review`);
  const resumeMatch = new RegExp(`${escapeRegExp(phrase)}\\s+resume(?!\\w)`, "i").exec(body);
  const candidates = [
    { resume: false, at: reviewAt, length: phrase.length + 7 },
    ...(resumeMatch
      ? [{ resume: true, at: resumeMatch.index, length: resumeMatch[0].length }]
      : []),
  ].filter((c) => c.at >= 0);
  if (candidates.length === 0) return null;
  const first = candidates.reduce((a, b) => (a.at <= b.at ? a : b));
  return { resume: first.resume, instruction: body.slice(first.at + first.length).trim() };
}

/**
 * True when a GitHub permission string clears the configured floor: `"write"`
 * accepts {admin, write}, `"admin"` accepts {admin} only. An empty/unknown
 * string never clears it — every caller is a FAIL-CLOSED gate. Shared with the
 * thread-dismissal gate (review/dismissal.ts) so the two cannot drift.
 */
export function meetsPermission(permission: string, min: "write" | "admin"): boolean {
  if (min === "admin") return permission === "admin";
  return permission === "admin" || permission === "write";
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
