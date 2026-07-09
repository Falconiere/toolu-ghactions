// llm/merge.ts — combine the per-chunk review results of a chunked diff into one
// ProviderResult, so everything downstream of the review call (validate, verdict,
// recap, render) is unchanged: it still consumes a single result.
//
// PARTIAL FAILURE is the load-bearing case: when some chunks succeed and others
// abstain (verdict "error"), we keep the successes and surface the failure in
// `error` — a chunked review NEVER throws away good findings because one chunk's
// model call failed. Only when EVERY chunk errored does the merged verdict stay
// "error". Results must arrive in chunk-index order (the caller preserves it) so
// the merged output is deterministic regardless of completion order.
import type { ProviderResult } from "./reviewWithModel.js";

/** Max entries kept when unioning per-chunk `top_must_fix` lists. */
const TOP_MUST_FIX_CAP = 10;

/**
 * Char caps on the MERGED narrative fields. Per-chunk each field is already soft-capped
 * by the schema (review_plan ≤ 280, other_checks ≤ 600), but a chunked review joins one
 * per chunk with blank-line separators, so a 20-chunk PR concatenates 20 plans / 20
 * check blurbs uncapped — the exact verbosity this merge is meant to bound. The joined
 * result is clipped here so the comment carries a bounded narrative regardless of chunk
 * count. review_plan is the tighter cap (it is orientation, not findings); other_checks
 * gets more room for genuine cross-chunk observations.
 */
const MERGED_REVIEW_PLAN_CAP = 280;
const MERGED_OTHER_CHECKS_CAP = 1000;

/**
 * Merge per-chunk {@link ProviderResult}s into one. Findings concatenate in input
 * order (files never repeat across chunks → no dedup). Verdict: "changes" if any
 * non-error chunk requests changes; "approved" ONLY when every chunk approved —
 * a failed chunk means unreviewed files, and an "approved" over unreviewed files
 * is a confident verdict the review cannot honestly make, so a would-be approval
 * with failed chunks degrades to "error" (review incomplete; never auto-merges).
 * "changes" findings from surviving chunks are always kept, with `error`
 * recording "M/N chunks failed" and `partial` set. An empty input is a defensive
 * "error" result (the pipeline's fast path means it is never reached in practice).
 */
export function mergeResults(results: ProviderResult[]): ProviderResult {
  if (results.length === 0) {
    return { verdict: "error", findings: [], error: "no chunks reviewed" };
  }

  const errored = results.filter((r) => r.verdict === "error");
  const succeeded = results.filter((r) => r.verdict !== "error");
  // A salvaged chunk has verdict "changes" (so it counts as a success above) but
  // was recovered from a length-truncated response — surface that distinctly below.
  const partials = results.filter((r) => r.partial);

  const verdict: ProviderResult["verdict"] =
    succeeded.length === 0
      ? "error"
      : succeeded.some((r) => r.verdict === "changes")
        ? "changes"
        : errored.length > 0
          ? "error" // all survivors approved, but files went unreviewed — inconclusive.
          : "approved";

  const merged: ProviderResult = {
    verdict,
    findings: results.flatMap((r) => r.findings),
    review_plan: capText(joinNonEmpty(results.map((r) => r.review_plan)), MERGED_REVIEW_PLAN_CAP),
    other_checks: capText(
      joinNonEmpty(results.map((r) => r.other_checks)),
      MERGED_OTHER_CHECKS_CAP,
    ),
    top_must_fix: capUnion(results.flatMap((r) => r.top_must_fix ?? [])),
  };

  if (partials.length > 0 || errored.length > 0) merged.partial = true;
  if (errored.length > 0) {
    const first = errored[0]!;
    merged.error =
      `${errored.length}/${results.length} chunks failed (after a retry) — the files in ` +
      `those chunks were NOT reviewed: ${first.error ?? "unknown error"}`;
    if (first.finishReason !== undefined) merged.finishReason = first.finishReason;
  } else if (partials.length > 0) {
    merged.error =
      `${partials.length}/${results.length} chunks truncated at the output-token limit — ` +
      `recovered the findings completed before the cut; later findings may be missing. ` +
      `Raise MAX_TOKENS to avoid.`;
    merged.finishReason = "length";
  }
  return merged;
}

/** Join the defined, non-empty strings with a blank-line separator. */
function joinNonEmpty(parts: Array<string | undefined>): string {
  return parts.filter((p): p is string => p !== undefined && p !== "").join("\n\n");
}

/**
 * Clip `s` to at most `max` chars, appending a `…` marker when it was truncated so the
 * reader (and any downstream parser) can tell the narrative was cut. The first `max`
 * chars are preserved verbatim; the marker is extra, not counted against the budget.
 */
function capText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Dedupe (order-preserving) and cap a flattened list of must-fix strings. */
function capUnion(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (item === "" || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= TOP_MUST_FIX_CAP) break;
  }
  return out;
}
