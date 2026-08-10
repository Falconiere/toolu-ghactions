// mechanical/sanitize.ts — repair invalid SARIF regions in a COPY, for upload only.
// gitleaks (and other scanners) sometimes emit `region` fields of 0 for path-anchored
// results; GitHub Code Scanning rejects the WHOLE sarif file when any result's region
// is invalid. This never touches the originals — mechanical/sarif.ts's LLM-triage read
// deliberately drops line-0 results, and sanitizing in place would push them back in.
// RESILIENT BY DESIGN: unparseable input returns null; the caller decides how to react.

/** One touched-or-untouched result's fixed region, keyed by the sub-1 policy below. */
export interface SanitizeResult {
  /** The re-serialized document, byte-round-tripped through JSON.parse/stringify. */
  out: string;
  /** Count of results with at least one region field repaired. */
  fixed: number;
}

/**
 * Parse SARIF 2.1.0 text and repair invalid `region` bounds under every
 * `runs[].results[].locations[].physicalLocation.region`:
 * - numeric `startLine < 1` → clamped to 1 (a result must anchor somewhere).
 * - numeric `startColumn`/`endLine`/`endColumn` < 1 → DELETED. SARIF's own
 *   defaults for these are sane (absent `startColumn`/`endColumn` mean "start
 *   of line"/"end of line"; absent `endLine` means `startLine`); clamping
 *   `endColumn` to 1 instead would make an empty region under SARIF's
 *   exclusive-`endColumn` semantics.
 * Non-numeric fields and every result untouched by the above deep-equal the
 * source after parse. Returns `null` for unparseable input (not valid JSON,
 * or not an object at the root).
 */
export function sanitizeSarif(text: string): SanitizeResult | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(doc)) return null;

  let fixed = 0;
  const runs = Array.isArray(doc["runs"]) ? doc["runs"] : [];
  for (const run of runs) {
    if (!isRecord(run)) continue;
    const results = Array.isArray(run["results"]) ? run["results"] : [];
    for (const result of results) {
      if (fixResult(result)) fixed++;
    }
  }

  return { out: JSON.stringify(doc, null, 2), fixed };
}

/** Repair every region under one result's locations. Returns whether any field changed. */
function fixResult(result: unknown): boolean {
  if (!isRecord(result)) return false;
  const locations = Array.isArray(result["locations"]) ? result["locations"] : [];
  let touched = false;
  for (const location of locations) {
    if (!isRecord(location)) continue;
    const physical = location["physicalLocation"];
    if (!isRecord(physical)) continue;
    const region = physical["region"];
    if (!isRecord(region)) continue;
    if (fixRegion(region)) touched = true;
  }
  return touched;
}

/** Apply the clamp/delete policy to one region object in place. Returns whether it changed. */
function fixRegion(region: Record<string, unknown>): boolean {
  let touched = false;
  const startLine = region["startLine"];
  if (typeof startLine === "number" && startLine < 1) {
    region["startLine"] = 1;
    touched = true;
  }
  for (const key of ["startColumn", "endLine", "endColumn"] as const) {
    const value = region[key];
    if (typeof value === "number" && value < 1) {
      delete region[key];
      touched = true;
    }
  }
  return touched;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
