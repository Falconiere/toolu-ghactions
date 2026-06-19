// review/validate.ts — deterministic finding gate (no LLM). Port of
// validate-findings.sh, plus the intra-result dedup carried over from
// coordinate-findings.sh (the single-model path never coordinates multiple
// providers, so the dedup that used to live there runs here instead).
//
// Three drops, in order, matching the bash jq pipeline:
//   1. Anchored — the cited `line` must be a real changed line in the diff for
//      that path (anti-hallucination). Unanchored findings are dropped.
//   2. Confidence gate — keep blocker/high severity regardless; otherwise the
//      finding's confidence must meet MIN_CONFIDENCE (high floor keeps high
//      only; medium floor keeps high or medium). Missing confidence is "low".
//   3. Suggestion strip — keep `suggestion` only when confidence is high AND the
//      whole [line..end_line] span is inside the diff; else strip it (the
//      finding survives, only the unsafe-to-apply patch is removed).
// Then dedup by (path|line|end_line|normalized-text) fingerprint, keeping the
// max severity within each group.
import type { Finding } from "@/llm/schema.js";
// SEVERITY_RANK is owned by render.ts (single source of truth) — imported here so
// the dedup's max-severity comparison can never drift from the render ordering.
import { SEVERITY_RANK } from "./render.js";

/** Confidence floor: "high" keeps high only; "medium" keeps high or medium. */
export type MinConfidence = "high" | "medium";

/**
 * Filter and dedup model findings against the diff's changed lines.
 *
 * @param findings - raw findings from the model.
 * @param changedLinesByPath - map of path → the new-file line numbers present in
 *   the diff for that path (from ShapedFile.changed_lines). A path with no entry
 *   has no anchorable lines, so all its findings are unanchored and dropped.
 * @param minConfidence - the MIN_CONFIDENCE floor (high|medium).
 * @returns the kept findings, deduped, in input order (dedup keeps the first
 *   occurrence of each fingerprint, upgraded to the group's max severity).
 */
export function validateFindings(
  findings: Finding[],
  changedLinesByPath: Map<string, number[]>,
  minConfidence: MinConfidence,
): Finding[] {
  const kept: Finding[] = [];
  for (const f of findings) {
    const changed = changedLinesByPath.get(f.path) ?? [];
    const changedSet = new Set(changed);

    // 1. Anchored: the cited line must be a real changed line in the diff.
    if (!changedSet.has(f.line)) continue;

    // 2. Confidence gate. Missing confidence is treated as below medium ("low").
    const c = f.confidence ?? "low";
    const keep =
      f.severity === "blocker" ||
      f.severity === "high" ||
      (minConfidence === "high" && c === "high") ||
      (minConfidence === "medium" && (c === "high" || c === "medium"));
    if (!keep) continue;

    // 3. Suggestion strip: keep it only when high-confidence AND the whole span
    // is in the diff; otherwise drop just the suggestion, keep the finding.
    const spanInDiff = spanIsInDiff(f, changedSet);
    if (f.suggestion !== undefined && !(f.confidence === "high" && spanInDiff)) {
      const { suggestion: _dropped, ...rest } = f;
      kept.push(rest);
    } else {
      kept.push(f);
    }
  }

  return dedup(kept);
}

/**
 * True when every line in [line..end_line] is present in the diff's changed set
 * (end_line defaults to line). Mirrors the jq set-difference length===0 check.
 */
function spanIsInDiff(f: Finding, changedSet: Set<number>): boolean {
  const end = f.end_line ?? f.line;
  for (let l = f.line; l <= end; l++) {
    if (!changedSet.has(l)) return false;
  }
  return true;
}

/**
 * Dedup by (path|line|end_line|normalized-text-prefix), keeping the first
 * occurrence per group upgraded to the group's max (most-severe) severity.
 * Port of coordinate-findings.sh's group_by + min_by(severity rank).
 */
function dedup(findings: Finding[]): Finding[] {
  const byKey = new Map<string, Finding>();
  const order: string[] = [];
  for (const f of findings) {
    const key = dedupKey(f);
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, f);
      order.push(key);
    } else if (SEVERITY_RANK[f.severity] < SEVERITY_RANK[existing.severity]) {
      // Keep the existing object's identity/position but adopt the worse severity.
      byKey.set(key, { ...existing, severity: f.severity });
    }
  }
  return order.map((k) => byKey.get(k)).filter((f) => f !== undefined);
}

/** The dedup group key: path|line|end_line|first-80-chars of normalized text. */
function dedupKey(f: Finding): string {
  const end = f.end_line ?? f.line;
  const normText = f.text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 80);
  return `${f.path}|${f.line}|${end}|${normText}`;
}
