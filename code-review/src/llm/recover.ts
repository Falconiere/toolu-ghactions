// llm/recover.ts — rescuing a usable review from a response generateObject rejected.
//
// generateObject validates the model's output against the strict Verdict schema AFTER
// the response is complete, and throws NoObjectGeneratedError on any mismatch. Without
// this module every such throw abstains, so a single deviant value — a quoted line
// number, "request_changes" instead of "changes" — discards a review that was otherwise
// perfectly good, and the PR's files go unreviewed.
//
// The one rule here: NORMALIZE, NEVER INVENT. Everything below either maps a value the
// model clearly meant onto the schema, or drops it. When too little survives to be
// honest about, recover() returns null and the caller abstains — a false clean is worse
// than no review.
import { NoObjectGeneratedError } from "ai";
import { jsonrepair } from "jsonrepair";
import { Finding, PartialVerdict, normalizeFinding, normalizeVerdict } from "./schema.js";
import type { ProviderResult } from "./reviewWithModel.js";

/**
 * True when the model stopped because it hit the output-token limit (finish_reason
 * "length"). That covers TWO different failures, so this predicate alone never
 * decides anything: a real mid-JSON truncation (partial text present) and the
 * hidden-reasoning bug (no text at all — the budget went to thinking). Pair it with
 * {@link hasPartialOutput}, which is the actual discriminator: presence of text, not
 * the finish reason. A schema mismatch is the separable case — that one does keep
 * finishReason "stop".
 */
export function isLengthTruncation(err: unknown): boolean {
  return NoObjectGeneratedError.isInstance(err) && err.finishReason === "length";
}

/**
 * True when a NoObjectGeneratedError carries non-empty raw model output. Separates a
 * real mid-JSON truncation (partial text present — worth a bigger budget + salvage)
 * from the hidden-reasoning bug (empty content + finish_reason "length": the model
 * emitted nothing, so escalating the budget only burns more reasoning tokens).
 */
export function hasPartialOutput(err: unknown): boolean {
  return (
    NoObjectGeneratedError.isInstance(err) && typeof err.text === "string" && err.text.trim() !== ""
  );
}

/**
 * Recover a usable review from a response the strict Verdict schema rejected, so one bad
 * value does not discard a whole pass. Covers both rejection shapes:
 *
 * - **Truncated** (finish_reason "length"): the raw output on
 *   {@link NoObjectGeneratedError.text} is cut mid-JSON. jsonrepair closes the open
 *   JSON and the incomplete trailing finding fails its own validation, so the ones
 *   completed before the cut survive.
 * - **Complete but nonconforming** (finish_reason "stop"): the model answered fully and
 *   plausibly but off-schema — "request_changes" for the verdict, a quoted line number,
 *   "CRITICAL" for a severity. {@link normalizeVerdict}/{@link normalizeFinding} map
 *   those back onto the enums WITHOUT inventing data; whatever is still invalid is
 *   dropped per-finding.
 *
 * Returns null when nothing trustworthy survives, in any of three ways: a truncation
 * that cut before the first finding closed (its `[]` means unknown, not clean), no
 * finding AND no recognizable verdict, or an "approved" that would paper over findings
 * we had to drop. The caller then abstains, which is the honest outcome.
 */
export function recover(err: unknown): ProviderResult | null {
  if (!NoObjectGeneratedError.isInstance(err) || typeof err.text !== "string") return null;
  // Nothing was emitted at all (the hidden-reasoning bug) — there is no output to read.
  if (err.text.trim() === "") return null;
  let repaired: unknown;
  try {
    repaired = JSON.parse(jsonrepair(err.text));
  } catch {
    return null;
  }
  const loose = PartialVerdict.safeParse(repaired);
  if (!loose.success) return null;

  const raw = loose.data.findings ?? [];
  const findings: Finding[] = [];
  for (const f of raw) {
    const r = Finding.safeParse(normalizeFinding(f));
    if (r.success) findings.push(r.data);
  }
  const dropped = raw.length - findings.length;
  const truncated = isLengthTruncation(err);

  // A truncated response's findings array is open-ended by construction: a cut landing
  // before the first finding closes (or before any was written at all) jsonrepair-repairs
  // to `[]`, which means "unknown", NOT "clean". So a truncated pass has to carry at
  // least one recovered finding to be worth anything — otherwise all we salvaged is a
  // verdict with nothing behind it, and a bare "changes requested" with zero findings is
  // a blocking review the author cannot act on.
  if (truncated && findings.length === 0) return null;

  // TRUNCATED: the model never finished deciding, so a verdict written before the cut is
  // not its conclusion — a recovered truncation is always "changes" (findings survived,
  // guarded above). COMPLETE: honour what the model actually said. The strict schema
  // allows "approved" WITH findings — that is how nits ride along without blocking — and
  // merge.ts/gate.ts key blocking off this field, so forcing "changes" here would block a
  // PR the model approved and make recovery diverge from the happy path. Fall back to
  // "changes" only when the label is unreadable AND findings survived: never INFER an
  // "approved", but do err toward blocking when something was clearly flagged.
  const stated = normalizeVerdict(loose.data.verdict);
  const verdict = truncated ? "changes" : (stated ?? (findings.length > 0 ? "changes" : null));
  // No finding survived AND no readable verdict: nothing to report honestly.
  if (verdict === null) return null;
  // Every finding was dropped, so nothing actionable is left whatever the label says: an
  // "approved" would paper over defects the model DID raise, and a "changes" would block
  // the PR with no finding to act on. Abstain either way.
  if (findings.length === 0 && dropped > 0) return null;

  const result: ProviderResult = {
    verdict,
    findings,
    // Match the main-path caps: PartialVerdict leaves these unbounded, so truncate here
    // too rather than carry over-length text the strict path would have rejected.
    review_plan: (loose.data.review_plan ?? "").slice(0, 280),
    other_checks: (loose.data.other_checks ?? "").slice(0, 600),
    top_must_fix: (loose.data.top_must_fix ?? []).filter((s): s is string => typeof s === "string"),
  };
  if (truncated) result.finishReason = "length";
  // Only a LOSSY recovery is partial. A complete response that merely used the wrong
  // spelling loses nothing once normalized, so it stays a plain success — flagging it
  // would mark the PR's files unreviewed when they were in fact fully reviewed.
  if (truncated || dropped > 0) {
    result.partial = true;
    result.error = truncated
      ? `output truncated at the token limit — recovered ${findings.length} finding(s) ` +
        `completed before the cut; later findings may be missing. Raise MAX_TOKENS to avoid.`
      : `${dropped} finding(s) did not match the required shape and were dropped; ` +
        `${findings.length} recovered.`;
  }
  return result;
}
