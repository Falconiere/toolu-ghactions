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
 * Merge per-chunk {@link ProviderResult}s into one. Findings concatenate in input
 * order (files never repeat across chunks → no dedup). Verdict: "changes" if any
 * non-error chunk requests changes; "approved" iff all non-error chunks approve;
 * "error" only if every chunk errored. On partial failure the surviving verdict is
 * kept and `error` records "M/N chunks failed". An empty input is a defensive
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
        : "approved";

  const merged: ProviderResult = {
    verdict,
    findings: results.flatMap((r) => r.findings),
    review_plan: joinNonEmpty(results.map((r) => r.review_plan)),
    other_checks: joinNonEmpty(results.map((r) => r.other_checks)),
    top_must_fix: capUnion(results.flatMap((r) => r.top_must_fix ?? [])),
  };

  if (partials.length > 0) merged.partial = true;
  if (errored.length > 0) {
    const first = errored[0]!;
    merged.error = `${errored.length}/${results.length} chunks failed: ${first.error ?? "unknown error"}`;
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
