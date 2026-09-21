// wallDeadline.ts — one review-wide budget shared by requests, retries and backoff.
import { abstain, salvageResult, type Prefix } from "./recover.js";
import type { ProviderResult } from "./reviewWithModel.js";

/** Milliseconds left in the shared budget; an omitted deadline has no limit. */
export function wallTimeLeft(deadline: number | undefined): number {
  return deadline === undefined ? Infinity : Math.max(0, deadline - Date.now());
}

/** Preserve completed findings on expiry, without claiming the review finished. */
export function wallDeadlineResult(prefix: Prefix | undefined): ProviderResult {
  const message =
    "MAX_WALL_MS review deadline reached. Resume the unreviewed files in another run.";
  if (prefix === undefined || prefix.findings.length === 0) {
    return abstain(new Error(message), true);
  }
  return {
    ...salvageResult(prefix, { reason: "deadline" }),
    error: `${message} Recovered ${prefix.findings.length} finding(s); later findings may be missing.`,
  };
}
