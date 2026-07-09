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
 * Loose shape for salvaging a length-truncated response: only the fields that may
 * survive a mid-JSON cut, all optional. `findings` stays `unknown[]` so each element
 * is validated INDIVIDUALLY against {@link Finding} — the incomplete trailing one is
 * dropped while the finished ones survive.
 */
export const PartialVerdict = z.object({
  review_plan: z.string().optional(),
  verdict: z.enum(["approved", "changes"]).optional(),
  findings: z.array(z.unknown()).optional(),
});

/** A review finding, inferred from the {@link Finding} schema. */
export type Finding = z.infer<typeof Finding>;

/** The model's structured review verdict, inferred from the {@link Verdict} schema. */
export type Verdict = z.infer<typeof Verdict>;
