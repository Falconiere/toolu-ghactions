// llm/schema.ts — Zod schema for the structured review verdict. Mirrors the
// SCHEMA built in providers/openrouter/build-request.sh exactly: the same
// required keys, the same severity/confidence enums, the same optional fields.
// generateObject() validates the model's output against this, so a drift here
// is a drift from the deployed bash contract.
import { z } from "zod";

/**
 * A single review finding. `path`, `line`, `severity`, `text` are required
 * (matching build-request.sh's FINDING_ITEM.required); everything else is
 * optional. `line`/`end_line` are integers; `severity`/`confidence` are the
 * fixed enums from the bash schema.
 */
export const Finding = z.object({
  path: z.string(),
  line: z.number().int(),
  end_line: z.number().int().optional(),
  severity: z.enum(["blocker", "high", "medium", "low", "nit"]),
  category: z.string().optional(),
  confidence: z.enum(["high", "medium"]).optional(),
  quoted_line: z.string().optional(),
  suggestion: z
    .string()
    .optional()
    .describe(
      "Replacement CODE ONLY — the exact source text to substitute for lines " +
        "[line..end_line]. GitHub renders it as a committable 'Suggested change', so " +
        "it must be literal, directly-applicable code, never prose, commentary, or an " +
        "instruction like 'remove this line'. Explanations go in `text`. Omit this " +
        "field entirely when there is no clean code replacement.",
    ),
  // Provenance: which layer surfaced this finding. Absent → an LLM-discovered finding
  // (rendered as "llm"); set to a tool name when the model confirms a deterministic
  // (gitleaks/opengrep) finding it was asked to triage.
  source: z.enum(["llm", "gitleaks", "opengrep", "eslint"]).optional(),
  text: z.string(),
});

/**
 * The full review verdict object. `verdict` is the two-value enum
 * (approved | changes) — the provider layer adds the third "error" state on
 * abstention, never the model.
 *
 * Field order and required-ness are deliberate for truncation resilience: the
 * model emits `review_plan` (a bounded plan), then `verdict`, then the unbounded
 * `findings` array. A length-truncated response almost always cuts off INSIDE
 * `findings`, so the fields emitted AFTER it — `other_checks`, `top_must_fix` —
 * are optional with defaults. That lets a JSON-repaired/partial response still
 * validate, so the findings completed before the cut survive instead of the whole
 * chunk being lost.
 */
export const Verdict = z.object({
  // Bounded: review_plan is emitted FIRST, so an unbounded plan eats the output
  // budget before findings and starves them under truncation. The prompt asks for
  // ≤ 2 short sentences (≤ 280 chars) and the JSON-schema maxLength nudges the model,
  // but in JSON mode the provider only receives response_format:{type:"json_object"} —
  // the schema (hence maxLength) is NOT enforced during decoding. So the cap is a soft
  // backstop: an over-length plan is TRUNCATED via .catch rather than failing
  // validation, which would otherwise throw the whole (complete, valid) review away as
  // an abstention.
  review_plan: z
    .string()
    .max(280)
    .catch(({ input }) => (typeof input === "string" ? input.slice(0, 280) : "")),
  verdict: z.enum(["approved", "changes"]),
  findings: z.array(Finding),
  // Soft-capped like review_plan: other_checks is emitted AFTER findings, so in JSON
  // mode its maxLength is a prompt nudge only, never enforced during decoding. The
  // .catch TRUNCATES an over-length blurb to 600 rather than rejecting the whole (valid)
  // review, and ALSO handles the absent-key case (a length-truncated response cut before
  // this field) → "", preserving the prior .default("") truncation-resilience semantics.
  other_checks: z
    .string()
    .max(600)
    .catch(({ input }) => (typeof input === "string" ? input.slice(0, 600) : "")),
  top_must_fix: z.array(z.string()).default([]),
});

/**
 * Loose shape for recovering a response the strict {@link Verdict} rejected — a
 * length-truncated one (only some fields survived the cut) or a complete one whose
 * values deviate from the schema. Every field is optional and the ones the model most
 * often gets wrong stay `unknown`, so each is normalized and validated INDIVIDUALLY
 * rather than sinking the whole response: `findings` elements against {@link Finding},
 * `verdict` through {@link normalizeVerdict}.
 */
export const PartialVerdict = z.object({
  // Decorative fields: `.catch` drops a wrong-typed value (models routinely emit null
  // here) instead of failing the parse, which would sink a recovery over prose.
  review_plan: z.string().optional().catch(undefined),
  // `unknown` with NO `.catch`, deliberately — do not "fix" this to match its neighbours.
  // The whole point of recovery is to rescue an off-enum verdict ("request_changes"),
  // so the value must reach {@link normalizeVerdict} intact; it accepts any type and
  // returns null when unmappable. A `.catch` here would silently discard exactly the
  // strings recovery exists to map.
  verdict: z.unknown().optional(),
  // NOT caught, deliberately: findings is load-bearing. A `findings` that is not an
  // array must fail the whole recovery, because silently reading it as "no findings"
  // would turn defects the model DID raise into a clean review.
  findings: z.array(z.unknown()).optional(),
  other_checks: z.string().optional().catch(undefined),
  top_must_fix: z.array(z.unknown()).optional().catch(undefined),
});

