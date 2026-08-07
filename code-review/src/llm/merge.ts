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
//
// LEAF-AWARE: the input is one {@link PackageResults} entry per chunk, not one
// result per chunk. A chunk reviewed whole contributes its single result; a chunk
// that bisected on a schema failure (review/bisect.ts) contributes its LEAF
// results — so a chunk whose halves all succeeded is fully covered and must NOT
// count as a failed chunk, while a chunk with a failed leaf still does (its leaf's
// files went unreviewed). Failure counting is therefore per chunk, not per result.
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
 * One chunk's contribution to the merge: the results that actually covered it —
 * a single result for a chunk reviewed whole, or the LEAF results for a chunk that
 * bisected. An entry is "failed" when ANY of its results errored; an empty entry
 * (nothing was attempted — e.g. the wall clock ran out) merges as nothing at all,
 * its paths accounted for `pending` in the coverage ledger instead.
 */
export type PackageResults = ProviderResult[];

/**
 * Merge per-chunk {@link PackageResults} into one {@link ProviderResult}. Findings
 * concatenate in input order (files never repeat across chunks → no dedup).
 * Verdict: "changes" if any non-error result requests changes; "approved" ONLY
 * when every chunk was fully covered — a failed chunk means unreviewed files, and
 * an "approved" over unreviewed files is a confident verdict the review cannot
 * honestly make, so a would-be approval with failed chunks degrades to "error"
 * (review incomplete; never auto-merges). "changes" findings from surviving chunks
 * are always kept, with `error` recording "M/N chunks failed" and `partial` set.
 * An empty input is a defensive "error" result (the pipeline's fast path means it
 * is never reached in practice).
 */
export function mergeResults(chunks: PackageResults[]): ProviderResult {
  // A chunk nothing covered contributes nothing — not a success, not a failure.
  const covered = chunks.filter((chunk) => chunk.length > 0);
  if (covered.length === 0) {
    return { verdict: "error", findings: [], error: "no chunks reviewed" };
  }
  const results = covered.flat();

  // Failure is counted per CHUNK: a bisected chunk whose leaves all landed is fully
  // covered, however many results it took; one failed leaf fails its chunk.
  const failed = covered.filter((chunk) => chunk.some((r) => r.verdict === "error"));
  const errored = results.filter((r) => r.verdict === "error");
  const succeeded = results.filter((r) => r.verdict !== "error");
  // A salvaged chunk has verdict "changes" (so it counts as a success above) but
  // was recovered from a length-truncated response — surface that distinctly below.
  const partials = covered.filter((chunk) => chunk.some((r) => r.partial));

  const verdict: ProviderResult["verdict"] =
    succeeded.length === 0
      ? "error"
      : succeeded.some((r) => r.verdict === "changes")
        ? "changes"
        : failed.length > 0
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

  if (partials.length > 0 || failed.length > 0) merged.partial = true;
  const first = errored[0];
  if (failed.length > 0 && first !== undefined) {
    merged.error =
      `${failed.length}/${covered.length} chunks failed (after a retry) — the files in ` +
      `those chunks were NOT reviewed: ${first.error ?? "unknown error"}`;
    if (first.finishReason !== undefined) merged.finishReason = first.finishReason;
  } else if (partials.length > 0) {
    merged.error =
      `${partials.length}/${covered.length} chunks truncated at the output-token limit — ` +
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
