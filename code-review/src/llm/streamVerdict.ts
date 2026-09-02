// llm/streamVerdict.ts — the streaming review call and its findings-prefix salvage.
// One responsibility: run ONE structured review through `streamObject` and report what
// the stream actually produced. It composes no ProviderResult, retries nothing and owns
// no budget policy — reviewWithModel keeps all of that.
//
// WHY STREAM AT ALL: with generateObject a response cut at max_tokens is only readable
// through the thrown error's raw text, so a truncated chunk depends on jsonrepair
// guessing where the JSON should close. Streaming gives us the SDK's own incrementally
// parsed snapshot, so the findings completed before the cut are recoverable verbatim and
// review size stops being a cliff.
//
// ERROR DISCIPLINE (load-bearing — do not "simplify" this):
//   - In ai@4.3.19 the `object` promise NEVER settles on a transport failure or an abort:
//     those surface only as `{type:"error"}` parts on `fullStream` (partialObjectStream
//     swallows them). Awaiting `object` first would therefore HANG FOREVER on exactly the
//     failures this action must survive. So `fullStream` is consumed to completion as the
//     SOLE iterator, and `object` is touched only AFTER a finish part was seen.
//   - `.object` is a DelayedPromise: it materializes on FIRST ACCESS, and a materialized
//     rejection nobody awaits is an unhandled rejection that kills the process. The
//     returning paths (truncated-with-prefix, aborted-with-prefix) therefore never touch
//     it; the empty-prefix truncation path awaits it precisely so the SDK's own
//     NoObjectGeneratedError propagates (classifyFailure → "schema", bisect unchanged) —
//     and awaiting IS handling, so the trap does not apply there.
//   - A failure is re-thrown VERBATIM (never wrapped): reviewWithModel's classifyFailure
//     and recover() branch on the error's identity (APICallError vs
//     NoObjectGeneratedError), which any wrapping would destroy.
//   - Our own per-attempt abort arrives in TWO shapes, both handled the same way: as an
//     error part when the request is cut before the response headers (postJsonToApi
//     rejects and streamObject enqueues it), and as a THROW out of the iteration when it
//     is cut mid-body (the response stream errors). A BARREN abort re-throws either way,
//     so reviewWithModel's hang-retry branch still fires exactly as before.
//   - A stream that ends with neither a finish nor an error part throws a
//     transport-classified plain Error rather than falling through to `await object`
//     (same deadlock class). Backstop only: both shipped providers synthesize a finish
//     part in their transform's flush, so a body that closes early instead errors the
//     stream and lands in the throw path above.
//   - `object` resolves against the SDK's REPAIRED PARTIAL SNAPSHOT, not the raw text
//     generateObject used to parse. So a response cut at `"findings":[` closes to an
//     empty array and VALIDATES — which is why the empty-prefix truncation raises
//     NoObjectGeneratedError itself when the await resolves: `[]` after a cut means
//     unknown, not clean, and a zero-finding "changes" is a review nobody can act on.
import {
  NoObjectGeneratedError,
  streamObject,
  type LanguageModel,
  type ObjectStreamPart,
  type ProviderMetadata,
} from "ai";
import { Finding, PartialVerdict, Verdict, normalizeFinding } from "./schema.js";

/** Everything one streamed review call needs. Mirrors the generateObject call it
 *  replaces; `mode: "json"`, the {@link Verdict} schema and temperature 0 are pinned
 *  here because they are the wire contract, not a caller's choice (a provider that
 *  rejects an explicit temperature strips it in its own model — providers.ts). */
export interface StreamVerdictArgs {
  /** resolveModel() output — the provider-specific AI SDK model object. */
  model: LanguageModel;
  /** System prompt (the review checklist envelope). */
  system: string;
  /** User prompt (the diff envelope). */
  prompt: string;
  /** Output-token budget for this attempt. */
  maxTokens: number;
  /** Transient-failure retries INSIDE the SDK (5xx, network). */
  maxRetries: number;
  /** The caller's per-attempt deadline signal; also the source of truth for "aborted". */
  abortSignal: AbortSignal;
  /** Per-call provider extras (native DeepSeek's / MiniMax's reasoning switch). */
  providerOptions?: ProviderMetadata;
}

/**
 * What the stream produced.
 *
 * - `complete` — a finish part arrived and the SDK validated the object (the happy path,
 *   byte-identical to what generateObject returned).
 * - `truncated` — `finish_reason: "length"` with at least one finding completed before
 *   the cut. An EMPTY prefix is deliberately NOT this outcome: it throws instead, so
 *   recover.ts's "`[]` means unknown, not clean" fail-safe still abstains.
 * - `aborted-with-prefix` — the caller's deadline cut a stream that had already produced
 *   at least one complete finding.
 */
export type StreamVerdictResult =
  | { outcome: "complete"; object: Verdict; finishReason: string }
  | { outcome: "truncated"; findings: Finding[]; review_plan?: string; finishReason: "length" }
  | { outcome: "aborted-with-prefix"; findings: Finding[]; review_plan?: string };