/**
 * Verdict aliases the model reaches for instead of the two enum values. `generateObject`
 * validates against {@link Verdict} AFTER the response is complete, so a model that
 * answers "request_changes" — a perfectly good review — fails validation and the whole
 * pass is thrown away as an abstention. Recovery maps these back; anything unrecognized
 * stays unrecognized (see {@link normalizeVerdict}).
 */
const VERDICT_ALIASES: Record<string, "approved" | "changes"> = {
  approved: "approved",
  approve: "approved",
  approval: "approved",
  accept: "approved",
  accepted: "approved",
  lgtm: "approved",
  pass: "approved",
  changes: "changes",
  change: "changes",
  requestchanges: "changes",
  changesrequested: "changes",
  requestedchanges: "changes",
  reject: "changes",
  rejected: "changes",
  block: "changes",
  blocked: "changes",
};

/**
 * Severity aliases, same rationale as {@link VERDICT_ALIASES}. Only synonyms that map
 * UNAMBIGUOUSLY onto the five-level scale are listed — an unrecognized severity cannot
 * be ranked or gated on, so recovery drops that finding rather than inventing a level.
 */
const SEVERITY_ALIASES: Record<string, "blocker" | "high" | "medium" | "low" | "nit"> = {
  blocker: "blocker",
  blocking: "blocker",
  critical: "blocker",
  fatal: "blocker",
  high: "high",
  major: "high",
  error: "high",
  medium: "medium",
  moderate: "medium",
  warning: "medium",
  warn: "medium",
  low: "low",
  minor: "low",
  info: "low",
  informational: "low",
  nit: "nit",
  nitpick: "nit",
  style: "nit",
};

/** Lowercase + strip everything but letters, so "Request-Changes" and "request_changes"
 *  collapse onto the same alias key. */
function aliasKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.toLowerCase().replace(/[^a-z]/g, "");
  return key === "" ? null : key;
}

/** Map a model-emitted verdict onto the enum, or null when it is unrecognizable. */
export function normalizeVerdict(value: unknown): "approved" | "changes" | null {
  const key = aliasKey(value);
  return key === null ? null : (VERDICT_ALIASES[key] ?? null);
}

/**
 * Coerce a model-emitted line number to an integer. Models routinely quote line numbers
 * ("42") or emit "42:8"; both are unambiguous. Returns null when no integer is present,
 * which fails the finding (a finding without a line cannot be anchored to the diff).
 */
function normalizeLine(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value !== "string") return null;
  const match = /^\s*(-?\d+)/.exec(value);
  return match?.[1] === undefined ? null : Number.parseInt(match[1], 10);
}

/**
 * Rewrite one raw finding into the shape {@link Finding} accepts, WITHOUT inventing
 * data: line numbers are coerced from their string form, severity is alias-mapped, and
 * an unrecognized value in an OPTIONAL enum (`confidence`, `source`) drops just that
 * field instead of failing the whole finding. Anything still invalid — no path, no text,
 * no rankable severity — is left to fail {@link Finding}, and the caller drops it.
 *
 * Returns the raw input unchanged when it is not an object, so the caller's
 * `Finding.safeParse` produces the rejection.
 */
export function normalizeFinding(raw: unknown): unknown {
  // z.record rejects null and arrays, so this both narrows and validates in one step —
  // no cast needed to read the model's arbitrary keys.
  const asObject = z.record(z.unknown()).safeParse(raw);
  if (!asObject.success) return raw;
  const out = { ...asObject.data };

  const line = normalizeLine(out["line"]);
  if (line === null) delete out["line"];
  else out["line"] = line;

  const endLine = normalizeLine(out["end_line"]);
  if (endLine === null) delete out["end_line"];
  else out["end_line"] = endLine;

  const severity = aliasKey(out["severity"]);
  if (severity !== null && SEVERITY_ALIASES[severity] !== undefined) {
    out["severity"] = SEVERITY_ALIASES[severity];
  }

  // Optional enums: an unrecognized value is dropped, never allowed to sink the finding.
  if (out["confidence"] !== "high" && out["confidence"] !== "medium") delete out["confidence"];
  const source = out["source"];
  if (source !== "llm" && source !== "gitleaks" && source !== "opengrep" && source !== "eslint") {
    delete out["source"];
  }
  return out;
}

/** A review finding, inferred from the {@link Finding} schema. */
export type Finding = z.infer<typeof Finding>;

/** The model's structured review verdict, inferred from the {@link Verdict} schema. */
export type Verdict = z.infer<typeof Verdict>;
