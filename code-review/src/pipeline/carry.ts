// pipeline/carry.ts — strict carry-forward of prior findings (spec §Carry-forward).
// `reconcile()` resolves any prior thread with no matching current finding and
// `diffState` rebuilds the marker from current findings only, so EVERY path this
// round did not actually review would have its open threads falsely resolved and
// reported `fixed`. Before reconcile/diffState, therefore, the prior findings of
// every path whose ledger status is not "reviewed" are re-injected into this run's
// findings unchanged (their fps are already stamped in the marker).
//
// Re-injection is the trust boundary. Marker findings are attacker-influenceable
// (the sticky comment is editable and `StoredFindingSchema` is `.passthrough()`,
// src/state.ts:48), while every consumer downstream — `dropOutOfScope`'s integer
// `line` invariant, `SEVERITY_RANK`, the inline comment builders — assumes a
// VALIDATED finding. So a prior finding crosses back only by passing the strict
// shape check below; unknown keys are stripped by that parse, and anything that
// fails contributes its path to `carriedWithoutFinding` for the ledger to record
// as carried-without-finding rather than reaching a validated path.
import { z } from "zod";
import { Finding as FindingSchema } from "@/llm/schema.js";
import type { Finding as StoredFinding } from "@/state.js";
import type { CoverageLedger } from "@/review/ledger.js";
import type { StampedFinding } from "./reviewCall.js";

/** The strict shape a marker finding must have to be re-injected: the model
 *  schema (path/line int/severity enum/text) tightened with non-empty `path`,
 *  `text` and `fp`. Zod strips every other marker key on the way through. */
const CarriedFindingSchema = FindingSchema.extend({
  path: z.string().min(1),
  text: z.string().min(1),
  fp: z.string().min(1),
});

/** What {@link carryForward} needs from the run in flight. */
export interface CarryForwardInput {
  /** This round's validated + stamped model findings. */
  modelFindings: StampedFinding[];
  /** `ReviewState.findings` — loosely typed marker content, untrusted. */
  priorFindings: StoredFinding[];
  /** This round's per-path coverage ledger; only non-"reviewed" paths carry. */
  ledger: CoverageLedger;
}

/** {@link carryForward}'s result: the findings the rest of the round works on,
 *  plus the paths whose prior finding could not be re-injected. */
export interface CarryForwardResult {
  /** `modelFindings` followed by every re-injected prior finding, deduped by fp. */
  findings: StampedFinding[];
  /** Paths (sorted, deduped) whose prior finding failed the strict shape check —
   *  the caller ledgers them `carried` with no finding attached. */
  carriedWithoutFinding: string[];
}

/** The prior finding's path when it is a usable string, else null — a finding
 *  without one can neither be looked up in the ledger nor ledgered itself. */
function pathOf(prior: StoredFinding): string | null {
  return typeof prior.path === "string" && prior.path !== "" ? prior.path : null;
}

/**
 * Re-inject the prior findings of every path this round did not review.
 *
 * A path is re-injected unless its ledger entry says `"reviewed"` — a path MISSING
 * from the ledger carries too, because a path nothing recorded is by definition a
 * path nothing reviewed. Model findings win any fp collision (this round's text,
 * line and severity are the fresher truth) and are never reordered. A prior
 * finding failing {@link CarriedFindingSchema} is dropped from the findings and
 * its path reported in `carriedWithoutFinding` instead; one without a usable
 * `path` is dropped outright, there being nothing to ledger it against.
 */
export function carryForward(input: CarryForwardInput): CarryForwardResult {
  const seen = new Set(input.modelFindings.map((f) => f.fp));
  const findings: StampedFinding[] = [...input.modelFindings];
  const withoutFinding = new Set<string>();

  for (const prior of input.priorFindings) {
    const path = pathOf(prior);
    if (path === null) continue;
    if (input.ledger.entries[path]?.status === "reviewed") continue;

    const parsed = CarriedFindingSchema.safeParse(prior);
    if (!parsed.success) {
      withoutFinding.add(path);
      continue;
    }
    if (seen.has(parsed.data.fp)) continue;
    seen.add(parsed.data.fp);
    findings.push(parsed.data);
  }

  return { findings, carriedWithoutFinding: [...withoutFinding].sort() };
}
