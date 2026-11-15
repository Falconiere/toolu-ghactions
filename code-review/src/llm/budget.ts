// llm/budget.ts — the output-token budget policy for one review call, and the wording
// that reports it. One place decides how far a truncated chunk may escalate, what a
// provider's "your max_tokens is too big" refusal looks like, and how a salvaged review
// explains itself to the reader; reviewWithModel.ts keeps the orchestration only.
//
// WHY IT IS SEPARATE: the escalation ladder and the salvage sentences are policy that
// several call sites need — reviewWithModel's streamed salvage, recover.ts's jsonrepair
// fallback, and (through the reused message) merge.ts's banner. Composing those sentences
// twice is how PR #6 ended up advising "Raise MAX_TOKENS" on a budget already at its
// ceiling, so they are single-sourced here and nowhere else.
import { APICallError } from "ai";
import { z } from "zod";

/**
 * Hard ceiling for the output-token budget of one review call. A chunk whose structured
 * output overruns max_tokens is retried with a DOUBLED budget; this bounds that ladder so
 * a pathological chunk never asks for a budget the provider would refuse outright.
 *
 * 131072 is the largest budget the shipped models accept for a single completion. Each
 * escalation doubles the CURRENT budget, so only the action's default 8192 lands on the
 * ceiling in exactly {@link MAX_ESCALATIONS} doublings — any other starting budget just
 * climbs its own ladder until this ceiling caps it (a 4096 start tops out at 65536).
 */
export const MAX_TOKEN_CEILING = 131_072;

/**
 * Max doubling retries for a length-truncated response. Four, because from the default
 * MAX_TOKENS of 8192 exactly four doublings reach {@link MAX_TOKEN_CEILING}
 * (16384 → 32768 → 65536 → 131072) — fewer would leave the ceiling unreachable at the
 * default, more would only re-try budgets the ceiling already caps.
 *
 * Counted SEPARATELY from reviewWithModel's hang attempts: a truncation is a complete,
 * healthy response that simply did not fit, so escalating must not spend the retries that
 * exist for a stalled provider (and must not reset them either).
 */
export const MAX_ESCALATIONS = 4;

/**
 * The escalation decision: the budget the NEXT call should ask for, or null when there is
 * no headroom left (the ceiling is reached, or the doubling ladder is exhausted) and the
 * caller must salvage what it has instead.
 */
export function nextBudget(budget: number, escalations: number): number | null {
  if (escalations >= MAX_ESCALATIONS || budget >= MAX_TOKEN_CEILING) return null;
  return Math.min(budget * 2, MAX_TOKEN_CEILING);
}

/**
 * True when the budget cannot grow any further, whatever the escalation count — i.e. the
 * request already asked for {@link MAX_TOKEN_CEILING}. This is what picks between the two
 * salvage sentences: with headroom the reader can still raise MAX_TOKENS, at the ceiling
 * the only remaining knob is a smaller chunk.
 */
export function budgetExhausted(budget: number): boolean {
  return budget >= MAX_TOKEN_CEILING;
}

/**
 * The provider's structured error envelope, as far as the cap check reads it. Both fields
 * are nullish because real bodies vary (`"param": null` is common); unknown sibling keys
 * are stripped, and anything not shaped like this is simply not read as a cap complaint.
 */
const ProviderErrorBody = z.object({
  error: z.object({
    message: z.string().nullish(),
    param: z.string().nullish(),
  }),
});

/**
 * The provider's OWN structured complaint (`error.message` / `error.param`) out of an HTTP
 * error body, or undefined for a non-JSON or differently-shaped body — never a throw.
 * Read directly because the provider SDKs' own error schemas can reject real bodies
 * (OpenRouter's `{message, code}` lacks the `type`/`param` they require).
 */
export function providerError(
  responseBody: string | undefined,
): z.infer<typeof ProviderErrorBody>["error"] | undefined {
  if (responseBody === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(responseBody);
  } catch {
    return undefined; // not JSON → no structured complaint to read
  }
  const parsed = ProviderErrorBody.safeParse(raw);
  return parsed.success ? parsed.data.error : undefined;
}

