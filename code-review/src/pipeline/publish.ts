// pipeline/publish.ts — the publishing phase of a review run: settle the verdict
// (resolved-thread suppression, MAX_ROUNDS surrender), render review memory,
// post the verdict comment + label, and execute the inline-thread reconcile
// plan. Split out of pipeline.ts so the orchestrator stays lean.
import type { ProviderResult } from "@/llm/reviewWithModel.js";
import { renderRecapSection, renderHistorySection } from "@/review/recap.js";
import { formatVerdict, resolveVerdict } from "@/review/verdict.js";
import { diffState, encodeMarker } from "@/state.js";
import type { ReviewState } from "@/state.js";
import { upsertComment } from "@/github/comment.js";
import { postInlineReview } from "@/github/review.js";
import { setVerdictLabel } from "@/github/label.js";
import { resolveThread, replyToThread } from "@/github/threads.js";
import type { PriorThread } from "@/github/threads.js";
import { dropResolved, reconcile } from "@/review/reconcile.js";
import { dropOutOfScope } from "@/review/incremental.js";
import type { IncrementalScope } from "@/review/incremental.js";
import { applyRoundCap } from "@/review/gate.js";
import type { MechanicalFinding } from "@/mechanical/sarif.js";
import type { DiffData } from "@/git/diff.js";
import type { ActionInputs } from "@/inputs.js";
import { jobUrl, formatDuration } from "./bodies.js";
import type { StampedFinding } from "./reviewCall.js";
import type { GithubContext, PipelineOctokit, ReviewResult } from "./types.js";

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
}

/** The settled verdict: out-of-scope + suppressed findings removed, flips and caps applied. */
interface SettledVerdict {
  validated: ProviderResult;
  findings: StampedFinding[];
  verdict: "approved" | "changes" | "skip" | "error";
  capNote: string;
}

/**
 * Settle the verdict deterministically: drop out-of-scope findings (incremental
 * review — new findings only from lines changed since the last reviewed sha),
 * respect human-resolved threads (a suppressed finding is dropped everywhere —
 * count, comment, inline posting), flip a now-findingless "changes" to
 * "approved", then apply the (optional) MAX_ROUNDS surrender cap.
 */
function settleVerdict(input: PublishInput): SettledVerdict {
  const scoped = dropOutOfScope(
    input.stamped,
    input.scope,
    input.priorThreads,
    input.prior?.findings ?? [],
  );
  if (scoped.dropped.length > 0) {
    process.stdout.write(
      `  Dropped ${scoped.dropped.length} finding(s) about code unchanged since the last review\n`,
    );
  }
  const { kept: findings, suppressed } = dropResolved(scoped.kept, input.priorThreads);
  if (suppressed.length > 0) {
    process.stdout.write(
      `  Suppressed ${suppressed.length} finding(s) already resolved on existing threads\n`,
    );
  }
  const validated: ProviderResult = { ...input.result, findings };
  let verdict = resolveVerdict(validated.verdict, findings.length);
  const removed = suppressed.length + scoped.dropped.length;
  if (verdict === "changes" && findings.length === 0 && removed > 0) {
    // Every concrete finding was either human-resolved on its thread or out of
    // the incremental scope; keeping the model's request-changes would re-block
    // on code that was already reviewed or decisions a human already made.
    verdict = "approved";
    validated.verdict = "approved";
  }

  // MAX_ROUNDS surrender: on round N with only sub-blocker findings left, a
  // "changes" verdict downgrades to "approved" (findings stay listed as advisory)
  // so a reviewer that generates fresh findings every push cannot block forever.
  const cap = applyRoundCap({
    verdict,
    findings,
    priorRounds: input.prior?.history?.length ?? 0,
    maxRounds: input.inputs.reviewMemory ? input.inputs.maxRounds : 0,
  });
  let capNote = "";
  if (cap.capped) {
    verdict = "approved";
    validated.verdict = "approved";
    capNote =
      `Round cap reached (MAX_ROUNDS=${input.inputs.maxRounds}): no blocker findings after ` +
      `${input.inputs.maxRounds} review rounds — verdict auto-approved; the findings below are advisory.`;
    process.stdout.write(`  ${capNote}\n`);
  }
  if (scoped.dropped.length > 0) {
    const note =
      `Incremental review: ${scoped.dropped.length} finding(s) about code unchanged since the ` +
      `last review were not re-raised — comment \`@toolu review\` for a full re-review.`;
    capNote = capNote === "" ? note : `${capNote}\n\n${note}`;
  }
  return { validated, findings, verdict, capNote };
}

