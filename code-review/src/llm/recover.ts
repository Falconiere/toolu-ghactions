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
//
// The ABSTENTION itself lives here too ({@link abstain}), because it is the other half of
// the same decision: recover-then-abstain is one policy, and keeping the two together is
// what stops a caller from inventing a third answer. reviewWithModel keeps only the loop.
import { NoObjectGeneratedError } from "ai";
import { jsonrepair } from "jsonrepair";
import { errorMessage } from "@/errors.js";
import { Finding, PartialVerdict, normalizeFinding, normalizeVerdict } from "./schema.js";
import {
  deadlineSalvageMessage,
  droppedFindingsMessage,
  truncationSalvageMessage,
} from "./budget.js";
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

/** A salvaged findings prefix — what a cut stream (length or deadline) did deliver
 *  before it stopped. The plan is emitted first, so it usually survives the cut. */
export interface Prefix {
  findings: Finding[];
  review_plan?: string;
}

/** The better of two salvaged prefixes: more completed findings wins, and a tie keeps the
 *  one already retained (the earlier attempt), so a retry never loses ground. The caller
 *  carries the winner across ALL its attempts and budget escalations. */
export function bestPrefix(current: Prefix | undefined, candidate: Prefix): Prefix {
  if (current === undefined) return candidate;
  return candidate.findings.length > current.findings.length ? candidate : current;
}

/** Why a salvaged review is only a prefix, and (for a length cut) whether the output
 *  budget still had room — the two facts that pick the salvage wording in budget.ts. */
export interface Cut {
  /** "length" — the model hit max_tokens; "deadline" — OUR per-attempt timer cut it. */
  reason: "length" | "deadline";
  /** Length cuts only: the budget was already at the output-token ceiling (or the
   *  provider refused it), so raising MAX_TOKENS is no longer the reader's move. */
  exhausted?: boolean;
}

/**
 * Compose the {@link ProviderResult} for a findings prefix salvaged from a STREAM — the
 * streaming counterpart of {@link recover}'s truncation branch, and deliberately shaped
 * identically to it: verdict "changes" (a cut review never approves — the model never saw
 * the findings it had not written yet), `partial` set, and the budget.ts wording for the
 * cut it actually suffered.
 *
 * The caller guarantees a non-empty prefix: an empty one must abstain, never become a
 * zero-finding blocking review.
 */
export function salvageResult(salvaged: Prefix, cut: Cut): ProviderResult {
  const n = salvaged.findings.length;
  const result: ProviderResult = {
    verdict: "changes",
    findings: salvaged.findings,
    review_plan: salvaged.review_plan ?? "",
    partial: true,
    error:
      cut.reason === "deadline"
        ? deadlineSalvageMessage(n)
        : truncationSalvageMessage(n, cut.exhausted === true),
  };
  // Only a length cut carries a finish reason; a deadline cut stopped for our own
  // reasons, and claiming "length" there would send the reader after the wrong knob.
  if (cut.reason === "length") result.finishReason = "length";
  if (cut.exhausted === true) result.budgetExhausted = true;
  return result;
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
 *
 * @param exhausted - budget state from the CALLER (only it knows how far the ladder
 * got): true when the output budget was already at its ceiling, which switches a
 * truncation's advice from "raise MAX_TOKENS" to "lower MAX_CHUNK_LINES".
 */
export function recover(err: unknown, exhausted = false): ProviderResult | null {
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
      ? truncationSalvageMessage(findings.length, exhausted)
      : droppedFindingsMessage(dropped, findings.length);
    if (truncated && exhausted) result.budgetExhausted = true;
  }
  return result;
}

/**
 * Classify a thrown error into a bisectability cause. `aborted` — read from the live
 * AbortController at the call site — takes priority: an aborted request can ALSO throw
 * something that looks schema-shaped downstream, but the cause was our own deadline, not
 * the model's output. Otherwise a {@link NoObjectGeneratedError} is a schema failure (the
 * SDK only produces that class for empty/truncated/nonconforming output); every other
 * error reaching here — APICallError for HTTP 5xx after the SDK's own retries, a bare
 * fetch/network failure, or streamVerdict's no-finish-part Error — is transport.
 */
function classifyFailure(err: unknown, aborted: boolean): "schema" | "transport" | "timeout" {
  if (aborted) return "timeout";
  if (NoObjectGeneratedError.isInstance(err)) return "schema";
  return "transport";
}

/**
 * Build the abstention result from a thrown error — what the caller returns when nothing
 * was recoverable and nothing was salvaged. Pulls the model's finishReason off a
 * {@link NoObjectGeneratedError} when present (the error class for empty content — the
 * reasoning-budget bug surfaces here as "length").
 *
 * @param aborted - whether the CALLER's own per-attempt deadline fired; the source of
 * truth for the "timeout" classification, which no error shape can be trusted to carry.
 */
export function abstain(err: unknown, aborted: boolean): ProviderResult {
  const result: ProviderResult = {
    verdict: "error",
    findings: [],
    error: errorMessage(err, "OpenRouter request failed"),
    failure: classifyFailure(err, aborted),
  };
  if (NoObjectGeneratedError.isInstance(err) && err.finishReason !== undefined) {
    result.finishReason = err.finishReason;
  }
  return result;
}
