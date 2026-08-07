// pipeline/publish.ts — the publishing phase of a review run: reduce (carry
// forward + cluster), settle the verdict, execute the inline-thread reconcile
// plan, post the sticky verdict comment + label, and hand the run to the toolu.sh
// reporter. Split out of pipeline.ts so the orchestrator stays lean; the two
// deterministic decisions it makes (verdict, marker) live in pipeline/settle.ts
// and the Layer 3 reduction in pipeline/reduce.ts, so this file stays orchestration.
//
// ORDER IS LOAD-BEARING, twice over:
//  - the INLINE review runs BEFORE the sticky comment is built, because
//    `postInlineReview` is what discovers which findings GitHub cannot anchor
//    (spec §Publish hardening) and those are rendered into the sticky instead;
//  - the toolu.sh report runs AFTER the inline mutations (report/report-run.ts's
//    own doc): reporting earlier would claim fixes GitHub never accepted.
import type { ProviderResult } from "@/llm/reviewWithModel.js";
import { formatVerdict } from "@/review/verdict.js";
import type { ReviewState } from "@/state.js";
import { upsertComment } from "@/github/comment.js";
import { postInlineReview } from "@/github/review.js";
import { setVerdictLabel } from "@/github/label.js";
import {
  ACCEPTED_RESOLUTION_NOTE,
  hasAcceptedResolutionNote,
  resolveThread,
  replyToThread,
} from "@/github/threads.js";
import type { PriorThread } from "@/github/threads.js";
import { reconcile } from "@/review/reconcile.js";
import type { Reconciliation, ReplyAction } from "@/review/reconcile.js";
import type { IncrementalScope } from "@/review/incremental.js";
import { renderLedger, renderLedgerSummary } from "@/review/ledger.js";
import type { CoverageLedger } from "@/review/ledger.js";
import type { MechanicalFinding } from "@/mechanical/sarif.js";
import type { Finding } from "@/llm/schema.js";
import type { DiffData } from "@/git/diff.js";
import type { ActionInputs } from "@/inputs.js";
import { jobUrl, formatDuration } from "./bodies.js";
import {
  decorateExemplars,
  expandApplied,
  expandRepresentatives,
  reduceFindings,
  undecorate,
  withCarriedWithoutFinding,
} from "./reduce.js";
import type { Reduction } from "./reduce.js";
import { ledgerExceptions, renderMemory, settleVerdict } from "./settle.js";
import type { StampedFinding } from "./reviewCall.js";
import type { GithubContext, PipelineOctokit, ReviewResult } from "./types.js";
import { reportRun } from "@/report/report-run.js";
import * as core from "@actions/core";

/** Repo + PR + head coordinates for every publish operation. */
export interface PublishTarget {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
}

/** Everything {@link publish} needs from the run in flight. */
export interface PublishInput {
  octokit: PipelineOctokit;
  context: GithubContext;
  target: PublishTarget;
  inputs: ActionInputs;
  diff: DiffData;
  result: ProviderResult;
  stamped: StampedFinding[];
  priorThreads: PriorThread[];
  prior: ReviewState | null;
  stickyId: number | undefined;
  mechanical: MechanicalFinding[];
  /** This round's per-path coverage (pipeline/reviewCall.ts). Drives carry-forward,
   *  the Coverage section, the verdict degrade, and the marker's completeness. */
  ledger: CoverageLedger;
  /** The PRIOR round's exception paths — always in scope for `dropOutOfScope`, so a
   *  resume run's findings survive the line-level incremental filter. */
  exceptionPaths: ReadonlySet<string>;
  /** The review head's root tree sha, recorded as `reviewed_tree` on a COMPLETE run. */
  headTree?: string;
  /** Incremental scope (lines changed since the last reviewed sha); null = full review. */
  scope: IncrementalScope | null;
  /**
   * The sha recorded as the marker's `reviewed_sha` — the PR HEAD sha when the
   * event carries one, else `target.headSha`. Kept separate from
   * `target.headSha` (GITHUB_SHA — the ephemeral test-merge commit on
   * pull_request events): a merge sha is orphaned on every push, so a series
   * stored on it never resolves next run and incremental scope stays null.
   */
  reviewedSha: string;
  fullReview: boolean;
  reviewHead: string;
  baseBranch: string;
  startMs: number;
  now: () => number;
  /** Custom fetch for the report/post.ts best-effort POST (tests replay/inject). */
  fetch?: typeof fetch;
}

/** What {@link postInline} did: the plan GitHub accepted, plus the two buckets of
 *  findings that never made it onto a line — both rendered into the sticky comment
 *  instead, because a finding the review produced may never just disappear. */