/** Review memory: diff current findings vs prior, render recap + history + marker. */
function renderMemory(
  input: PublishInput,
  findings: StampedFinding[],
  verdict: string,
): { recap: string; history: string; marker: string } {
  if (!input.inputs.reviewMemory) return { recap: "", history: "", marker: "" };
  const state = diffState({
    prior: input.prior,
    current_findings: findings,
    scope: { in_scope_paths: input.diff.changed_files, full_review: input.fullReview },
    head_sha: input.reviewedSha,
    verdict,
    now: input.now, // injected clock → deterministic marker history ts under a pinned clock.
  });
  // Optional-chain the arrays: a decoded marker missing findings/history must
  // not throw (asReviewState only guarantees the "findings" key is present).
  const hadPrior =
    (input.prior?.findings?.length ?? 0) > 0 || (input.prior?.history?.length ?? 0) > 0;
  const recap = hadPrior
    ? renderRecapSection(state, {
        history: [],
        fullReview: input.fullReview,
        hasPrior: true,
        compact: input.inputs.verbosity === "compact",
      })
    : "";
  return {
    recap,
    history: renderHistorySection(state.next_state.history),
    marker: encodeMarker(state.next_state),
  };
}

/**
 * Publish the settled verdict: sticky comment (a failure here IS an infra error →
 * propagate), label (non-fatal), and the inline-thread reconcile plan (non-fatal).
 * Returns the pipeline's result.
 */
export async function publish(input: PublishInput): Promise<ReviewResult> {
  const { octokit, context, target, inputs } = input;
  const { validated, findings, verdict, capNote } = settleVerdict(input);
  const { recap, history, marker } = renderMemory(input, findings, verdict);

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
  });

  const commentUrl = await upsertComment(octokit, target, body, input.stickyId);
  // setVerdictLabel never throws — every labels-API call is caught inside
  // github/label.ts and reported via its LabelResult, so no try/catch here.
  await setVerdictLabel(octokit, verdict, target, { manageLabels: inputs.manageLabels });
  if (inputs.inlineComments) await postInline(input, findings);
  return { verdict, findingsCount: findings.length, commentUrl };
}

/**
 * Execute the inline reconcile plan (see review/reconcile.ts): post only genuinely
 * NEW findings, answer IN PLACE on threads where the author had the last word, and
 * RESOLVE threads whose finding the model dropped. This is what stops the
 * "re-raise the same finding forever" loop. All best-effort (non-fatal).
 */
async function postInline(input: PublishInput, findings: StampedFinding[]): Promise<void> {
  const { octokit, context, target } = input;
  // The Reviews API needs a commit_id that is IN the PR; the merge sha is not (it
  // 422s and the comments vanish), so anchor to the PR head sha when present.
  const reviewTarget: PublishTarget = { ...target, headSha: context.headSha ?? target.headSha };
  const plan = reconcile(findings, input.priorThreads);

  // 1. Genuinely new findings → one fresh inline review.
  const r = await postInlineReview(octokit, plan.toCreate, reviewTarget);
  if (!r.posted && r.reason !== "no anchored findings") {
    process.stderr.write(`  Warning: inline review step failed: ${r.reason ?? "unknown"}\n`);
  }

  // 2. Findings that persist where the author had the last word → answer in that thread.
  for (const { thread, finding } of plan.toReply) {
    await replyToThread(
      octokit,
      target,
      thread.rootCommentId,
      `**Still flagging after re-review.** ${finding.text}`,
    );
  }

  // 3. Findings the bot dropped this run → resolve the thread (accepted / no longer
  // applies). Leave a one-line note first unless the hunk is already outdated.
  for (const thread of plan.toResolve) {
    if (!thread.isOutdated) {
      await replyToThread(
        octokit,
        target,
        thread.rootCommentId,
        "Re-reviewed — this no longer applies (addressed, or point taken). Resolving.",
      );
    }
    await resolveThread(octokit, thread.threadId);
  }
}
