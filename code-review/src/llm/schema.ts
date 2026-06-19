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
  suggestion: z.string().optional(),
  // Provenance: which layer surfaced this finding. Absent → an LLM-discovered finding
  // (rendered as "llm"); set to a tool name when the model confirms a deterministic
  // (gitleaks/opengrep) finding it was asked to triage.
  source: z.enum(["llm", "gitleaks", "opengrep", "eslint"]).optional(),
  text: z.string(),
});

/**
 * The full review verdict object. Required keys match build-request.sh's
 * SCHEMA.schema.required: review_plan, verdict, findings, other_checks,
 * top_must_fix. `verdict` is the two-value enum (approved | changes) — the
 * provider layer adds the third "error" state on abstention, never the model.
 */
export const Verdict = z.object({
  review_plan: z.string(),
  verdict: z.enum(["approved", "changes"]),
  findings: z.array(Finding),
  other_checks: z.string(),
  top_must_fix: z.array(z.string()),
});

/** A review finding, inferred from the {@link Finding} schema. */
export type Finding = z.infer<typeof Finding>;

/** The model's structured review verdict, inferred from the {@link Verdict} schema. */
export type Verdict = z.infer<typeof Verdict>;
