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
//
// CLUSTERS (spec §Layer 3). When the caller collapsed this round's findings with
// review/cluster.ts it passes the cluster REPRESENTATIVES as `findings` plus a
// {@link ClusterContext}; every rule below then reads at CLUSTER level — a thread
// matching ANY member covers (and settles) the whole cluster, and resolves only
// once no member of the cluster it maps to survives. Without a context each
// finding is its own single-member cluster: every decision stays byte-identical.
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
  /** Set when this reply exists because the thread's cluster changed exemplar: the
   *  finding it was opened for is gone but the PATTERN survives, so `finding` is the
   *  promoted representative. The caller composes the promotion wording; reconcile
   *  only guarantees the thread is replied to rather than resolved. */
  promoted?: true;
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

/** Cluster context for a run whose findings review/cluster.ts collapsed: the
 *  `findings` array holds one REPRESENTATIVE (the exemplar) per cluster. Omit it
 *  entirely for an unclustered run. */
export interface ClusterContext<F extends ReconcileFinding = ReconcileFinding> {
  /** Exemplar fp → every finding of that cluster (exemplar included). */
  members: ReadonlyMap<string, F[]>;
  /** LAST round's `ReviewState.clusters` (member fp → exemplar fp). It is the
   *  only link left between a thread opened for a since-fixed exemplar and the
   *  cluster that survives under a promoted representative. */
  priorClusters?: Record<string, string> | undefined;
}

/** Per representative index, the findings that index stands for — the
 *  representative alone without a context (or for one the context omits). */
function memberLists<F extends ReconcileFinding>(findings: F[], ctx?: ClusterContext<F>): F[][] {
  return findings.map((f) => {
    const members = ctx?.members.get(f.fp);
    if (members === undefined || members.length === 0) return [f];
    return members.some((m) => m.fp === f.fp) ? members : [f, ...members];
  });
}

/** The cluster a fp belonged to last round — itself when it led none. */
function priorExemplarOf(fp: string, priorClusters: Record<string, string>): string {
  return priorClusters[fp] ?? fp;
}

/** True when the thread and this cluster were ONE cluster last round. Applied only
 *  after strict and nearby matching fail, and only to multi-member clusters. */
function linkedByPriorCluster(
  group: ReconcileFinding[],
  thread: PriorThread,
  priorClusters: Record<string, string> | undefined,
): boolean {
  if (priorClusters === undefined || thread.fp === "") return false;
  const key = priorExemplarOf(thread.fp, priorClusters);
  return group.some((m) => priorExemplarOf(m.fp, priorClusters) === key);
}

/** Index of the cluster a thread maps to: strict ({@link matches}) over every
 *  member first, then {@link matchesNearby}, then the prior-round cluster link
 *  (multi-member clusters only). -1 when the thread maps to no cluster. */
function clusterFor<F extends ReconcileFinding>(
  groups: F[][],
  thread: PriorThread,
  priorClusters: Record<string, string> | undefined,
): number {
  let idx = groups.findIndex((g) => g.some((m) => matches(m, thread)));
  if (idx < 0) idx = groups.findIndex((g) => g.some((m) => matchesNearby(m, thread)));
  if (idx < 0) {
    idx = groups.findIndex((g) => g.length > 1 && linkedByPriorCluster(g, thread, priorClusters));
  }
  return idx;
}

/**
 * Does a settled thread settle this whole cluster? ANY member matching under
 * {@link matchesSettled} settles EVERY member, blockers included — dismissing the
 * exemplar dismisses the pattern (spec §Layer 3), and the prior-round link extends
 * that to a cluster whose settled exemplar is already fixed.
 *
 * ONE exemption, and it is evaluated FIRST, against the whole cluster: an
 * `"exhausted"` thread never settles a cluster holding a blocker, at any match
 * strength. `"exhausted"` is the BOT conceding a stalemate, not a human ruling, so
 * it may not take a showstopper off the board. {@link matchesSettled} already
 * carves this out per FINDING, but a cluster's members share one defect while
 * severity is NOT part of the cluster key — so a mixed-severity cluster whose
 * `high` member the thread happens to match would otherwise route around the
 * per-finding carve-out and silence its `blocker` sibling. The exemption must
 * therefore be read at cluster level, ahead of every match-strength prong.
 *
 * Deliberately NOT extended to the other two settlement channels: a GitHub
 * resolution and an explicit `@toolu dismiss` are HUMAN decisions, and there
 * dismissing the exemplar dismisses the pattern, blockers included.
 */
