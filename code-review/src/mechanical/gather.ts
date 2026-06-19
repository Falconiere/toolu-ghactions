// mechanical/gather.ts — collect deterministic findings from the SARIF files the
// composite SAST steps wrote into TOOLU_SARIF_DIR (gitleaks.sarif, opengrep.sarif),
// deduped by tool+rule+location. The single entry point the pipeline calls before
// the LLM review. Resilient: an absent/unreadable dir → [] (the review still runs).
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parseSarif } from "./sarif.js";
import type { MechanicalFinding, MechanicalTool } from "./sarif.js";

/** Infer the producing tool from a SARIF filename (semgrep is Opengrep's upstream — same schema). */
function toolForFile(name: string): MechanicalTool | null {
  if (name.includes("gitleaks")) return "gitleaks";
  if (name.includes("opengrep") || name.includes("semgrep")) return "opengrep";
  return null;
}

/**
 * Collect + dedupe deterministic findings from every recognized `*.sarif` in
 * `sarifDir`. Absent/empty dir or unreadable path → [] — a missing scan must never
 * break the review.
 */
export function gatherMechanical(sarifDir: string | undefined): MechanicalFinding[] {
  if (sarifDir === undefined || sarifDir === "") return [];
  let names: string[];
  try {
    names = readdirSync(sarifDir);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: MechanicalFinding[] = [];
  for (const name of names) {
    if (!name.endsWith(".sarif")) continue;
    const tool = toolForFile(name);
    if (tool === null) continue;
    for (const finding of parseSarif(join(sarifDir, name), tool)) {
      const key = `${finding.tool}|${finding.ruleId}|${finding.path}|${finding.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(finding);
    }
  }
  return out;
}
