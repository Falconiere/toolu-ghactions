// mechanical/sarif.ts — parse a SARIF 2.1.0 report into MechanicalFinding[].
// Deterministic tools (gitleaks for secrets, Opengrep for SAST patterns) emit SARIF;
// the action reads it and folds the findings into the review as LLM-triage context.
// RESILIENT BY DESIGN: a missing, unparseable, or empty report yields [] — a failed
// or skipped scan must never break the review (the LLM still runs; degradation is graceful).
import { readFileSync } from "node:fs";

/** The deterministic tool a finding came from (drives the comment's provenance tag). */
export type MechanicalTool = "gitleaks" | "opengrep" | "eslint";

/** SARIF result level, mapped 1:1 to our severity. */
export type MechanicalSeverity = "error" | "warning" | "note";

/** One deterministic finding, normalized from a SARIF result. */
export interface MechanicalFinding {
  tool: MechanicalTool;
  ruleId: string;
  path: string;
  /** 1-based start line. */
  line: number;
  /** 1-based end line, when the report carries one. */
  endLine?: number;
  severity: MechanicalSeverity;
  message: string;
}

/** Severity when neither the result nor its rule declares a SARIF level. A leaked
 * secret is always serious; SAST patterns default to warning. */
const TOOL_DEFAULT_SEVERITY: Record<MechanicalTool, MechanicalSeverity> = {
  gitleaks: "error",
  opengrep: "warning",
  eslint: "warning",
};

/**
 * Parse a SARIF 2.1.0 report file into findings tagged with `tool`. Never throws:
 * a missing/garbage/empty report returns []. Results without an anchorable
 * `path:line` are dropped (they can't be cited in the diff).
 */
export function parseSarif(file: string, tool: MechanicalTool): MechanicalFinding[] {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const runs = isRecord(doc) && Array.isArray(doc["runs"]) ? doc["runs"] : [];
  const out: MechanicalFinding[] = [];
  for (const run of runs) {
    if (!isRecord(run)) continue;
    const ruleLevel = ruleLevelMap(run);
    const results = Array.isArray(run["results"]) ? run["results"] : [];
    for (const result of results) {
      const finding = toFinding(result, tool, ruleLevel);
      if (finding !== null) out.push(finding);
    }
  }
  return out;
}

/** Map each rule id → its declared SARIF level (Opengrep puts severity here, not on the result). */
function ruleLevelMap(run: Record<string, unknown>): Map<string, string> {
  const map = new Map<string, string>();
  const tool = run["tool"];
  const driver = isRecord(tool) ? tool["driver"] : undefined;
  const rules = isRecord(driver) && Array.isArray(driver["rules"]) ? driver["rules"] : [];
  for (const rule of rules) {
    if (!isRecord(rule)) continue;
    const id = asString(rule["id"]);
    const dc = rule["defaultConfiguration"];
    const level = isRecord(dc) ? asString(dc["level"]) : undefined;
    if (id !== undefined && level !== undefined) map.set(id, level);
  }
  return map;
}

/** Normalize one SARIF result into a finding, or null when it isn't anchorable. */
function toFinding(
  result: unknown,
  tool: MechanicalTool,
  ruleLevel: Map<string, string>,
): MechanicalFinding | null {
  if (!isRecord(result)) return null;
  const ruleId = asString(result["ruleId"]) ?? "";

  const locations = result["locations"];
  const loc0 = Array.isArray(locations) ? locations[0] : undefined;
  const physical = isRecord(loc0) ? loc0["physicalLocation"] : undefined;
  const artifact = isRecord(physical) ? physical["artifactLocation"] : undefined;
  const region = isRecord(physical) ? physical["region"] : undefined;

  const path = (isRecord(artifact) ? asString(artifact["uri"]) : undefined) ?? "";
  const line = (isRecord(region) ? asNumber(region["startLine"]) : undefined) ?? 0;
  if (path === "" || line === 0) return null; // not citable in the diff

  const message = isRecord(result["message"]) ? asString(result["message"]["text"]) : undefined;
  const declared = result["level"] ?? ruleLevel.get(ruleId);
  const severity = asSeverity(declared, TOOL_DEFAULT_SEVERITY[tool]);

  const finding: MechanicalFinding = {
    tool,
    ruleId,
    path,
    line,
    severity,
    message: message ?? ruleId,
  };
  const endLine = isRecord(region) ? asNumber(region["endLine"]) : undefined;
  if (endLine !== undefined) finding.endLine = endLine;
  return finding;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function asSeverity(level: unknown, fallback: MechanicalSeverity): MechanicalSeverity {
  return level === "error" || level === "warning" || level === "note" ? level : fallback;
}