function clusterSettled<F extends ReconcileFinding>(
  group: F[],
  t: PriorThread,
  priorClusters: Record<string, string> | undefined,
): boolean {
  if (t.dismissal === "exhausted" && group.some((m) => m.severity === "blocker")) return false;
  if (group.some((m) => matchesSettled(m, t))) return true;
  if (group.length === 1) return false;
  return linkedByPriorCluster(group, t, priorClusters);
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
 * With a {@link ClusterContext} the split is per CLUSTER ({@link clusterSettled}):
 * a suppressed representative stands for every member, expanded back downstream.
 */
export function dropSettled<F extends ReconcileFinding>(
  findings: F[],
  priorThreads: PriorThread[],
  clusters?: ClusterContext<F>,
): { kept: F[]; suppressed: F[] } {
  const settled = priorThreads.filter(isSettled);
  const groups = memberLists(findings, clusters);
  const kept: F[] = [];
  const suppressed: F[] = [];
  findings.forEach((f, i) => {
    const group = groups[i] ?? [f];
    const hit = settled.some((t) => clusterSettled(group, t, clusters?.priorClusters));
    (hit ? suppressed : kept).push(f);
  });
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
 *
 * With a {@link ClusterContext}, `findings` are cluster representatives and every
 * rule reads at cluster level ({@link clusterFor}): one matched member covers the
 * whole cluster (no member can reach `toCreate`), a thread resolves only when its
 * cluster is gone entirely, and one whose exemplar was fixed while members survive
 * is REPLIED to against the promoted representative (`ReplyAction.promoted`).
 */
export function reconcile<F extends ReconcileFinding>(
  findings: F[],
  priorThreads: PriorThread[],
  clusters?: ClusterContext<F>,
): Reconciliation<F> {
  const groups = memberLists(findings, clusters);
  const covered = new Set<number>(); // cluster indices represented by ANY prior thread
  const open = new Set<number>(); // cluster indices that already keep one OPEN bot thread
  const toReply: ReplyAction<F>[] = [];
  const toResolve: PriorThread[] = [];

  for (const thread of priorThreads) {
    const idx = clusterFor(groups, thread, clusters?.priorClusters);
    const matched = idx >= 0 ? findings[idx] : undefined;
    const group = idx >= 0 ? (groups[idx] ?? []) : [];
    if (matched) covered.add(idx);
    if (thread.isResolved) continue; // respect an existing resolution: never re-act
    // A blocker that only NEARBY-matches (not exact) stays live even on a noted thread —
    // the same strict-match-only rule matchesSettled applies to blocker suppression, so a
    // reworded blocker is never swept into a retried resolve alongside a stale note.
    const strict = group.some((m) => matches(m, thread));
    const blockerStillOpen = !strict && group.some((m) => m.severity === "blocker");
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
      if (group.length === 1) {
        toResolve.push(thread);
        continue;
      }
      // A CLUSTER's extra thread is never resolved: its members are still live, so
      // reporting it fixed would be a lie. It is still an UNRESOLVED thread the bot
      // owns, though, so the module contract holds for it too — an author who had
      // the last word there gets an answer against the cluster's representative.
      // Silence would strand a real question on a thread that is never closed.
      if (authorHasLastWord(thread)) toReply.push({ thread, finding: matched });
      continue;
    }
    open.add(idx);
    // Exemplar promotion: the thread's own fp is no longer any member's, yet the
    // cluster survives — reply against the new representative, never resolve.
    if (group.length > 1 && !group.some((m) => m.fp === thread.fp)) {
      toReply.push({ thread, finding: matched, promoted: true });
    } else if (authorHasLastWord(thread)) toReply.push({ thread, finding: matched });
  }

  const toCreate = findings.filter((_, i) => !covered.has(i));
  return { toCreate, toReply, toResolve };
}