interface InlineOutcome {
  applied: Reconciliation<StampedFinding>;
  /** No anchor could exist (GitHub's own diff does not show the file). */
  unanchored: Finding[];
  /** GitHub answered 422 even with the comment posted alone (reviewBatch.ts). */
  dropped: Finding[];
}

/**
 * Publish the settled verdict: inline threads (non-fatal), sticky comment (a
 * failure here IS an infra error → propagate), label (non-fatal), then the
 * best-effort run report. Returns the pipeline's result.
 */
export async function publish(input: PublishInput): Promise<ReviewResult> {
  const { octokit, context, target, inputs } = input;
  // Layer 3: re-inject the findings of every path this round did not review, then
  // collapse repeats into exemplar-led clusters (pipeline/reduce.ts).
  const reduction = reduceFindings({
    modelFindings: input.stamped,
    prior: input.prior,
    ledger: input.ledger,
  });
  const ledger = withCarriedWithoutFinding(input.ledger, reduction.carriedWithoutFinding);
  const exceptions = ledgerExceptions(ledger);
  const settled = settleVerdict({ ...input, ledger }, reduction, exceptions);
  const { validated, findings, suppressed, verdict, capNote, capped } = settled;
  // Members back: the marker, the counts and the report speak in FULL member lists;
  // only GitHub's threads and the comment's findings list speak in representatives.
  const expanded = expandRepresentatives(findings, reduction);

  const inline: InlineOutcome = inputs.inlineComments
    ? await postInline(input, findings, reduction)
    : { applied: { toCreate: [], toReply: [], toResolve: [] }, unanchored: [], dropped: [] };

  const { recap, history, marker } = renderMemory(input, expanded, verdict, reduction, exceptions);
  const { body } = formatVerdict(validated, {
    botName: inputs.botName,
    botLogoUrl: inputs.botLogoUrl,
    // Heading shows the PR SOURCE branch (bash used GITHUB_HEAD_REF); prefer it.
    branch: context.headRef ?? (input.reviewHead === "HEAD" ? input.baseBranch : input.reviewHead),
    jobUrl: jobUrl(context),
    duration: formatDuration(input.now() - input.startMs),
    recap,
    history,
    historyMarker: marker,
    mechanical: input.mechanical,
    verbosity: inputs.verbosity,
    changedFiles: input.diff.total_files,
    capNote,
    ledger: renderLedger(ledger, inputs.verbosity),
    ledgerSummary: renderLedgerSummary(ledger),
    unanchored: inline.unanchored,
    dropped: inline.dropped,
    clusters: reduction.clustered,
  });

  const commentUrl = await upsertComment(octokit, target, body, input.stickyId);
  // setVerdictLabel never throws — every labels-API call is caught inside
  // github/label.ts and reported via its LabelResult, so no try/catch here.
  await setVerdictLabel(octokit, verdict, target, { manageLabels: inputs.manageLabels });
  // AFTER postInline — ordering is load-bearing, see report/report-run.ts's doc.
  // Both sides of the partition carry expanded member lists (report/expand.ts).
  // reportRun() wraps its whole body in try/catch and is documented to never
  // reject; this .catch is a last-resort guard against a future refactor of
  // reportRun reintroducing a throw and silently turning a metrics hiccup into
  // a red CI run. Matches reportRun's own failure format — exactly one
  // core.warning, never core.setFailed.
  await reportRun({
    input,
    applied: expandApplied(inline.applied, reduction),
    findings: expanded,
    suppressed,
    verdict,
    capped,
  }).catch((err: unknown) => {
    core.warning(
      `Review-run reporting failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  // The count is the EXPANDED one: it is what the marker stores and what the
  // report carries, while the comment lists one line per cluster.
  return { verdict, findingsCount: expanded.length, commentUrl };
}

/**
 * Execute the inline reconcile plan (see review/reconcile.ts): post only genuinely
 * NEW findings, answer IN PLACE on threads where the author had the last word, and
 * RESOLVE threads whose finding the model dropped. This is what stops the
 * "re-raise the same finding forever" loop. All best-effort (non-fatal).
 *
 * `findings` are cluster REPRESENTATIVES and the plan is built with the round's
 * {@link Reduction.ctx}, so one thread covers every member of its cluster and a
 * cluster whose exemplar was fixed is REPLIED to (promoted), never resolved.
 *
 * Returns the reconcile plan NARROWED to what GitHub actually accepted:
 * `resolveThread`/`replyToThread` report a boolean success flag per call, and a
 * failed mutation drops that thread from the returned `toResolve`/`toReply` — so a
 * `fixed` finding derived from this later means "the bot resolved this thread on
 * GitHub and GitHub accepted it", never a plan that was merely attempted.
 * `toCreate` has no per-finding signal to narrow by: `postInlineReview` posts the
 * whole batch in one Reviews-API call and reports only a batch-level `posted` flag
 * (a count can be lower than `plan.toCreate.length` when an anchor is unresolvable
 * against GitHub's own diff, with no indication of which findings survived), so a
 * failed post empties `toCreate` and a successful one reports it as planned.
 */
async function postInline(
  input: PublishInput,
  findings: StampedFinding[],
  reduction: Reduction,
): Promise<InlineOutcome> {
  const { octokit, context, target } = input;
  // The Reviews API needs a commit_id that is IN the PR; the merge sha is not (it
  // 422s and the comments vanish), so anchor to the PR head sha when present.
  const reviewTarget: PublishTarget = { ...target, headSha: context.headSha ?? target.headSha };
  const plan = reconcile(findings, input.priorThreads, reduction.ctx);

  // 1. Genuinely new findings → one fresh inline review. A cluster exemplar's body
  //    is DECORATED with the members it stands for first (pipeline/reduce.ts): the
  //    fp rides along untouched, so the thread's identity is unchanged (AC-4).
  const r = await postInlineReview(
    octokit,
    decorateExemplars(plan.toCreate, reduction),
    reviewTarget,
  );
  if (!r.posted && r.reason !== "no anchored findings") {
    process.stderr.write(`  Warning: inline review step failed: ${r.reason ?? "unknown"}\n`);
  }

  // 2. Findings that persist where the author had the last word → answer in that
  //    thread; a promoted cluster gets the promotion wording instead.
  const toReply: ReplyAction<StampedFinding>[] = [];
  for (const action of plan.toReply) {
    const replied = await replyToThread(
      octokit,
      target,
      action.thread.rootCommentId,
      replyBody(action, reduction),
    );
    if (replied) toReply.push(action);
  }

  // 3. Findings the bot dropped this run → resolve the thread (accepted / no longer
  // applies / settled by the author). Leave a one-line note saying WHICH, unless the
  // hunk is already outdated.
  const toResolve: PriorThread[] = [];
  for (const thread of plan.toResolve) {
    if (!thread.isOutdated && !hasAcceptedResolutionNote(thread)) {
      await replyToThread(octokit, target, thread.rootCommentId, resolveNote(thread));
    }
    if (await resolveThread(octokit, thread.threadId)) toResolve.push(thread);
  }

  // Both failure buckets come back UNDECORATED: the sticky comment enumerates a
  // cluster's members in its own "Repeated findings" section, so repeating the
  // enumeration inside each finding's row would be noise.
  return {
    applied: { toCreate: r.posted ? plan.toCreate : [], toReply, toResolve },
    unanchored: undecorate(r.unanchored, reduction),
    dropped: undecorate(r.dropped, reduction),
  };
}

/**
 * The reply owed on an existing thread. `promoted` marks the cluster case: the
 * finding this thread was opened for is gone, but the PATTERN it stands for
 * survives under a new representative (review/reconcile.ts) — say so plainly,
 * because the thread's own code now reads as fixed.
 */
function replyBody(action: ReplyAction<StampedFinding>, reduction: Reduction): string {
  if (action.promoted !== true) return `**Still flagging after re-review.** ${action.finding.text}`;
  const remaining = reduction.ctx.members.get(action.finding.fp)?.length ?? 1;
  return (
    `**Exemplar fixed; ${remaining} member(s) remain.** This thread tracks a pattern, and the ` +
    `file it was opened on is clean now — representative promoted to ` +
    `\`${action.finding.path}:${action.finding.line}\`.\n\n${action.finding.text}`
  );
}

/**
 * The closing note for a thread being resolved. A thread the author settled says so
 * — reusing the "no longer applies" line there would misreport a standing
 * disagreement (or an explicit dismissal) as the bot agreeing the issue is gone.
 */
function resolveNote(thread: PriorThread): string {
  switch (thread.dismissal) {
    case "explicit":
      return "Dismissed by the author — not raising this again. Resolving.";
    case "exhausted":
      return (
        "Re-reviewed and we still read this differently. The point stands as stated " +
        "above; deferring to the author rather than repeating it. Resolving."
      );
    default:
      return ACCEPTED_RESOLUTION_NOTE;
  }
}