/**
 * True when the provider's OWN complaint names `max_tokens` — read from the structured
 * `error.message` / `error.param` fields, never from the raw body text.
 *
 * A raw substring match over `responseBody` is wrong by construction: this action ALWAYS
 * sends `max_tokens`, so any gateway that echoes the request payload into a 400 body
 * matches, and an unrelated 400 (bad model id, context length exceeded) gets reported to
 * the reader as "the output budget is at its ceiling" — with the provider's real message
 * thrown away. Non-JSON and differently-shaped bodies return false instead of throwing.
 */
function providerComplaintNamesMaxTokens(responseBody: string | undefined): boolean {
  const complaint = providerError(responseBody);
  return (
    (complaint?.message ?? "").includes("max_tokens") ||
    (complaint?.param ?? "").includes("max_tokens")
  );
}

/**
 * True when the provider REFUSED the requested budget: an HTTP 400 whose own error
 * message or `param` names `max_tokens` (e.g. DeepSeek's "Invalid max_tokens value, the
 * valid range of max_tokens is [1, 8192]"). That is a hard per-request cap — retrying at
 * a bigger budget would fail identically, so the caller salvages instead of escalating.
 *
 * The PARENTHESIZATION is load-bearing: the status check ANDs over both text checks, so a
 * 429 or 500 whose body happens to echo `max_tokens` (a rate-limit message quoting the
 * request, a gateway dumping the payload) is NOT a cap — those are transient transport
 * failures and must keep their normal classification. The body check reads only the
 * provider's structured complaint for the same reason at status 400.
 */
export function isProviderCap(err: unknown): boolean {
  if (!APICallError.isInstance(err)) return false;
  return (
    err.statusCode === 400 &&
    ((err.message ?? "").includes("max_tokens") ||
      providerComplaintNamesMaxTokens(err.responseBody))
  );
}

/**
 * The sentence a length-truncated, salvaged review carries. Two variants, chosen by the
 * budget state the caller actually reached:
 *
 * - headroom left → the reader's next move is a bigger budget (MAX_TOKENS), so name it
 *   together with the ceiling it may not exceed;
 * - exhausted (at {@link MAX_TOKEN_CEILING}, or refused by the provider) → MAX_TOKENS is
 *   NOT the knob any more; the review has to be split into smaller chunks instead.
 */
export function truncationSalvageMessage(recovered: number, exhausted: boolean): string {
  const head =
    `output truncated at the token limit — recovered ${recovered} finding(s) ` +
    `completed before the cut; later findings may be missing.`;
  return exhausted
    ? `${head} The output budget is at its ceiling (${MAX_TOKEN_CEILING}) — ` +
        `lower MAX_CHUNK_LINES so each chunk needs less output.`
    : `${head} Raise MAX_TOKENS (ceiling ${MAX_TOKEN_CEILING}) to avoid.`;
}

/**
 * The sentence a DEADLINE-salvaged review carries: our own per-attempt deadline cut a
 * stream that had already produced findings, on the final attempt. Deliberately distinct
 * from the truncation wording — the budget was never the problem here, so pointing at
 * MAX_TOKENS would send the reader after the wrong knob.
 */
export function deadlineSalvageMessage(recovered: number): string {
  return (
    `the model did not answer within the per-attempt deadline — recovered ${recovered} ` +
    `finding(s) received before the cut; later findings may be missing. Raise ` +
    `REQUEST_TIMEOUT_MS, or lower MAX_CHUNK_LINES so each chunk answers faster.`
  );
}

/**
 * The sentence a NON-truncation lossy recovery carries: the response was complete, but
 * some findings did not match the required shape and were dropped. Split from the
 * truncation wording on purpose — nothing here is about the token budget, and advising a
 * budget change for a schema deviation is advice that cannot help.
 */
export function droppedFindingsMessage(dropped: number, recovered: number): string {
  return (
    `${dropped} finding(s) did not match the required shape and were dropped; ` +
    `${recovered} recovered.`
  );
}
