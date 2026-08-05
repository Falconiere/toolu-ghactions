// report/report-run.ts — orchestrates opt-in review-run reporting: gates on the
// action inputs, derives the disjoint partition (partition.ts), builds the wire
// payload (payload.ts), and makes the best-effort POST (post.ts). Called from
// `publish()` AFTER `postInline()` — see publish.ts's own doc for why that
// ordering is load-bearing (spec AC-26): `postInline` is where the GitHub
// mutations actually fire, and `concurrency: cancel-in-progress` can kill the
// job mid-publish, so reporting any earlier would claim fixes GitHub never
// accepted. Split out of publish.ts (not grown there) to keep that file under
// its line ceiling — see design doc, "Seam".
//
// FAILURE IS SILENT BY DESIGN: every abort path here is exactly one
// `core.warning`, never `core.setFailed`, and this module never throws.
import * as core from "@actions/core";
import { partitionFindings } from "./partition.js";
import { buildPayload } from "./payload.js";
import { post } from "./post.js";
import type { Reconciliation } from "@/review/reconcile.js";
import type { StampedFinding } from "@/pipeline/reviewCall.js";
import type { PublishInput } from "@/pipeline/publish.js";

/** Everything {@link reportRun} needs beyond what {@link PublishInput} carries —
 *  values `settleVerdict()`/`postInline()` already computed in `publish()`. */
export interface ReportRunInput {
  /** The in-flight `publish()` call's input (context, target, inputs, prior, …). */
  input: PublishInput;
  /** `postInline`'s return value — the reconcile plan narrowed to mutations
   *  GitHub actually accepted (a failed resolve/reply is dropped). */
  applied: Reconciliation<StampedFinding>;
  /** This run's findings after `dropOutOfScope` + `dropSettled` — the same
   *  array `reconcile()`/`postInline` were called with. */
  findings: StampedFinding[];
  /** Findings `dropSettled` removed before `reconcile()` ran. */
  suppressed: StampedFinding[];
  /** The settled verdict (post round-cap surrender), reported as `run.verdict`. */
  verdict: "approved" | "changes" | "skip" | "error";
  /** Whether the MAX_ROUNDS surrender cap fired this run, reported as `run.capped`. */
  capped: boolean;
}

/** One `core.warning` explaining why reporting is gated on inline comments — see
 *  design doc, "Reporting requires inline comments": with `INLINE_COMMENTS: false`
 *  `postInline` never runs, so there are no marked threads to reconcile against
 *  and every persisting finding would report as `new` on every push forever. */
const INLINE_COMMENTS_REQUIRED =
  "TOOLU_API_KEY is set but INLINE_COMMENTS is false — review-run reporting needs " +
  "inline comments to reconcile fixed/dismissed findings against, so this run was not " +
  "reported. Set INLINE_COMMENTS: true to enable reporting.";

/**
 * Report one review run to toolu.sh, best-effort. A silent no-op (no request, no
 * warning) when `TOOLU_API_KEY` is empty — reporting is opt-in. With the key set
 * but `INLINE_COMMENTS` off, an incoherent partition, no numeric repo id on the
 * triggering event, or ANY unexpected throw (including a malformed `params` the
 * gates below never anticipated — the destructuring itself is inside the guard),
 * skips with exactly one `core.warning`. Never throws — `core.setFailed` is
 * unreachable from here — matching design doc "Failure is silent by design": no
 * outcome of reporting may fail the review job. The WHOLE body is one try/catch
 * (mirrors post.ts's own pattern) so this promise can never reject regardless of
 * caller correctness; `publish.ts` awaits it with no try/catch of its own.
 */
export async function reportRun(params: ReportRunInput): Promise<void> {
  try {
    const { input, applied, findings, suppressed, verdict, capped } = params;
    const { inputs, context } = input;
    if (inputs.touluApiKey === "") return;
    if (!inputs.inlineComments) {
      core.warning(INLINE_COMMENTS_REQUIRED);
      return;
    }

    const partitioned = partitionFindings({
      applied,
      findings,
      suppressed,
      priorThreads: input.priorThreads,
      prior: input.prior,
    });
    if (!partitioned.ok) {
      core.warning(`Skipped review-run reporting: ${partitioned.reason}`);
      return;
    }
    if (context.repoId === undefined) {
      core.warning(
        "Skipped review-run reporting: no numeric repository id on the triggering event payload",
      );
      return;
    }

    const payload = buildPayload({
      repoId: String(context.repoId),
      target: input.target,
      reviewedSha: input.reviewedSha,
      baseBranch: input.baseBranch,
      authorLogin: context.authorLogin ?? null,
      context: { runId: context.runId, runAttempt: context.runAttempt },
      inputs: { provider: inputs.provider, model: inputs.model },
      verdict,
      capped,
      fullReview: input.fullReview,
      startMs: input.startMs,
      now: input.now,
      prior: input.prior,
      partitions: partitioned.partitions,
    });

    const result = await post({
      touluApiUrl: inputs.touluApiUrl,
      touluApiKey: inputs.touluApiKey,
      payload,
      fetch: input.fetch,
    });
    if (!result.ok) core.warning(`Review-run reporting failed: ${result.reason}`);
  } catch (err) {
    // post() is documented never to throw; this also catches a malformed `params`
    // (the destructuring above) or a bug in partitioning/payload-building, rather
    // than let any of them reject this promise and fail the whole review job.
    core.warning(
      `Review-run reporting failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
