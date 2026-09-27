// gate/settleCheck.ts — merge-gate's READ-ONLY settle recompute (#123): the shared
// evaluation (pipeline/settleEvaluation.ts) flattened into the step outputs the
// merge-gate composite hands its bash gate. It writes nothing to GitHub and calls no
// model: `approve` only tells the gate that the missing `merge-approved` label would
// resolve to approved on the live head, so the check can pass without a push.
//
// FAIL CLOSED: every refusal, and any unexpected throw, is `outcome: "unchanged"` with a
// reason — the gate then keeps its missing-label problem.
import { evaluateSettle } from "@/pipeline/settleEvaluation.js";
import type { SettleEvalDeps } from "@/pipeline/settleEvaluation.js";

/** The nested action's outputs (merge-gate/recompute/action.yml). */
export interface SettleCheckOutputs {
  outcome: "approve" | "unchanged";
  /** Why nothing was approved; empty on approve. */
  reason: string;
  /** The recomputed comment verdict on approve ("changes" = advisory remainder); else empty. */
  verdict: "approved" | "changes" | "";
  settled: number;
  total: number;
}

/** Recompute for `deps.target`; never throws. */
export async function runSettleCheck(deps: SettleEvalDeps): Promise<SettleCheckOutputs> {
  try {
    const evaluation = await evaluateSettle(deps);
    if (evaluation.kind !== "approve") return unchanged(evaluation.reason);
    const { verdict, settled, total } = evaluation.outcome;
    return { outcome: "approve", reason: "", verdict, settled, total };
  } catch {
    return unchanged("error");
  }
}

function unchanged(reason: string): SettleCheckOutputs {
  return { outcome: "unchanged", reason, verdict: "", settled: 0, total: 0 };
}
