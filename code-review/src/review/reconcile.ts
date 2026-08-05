// review/reconcile.ts — decide, deterministically, what to do with the bot's prior
// inline review threads given THIS run's findings. Pure (no I/O): the pipeline executes
// the plan. This is what stops the "re-raise the same finding every run" loop:
//
//   - toResolve: an unresolved bot thread whose finding is GONE this run → the model
//     re-reviewed (with the author's reply in its prompt) and dropped it → close the thread.
//   - toReply:   a finding that PERSISTS and maps to an unresolved thread where the author
//     had the last word → post the bot's counter-reasoning IN that thread (no duplicate).
//   - toCreate:  a finding with no matching prior thread → a genuinely new inline comment.
//
// A finding maps to a thread by fingerprint (stable across line drift) OR by exact
// path+line (catches a reworded argument posted at the same spot). A finding that maps to
// ANY prior thread — even a settled one — is never re-posted, so a settled thread is
// respected rather than reopened. "Settled" is a GitHub resolution, an author-side
// dismissal detected in the replies (see review/dismissal.ts), OR the bot's durable
// acceptance note left behind when an earlier resolve mutation failed. {@link
// dropSettled} removes those findings BEFORE this plan is built, so a settled thread
// normally has nothing left matching it and lands in toResolve.
import { hasAcceptedResolutionNote } from "@/github/threads.js";
import type { PriorThread } from "@/github/threads.js";

/** The finding fields reconciliation needs (validated finding + its attached fingerprint). */
export interface ReconcileFinding {
  path: string;
  line: number;
  fp: string;
  text: string;
  severity?: string;
  category?: string;
}

/** A bot reply owed on an existing thread, paired with the finding that justifies it. */
export interface ReplyAction<F extends ReconcileFinding = ReconcileFinding> {
  thread: PriorThread;
  finding: F;
}

/** The executable plan: fresh comments to post, in-place replies, and threads to resolve.
 *  Generic over the finding type so the caller's richer Finding flows through toCreate. */
export interface Reconciliation<F extends ReconcileFinding = ReconcileFinding> {
  toCreate: F[];
  toReply: ReplyAction<F>[];
  toResolve: PriorThread[];
}

/** A current finding is "the same" as a prior thread by fingerprint or exact path+line. */
function matches(f: ReconcileFinding, t: PriorThread): boolean {
  if (f.fp === t.fp) return true;
  return f.path === t.path && t.line !== null && f.line === t.line;
}

/** How far (in lines) a prior thread's coverage reaches for a reworded finding. */
export const NEARBY_LINE_RADIUS = 10;

/** The `_(CATEGORY)_` tag the bot renders in its inline root comments, normalised
 *  for comparison; null when the body carries none. */
function threadCategory(rootBody: string): string | null {
  const m = /_\(([^)·]+?)(?:\s*·[^)]*)?\)_/.exec(rootBody);
  return m?.[1] === undefined ? null : m[1].trim().toLowerCase();
}

/**
 * The LOOSE prongs shared by resolved- and open-thread coverage: a reworded,
 * line-drifted finding still covers within {@link NEARBY_LINE_RADIUS} lines,
 * or — when the thread has gone detached (line null) — by matching rendered
 * category. Deliberately severity-blind: the blocker exemption lives in
 * {@link matchesSettled}, the only SUPPRESSION path — here the loose prongs
 * only relocate where a finding is posted, never hide it.
 */
function matchesNearby(f: ReconcileFinding, t: PriorThread): boolean {
  if (f.path !== t.path) return false;
  if (t.line !== null) return Math.abs(f.line - t.line) <= NEARBY_LINE_RADIUS;
  const category = threadCategory(t.rootBody);
  return category !== null && category === (f.category ?? "").trim().toLowerCase();
}

/** A settled thread: resolved on GitHub, dismissed by the author, or carrying
 *  the bot's accepted-resolution note after an earlier resolve mutation failed.
 *  In every case the finding is not the bot's to re-raise. Exported so a
 *  reporting consumer (report/partition.ts) can attribute WHICH thread settled
 *  a suppressed finding without re-deriving this logic. */
export function isSettled(t: PriorThread): boolean {
  return t.isResolved || t.dismissal !== undefined || hasAcceptedResolutionNote(t);
}

/**
 * Does a SETTLED thread cover this finding? Strict {@link matches} widened by
 * {@link matchesNearby}, except a blocker never settles on the loose prongs
 * (suppression HIDES the finding, so only an exact match may) and an
 * `"exhausted"` thread — the bot conceding, not a human ruling — never
 * silences a blocker at any strength. Exported for report/partition.ts, which
 * attributes a `suppressed` finding's settlement to the thread that matched it.
 */
