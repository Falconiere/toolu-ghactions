// Shared deterministic baseline finding validation.
import type { ProviderResult } from "@/llm/reviewWithModel.js";
import type { DiffData } from "@/git/diff.js";
import type { ActionInputs } from "@/inputs.js";
import type { StampedFinding } from "./reviewCall.js";
import { validateFindings } from "@/review/validate.js";
import { fingerprint } from "@/state.js";
/** Validate findings against the diff's changed lines and stamp fingerprints;
 *  also surfaces the self-negation drop count for {@link reviewAndValidate} to
 *  carry forward (settleVerdict's `removed` — see {@link ReviewCallOutput}). */
export function validate(
  result: ProviderResult,
  diff: DiffData,
  inputs: ActionInputs,
): { stamped: StampedFinding[]; selfNegating: number; unsupportedPaths: string[] } {
  const changedLinesByPath = new Map<string, number[]>(
    diff.files.map((f) => [f.path, f.changed_lines]),
  );
  const lineTextByPath = new Map<string, Map<number, string>>(
    diff.files.map((f) => [
      f.path,
      new Map(Object.entries(f.line_text).map(([n, text]) => [Number(n), text])),
    ]),
  );
  const anchored = validateFindings(
    result.findings,
    changedLinesByPath,
    inputs.minConfidence,
    lineTextByPath,
    { requireQuote: true },
  );
  return {
    stamped: anchored.findings.map((f) => ({ ...f, fp: fingerprint(f) })),
    selfNegating: anchored.selfNegating,
    unsupportedPaths: anchored.unsupportedPaths,
  };
}
