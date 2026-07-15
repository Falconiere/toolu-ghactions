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
// ANY prior thread — even a resolved one — is never re-posted, so a human-resolved thread
// is respected rather than reopened.
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

/** How far (in lines) a RESOLVED thread's coverage reaches for a reworded finding. */
const RESOLVED_LINE_RADIUS = 10;

/** The `_(CATEGORY)_` tag the bot renders in its inline root comments, normalised
 *  for comparison; null when the body carries none. */
function threadCategory(rootBody: string): string | null {
  const m = /_\(([^)·]+?)(?:\s*·[^)]*)?\)_/.exec(rootBody);
  return m?.[1] === undefined ? null : m[1].trim().toLowerCase();
}

/**
 * Does a RESOLVED thread cover this finding? Wider than {@link matches}: a model
 * re-raising a human-resolved finding almost never reproduces it verbatim — it
 * rewords the text (new fingerprint) and drifts the anchor line, and after the
 * next push the thread itself often goes outdated (line null), so both strict
 * prongs miss and the finding resurrects forever. A resolved thread therefore
 * also covers a same-path finding within {@link RESOLVED_LINE_RADIUS} lines, or
 * — when the thread is detached (line null) — a same-path finding with the same
 * rendered category. Blockers are exempt from the loose prongs: only an exact
 * match may suppress a blocker, so loosening can never hide a real showstopper.
 */
function matchesResolved(f: ReconcileFinding, t: PriorThread): boolean {
  if (matches(f, t)) return true;
  if (f.severity === "blocker") return false;
  if (f.path !== t.path) return false;
  if (t.line !== null) return Math.abs(f.line - t.line) <= RESOLVED_LINE_RADIUS;
  const category = threadCategory(t.rootBody);
  return category !== null && category === (f.category ?? "").trim().toLowerCase();
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
 * Partition this run's findings against the bot's prior threads into a {create, reply,
 * resolve} plan. See the module header for the rules. Resolved threads are never acted on
 * again but still "cover" a matching finding so it is not re-posted as a duplicate.
 */
/**
 * Split this run's findings on whether a RESOLVED prior thread covers them. A human
 * resolving the bot's thread is a decision — the finding must vanish everywhere
 * (verdict count, verdict comment, inline posting), not just from re-posting.
 * Matching is {@link matchesResolved} — reconcile()'s strict rules widened with a
 * line radius and an outdated-thread category prong, because a re-raised finding
 * is usually reworded (new fp) and line-drifted while the resolved thread itself
 * has gone outdated (line null). Blockers only ever match strictly.
 */
export function dropResolved<F extends ReconcileFinding>(
  findings: F[],
  priorThreads: PriorThread[],
): { kept: F[]; suppressed: F[] } {
  const resolved = priorThreads.filter((t) => t.isResolved);
  const kept: F[] = [];
  const suppressed: F[] = [];
  for (const f of findings) {
    (resolved.some((t) => matchesResolved(f, t)) ? suppressed : kept).push(f);
  }
  return { kept, suppressed };
}

export function reconcile<F extends ReconcileFinding>(
  findings: F[],
  priorThreads: PriorThread[],
): Reconciliation<F> {
  const covered = new Set<number>(); // finding indices represented by ANY prior thread
  const open = new Set<number>(); // finding indices that already keep one OPEN bot thread
  const toReply: ReplyAction<F>[] = [];
  const toResolve: PriorThread[] = [];

  for (const thread of priorThreads) {
    const idx = findings.findIndex((f) => matches(f, thread));
    const matched = idx >= 0 ? findings[idx] : undefined;
    if (matched) covered.add(idx);
    if (thread.isResolved) continue; // respect an existing resolution: never re-act
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