/** The salvageable part of a partial snapshot: findings that already validate, plus the
 *  plan (emitted first, so it survives almost every cut). */
interface Prefix {
  findings: Finding[];
  review_plan?: string;
}

/** The finish part's payload — it carries everything {@link NoObjectGeneratedError}
 *  needs, so an abstention raised here is indistinguishable from the SDK's own. */
type FinishPart = Extract<ObjectStreamPart<unknown>, { type: "finish" }>;

/** review_plan's cap in the {@link Verdict} schema — applied here too, so a salvaged
 *  plan can never be longer than one the strict path would have accepted. */
const PLAN_CAP = 280;

/**
 * Stream one structured review and report the outcome. Throws (verbatim) on every
 * failure that is not a salvageable cut — see the module header's error discipline.
 */
export async function streamVerdict(args: StreamVerdictArgs): Promise<StreamVerdictResult> {
  const result = streamObject({
    model: args.model,
    // JSON mode, not the SDK default "tool" mode: the deployed wire contract reads the
    // verdict from message.content via response_format, and the recorded fixtures match.
    mode: "json",
    schema: Verdict,
    system: args.system,
    prompt: args.prompt,
    temperature: 0,
    maxTokens: args.maxTokens,
    maxRetries: args.maxRetries,
    abortSignal: args.abortSignal,
    providerOptions: args.providerOptions,
  });

  // Read AFTER the loop, so they must outlive it: the latest snapshot the SDK parsed out
  // of the partial JSON, the raw text behind it (the deltas concatenate to exactly the
  // SDK's own accumulated text), and the finish part.
  let snapshot: unknown;
  let text = "";
  let finish: FinishPart | undefined;
  try {
    for await (const part of result.fullStream) {
      if (part.type === "object") snapshot = part.object;
      else if (part.type === "text-delta") text += part.textDelta;
      else if (part.type === "finish") finish = part;
      else if (part.type === "error") return salvageAbortOrThrow(part.error, args, snapshot);
    }
  } catch (err) {
    // A mid-body failure (our abort cutting the response stream, a connection reset)
    // errors the stream instead of enqueueing a part. Same decision, same verbatim throw.
    return salvageAbortOrThrow(err, args, snapshot);
  }

  if (finish === undefined) {
    // Never `await result.object` here: it would never settle. A plain Error is what
    // classifyFailure maps to "transport", which is the honest cause.
    throw new Error("model stream ended without a finish or error part");
  }
  const { finishReason } = finish;
  if (finishReason !== "length") {
    // Clean finish: the SDK-validated object, or its NoObjectGeneratedError for output
    // that never matched the schema — the throw the existing recover() path expects.
    return { outcome: "complete", object: await result.object, finishReason };
  }
  const prefix = salvagePrefix(snapshot);
  if (prefix.findings.length > 0) return { outcome: "truncated", ...prefix, finishReason };
  // Cut before ANY finding completed. The await surfaces the SDK's own error when the
  // repaired snapshot does not validate; when it DOES validate the object is an empty
  // review the model never finished writing, so raise the same class over it rather than
  // report a zero-finding verdict. Either way classifyFailure reads "schema" and
  // recover() gets the raw text, so the budget escalation still sees a real truncation.
  await result.object;
  throw new NoObjectGeneratedError({
    message: "No object generated: response was cut before the first finding completed.",
    text,
    response: finish.response,
    usage: finish.usage,
    finishReason,
  });
}

/**
 * The one decision every failure path shares: our own deadline cut a stream that had
 * already produced usable findings → salvage them; anything else (including a BARREN
 * abort, which must keep reaching reviewWithModel's hang retry) → re-throw `err`
 * verbatim, identity intact.
 */
function salvageAbortOrThrow(
  err: unknown,
  args: StreamVerdictArgs,
  snapshot: unknown,
): { outcome: "aborted-with-prefix"; findings: Finding[]; review_plan?: string } {
  if (args.abortSignal.aborted) {
    const prefix = salvagePrefix(snapshot);
    if (prefix.findings.length > 0) return { outcome: "aborted-with-prefix", ...prefix };
  }
  throw err;
}

/**
 * The findings of a partial snapshot that already validate, element-wise. The SDK's
 * partial parser closes the open JSON, so the half-written trailing finding is present
 * but almost always invalid (a cut severity/path fails its own schema) and drops out
 * here — the completed ones survive. NORMALIZE, NEVER INVENT: same rule as recover.ts.
 */
function salvagePrefix(snapshot: unknown): Prefix {
  const loose = PartialVerdict.safeParse(snapshot);
  if (!loose.success) return { findings: [] };
  const findings: Finding[] = [];
  for (const raw of loose.data.findings ?? []) {
    const parsed = Finding.safeParse(normalizeFinding(raw));
    if (parsed.success) findings.push(parsed.data);
  }
  const plan = loose.data.review_plan;
  return plan === undefined ? { findings } : { findings, review_plan: plan.slice(0, PLAN_CAP) };
}
