// pipeline/packages.ts — assign the review diff's file segments to PACKAGES from
// the Layer 1 brief's `package_hints` (spec §Layer 1: "Code assigns files to
// packages from hints, falling back to the existing groupRelatedSegments").
//
// Two invariants constrain the assignment, and both are load-bearing:
//   1. Module coupling wins. `groupRelatedSegments` (src/git/relate.ts) unions files
//      that must be read together (a Rust parent + its `#[path]` child); a hint may
//      never split such a unit, so hints are applied to UNITS, never to raw segments.
//   2. Packages stay bounded. `packGroups` (src/git/chunk.ts) treats each group it
//      receives as ATOMIC — a group over the budget rides alone as one oversized
//      chunk. A hint like `src/` covering 200 files must therefore NOT come back as
//      one group, or the "bounded per-call prompt" guarantee dies at Layer 1. So each
//      hint's units are packed here into budget-sized runs; `packGroups` then merely
//      packs those runs (and may still coalesce two small ones, which is fine).
//
// With no brief, no hints, or hints matching nothing, the result is exactly
// `groupRelatedSegments`'s own grouping — today's behavior, byte for byte.
import type { FileSegment } from "@/git/chunk.js";
import { groupRelatedSegments } from "@/git/relate.js";
import type { Brief } from "@/review/cartographer.js";

type PackageHint = Brief["package_hints"][number];

/** The hint a unit belongs to: the LONGEST matching `path_prefixes` entry over the
 *  unit's first (path-sorted) path, so `src/auth/` beats `src/` deterministically.
 *  Null when no hint matches — those units keep their own fallback grouping. */
function hintFor(unit: FileSegment[], hints: readonly PackageHint[]): PackageHint | null {
  const path = unit[0]?.path ?? "";
  if (path === "") return null;
  let best: PackageHint | null = null;
  let bestLength = -1;
  for (const hint of hints) {
    for (const prefix of hint.path_prefixes) {
      if (prefix === "" || !path.startsWith(prefix)) continue;
      if (prefix.length > bestLength) {
        best = hint;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}

/** Split one package's units into consecutive runs of at most `maxLines` primed
 *  diff lines. A single unit over the budget rides alone (it cannot be split —
 *  `packGroups` applies the same rule one level up). */
function packUnits(units: FileSegment[][], maxLines: number): FileSegment[][] {
  const runs: FileSegment[][] = [];
  let current: FileSegment[] = [];
  let currentLines = 0;
  for (const unit of units) {
    const unitLines = unit.reduce((n, s) => n + s.lines, 0);
    if (current.length > 0 && currentLines + unitLines > maxLines) {
      runs.push(current);
      current = [];
      currentLines = 0;
    }
    current.push(...unit);
    currentLines += unitLines;
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/**
 * Group `segments` into packages under the brief's hints (see the module header).
 * Hint order is the brief's own; units matching no hint are appended after, each
 * still its own group so the fallback grouping is untouched. `maxLines` ≤ 0 (chunking
 * disabled) or an absent/hint-less brief both short-circuit to `groupRelatedSegments`.
 */
export function groupByBrief(
  segments: FileSegment[],
  brief: Brief | null,
  maxLines: number,
): FileSegment[][] {
  const units = groupRelatedSegments(segments);
  const hints = brief?.package_hints ?? [];
  if (hints.length === 0 || maxLines <= 0) return units;

  const byHint = new Map<PackageHint, FileSegment[][]>(hints.map((hint) => [hint, []]));
  const unmatched: FileSegment[][] = [];
  for (const unit of units) {
    const hint = hintFor(unit, hints);
    if (hint === null) unmatched.push(unit);
    else byHint.get(hint)?.push(unit);
  }

  const groups: FileSegment[][] = [];
  for (const packageUnits of byHint.values()) {
    if (packageUnits.length > 0) groups.push(...packUnits(packageUnits, maxLines));
  }
  return [...groups, ...unmatched];
}