export function matchesSettled(f: ReconcileFinding, t: PriorThread): boolean {
  const blocker = f.severity === "blocker";
  if (blocker && t.dismissal === "exhausted") return false;
  if (matches(f, t)) return true;
  if (blocker) return false;
  return matchesNearby(f, t);
}

/** True when ANY prior thread covers this finding, strictly or nearby — the
 *  incremental scope keeps such findings in play (adjudication of an existing
 *  discussion), while genuinely new out-of-scope findings are dropped. */
export function coveredByThread(f: ReconcileFinding, threads: PriorThread[]): boolean {
  return threads.some((t) => matches(f, t) || matchesNearby(f, t));
}

/** True when the last comment in the thread is the author's (a reply the bot hasn't answered). */
function authorHasLastWord(thread: PriorThread): boolean {
  const last = thread.replies.at(-1);
  if (!last) return false; // no replies yet → the thread already states the finding; stay silent
  // Unattributable logins (a null GitHub author, surfaced as "") — stay silent rather than risk
  // replying to our own comment or to a deleted-account ghost we can't distinguish from the bot.
  if (last.author === "" || thread.botLogin === "") return false;
  return last.author !== thread.botLogin;
}

/**
 * Split this run's findings on whether a SETTLED prior thread covers them — one
 * resolved on GitHub, dismissed in a reply (review/dismissal.ts), or carrying the
 * bot's accepted-resolution note after a failed mutation. Each is a decision, so
 * the finding must vanish everywhere (verdict count, verdict comment, inline
 * posting), not just from re-posting. Matching is {@link matchesSettled} —
 * reconcile()'s strict rules widened with a line radius and an outdated-thread
 * category prong, because a re-raised finding is usually reworded (new fp) and
 * line-drifted while the settled thread itself has gone outdated (line null).
 * Blockers only ever match strictly, and never at all on an `"exhausted"` thread.
 */
export function dropSettled<F extends ReconcileFinding>(
  findings: F[],
  priorThreads: PriorThread[],
): { kept: F[]; suppressed: F[] } {
  const settled = priorThreads.filter(isSettled);
  const kept: F[] = [];
  const suppressed: F[] = [];
  for (const f of findings) {
    (settled.some((t) => matchesSettled(f, t)) ? suppressed : kept).push(f);
  }
  return { kept, suppressed };
}

/**
 * Partition this run's findings against the bot's prior threads into a {create,
 * reply, resolve} plan (module header has the rules). Mapping is STRICT-FIRST
 * ({@link matches}) then widened to {@link matchesNearby}: a persisting finding
 * is usually reworded (new fp) and line-drifted, and strict-only matching would
 * resolve the old thread and re-post a duplicate — the resolve-then-reinvent
 * churn. The loose prong hides nothing (only the posting location changes), so
 * unlike {@link matchesResolved} it applies to blockers too.
 */
export function reconcile<F extends ReconcileFinding>(
  findings: F[],
  priorThreads: PriorThread[],
): Reconciliation<F> {
  const covered = new Set<number>(); // finding indices represented by ANY prior thread
  const open = new Set<number>(); // finding indices that already keep one OPEN bot thread
  const toReply: ReplyAction<F>[] = [];
  const toResolve: PriorThread[] = [];

  for (const thread of priorThreads) {
    let idx = findings.findIndex((f) => matches(f, thread));
    if (idx < 0) idx = findings.findIndex((f) => matchesNearby(f, thread));
    const matched = idx >= 0 ? findings[idx] : undefined;
    if (matched) covered.add(idx);
    if (thread.isResolved) continue; // respect an existing resolution: never re-act
    // A blocker that only NEARBY-matches (not exact) stays live even on a noted thread —
    // the same strict-match-only rule matchesSettled applies to blocker suppression, so a
    // reworded blocker is never swept into a retried resolve alongside a stale note.
    const blockerStillOpen = matched?.severity === "blocker" && !matches(matched, thread);
    if (hasAcceptedResolutionNote(thread) && !blockerStillOpen) {
      // The acknowledgement landed on an earlier run but resolveReviewThread did
      // not. Retry the mutation even if the model has re-raised the same finding.
      toResolve.push(thread);
      continue;
    }
    if (!matched) {
      toResolve.push(thread); // finding dropped this run → close the thread (accepted)
      continue;
    }
    if (open.has(idx)) {
      // A SECOND open thread for the same finding — a duplicate from an earlier run.
      // Keep the first, resolve the extras so duplicates don't accumulate forever.
      toResolve.push(thread);
      continue;
    }
    open.add(idx);
    if (authorHasLastWord(thread)) toReply.push({ thread, finding: matched });
  }

  const toCreate = findings.filter((_, i) => !covered.has(i));
  return { toCreate, toReply, toResolve };
}
