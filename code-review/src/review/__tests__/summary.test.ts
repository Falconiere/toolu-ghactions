import { describe, it, expect } from "vitest";
import type { Finding } from "@/llm/schema.js";
import type { MechanicalFinding } from "@/mechanical/sarif.js";
import type { CoverageStatus } from "@/review/ledger.js";
import type { EnhancementSummary } from "@/jev/enhance.js";
import {
  alert,
  buildJevSection,
  buildTiles,
  details,
  headerMeta,
  verdictLine,
} from "@/review/summary.js";

/** PR #138's live coverage: 8 changed files, 7 reviewed, 1 excluded. */
function counts(overrides: Partial<Record<CoverageStatus, number>> = {}) {
  return {
    reviewed: 7,
    pattern: 0,
    rename: 0,
    formatting: 0,
    vendored: 0,
    generated: 0,
    excluded: 1,
    carried: 0,
    unreviewed: 0,
    pending: 0,
    ...overrides,
  };
}

const finding = (severity: Finding["severity"], path: string, line: number): Finding => ({
  path,
  line,
  severity,
  category: "correctness",
  confidence: "high",
  text: `A ${severity} defect.`,
});

function mechanical(tool: "gitleaks" | "opengrep", n: number): MechanicalFinding[] {
  return Array.from({ length: n }, (_, i) => ({
    tool,
    ruleId: tool === "gitleaks" ? "generic-api-key" : "typescript.react.security.audit",
    path: `packages/api/src/__tests__/fixture-${i}.ts`,
    line: i + 1,
    severity: "warning" as const,
    message: "flagged",
  }));
}

/** The <td> cells of a tiles table, as their inner HTML. */
function cells(table: string): string[] {
  return [...table.matchAll(/<td width="(\d+)%">(.*?)<\/td>/g)].map((m) => `${m[1]}%|${m[2]}`);
}

describe("verdictLine", () => {
  it("wraps the badge in <kbd> after the parseable **Verdict:** prefix", () => {
    expect(verdictLine("✅ Approved")).toBe("**Verdict:** <kbd>✅ Approved</kbd>");
  });
  it("appends the severity summary after one space", () => {
    expect(verdictLine("⚠️ Changes requested", "🔴 1 blocker 🟠 1 high")).toBe(
      "**Verdict:** <kbd>⚠️ Changes requested</kbd> 🔴 1 blocker 🟠 1 high",
    );
  });
});

describe("headerMeta", () => {
  const url = "https://github.com/Falconiere/toolu-ghactions/actions/runs/40005223494";
  it("names duration, the short head sha and the job link", () => {
    expect(
      headerMeta({ duration: "12s", sha: "5564be9c0ffee1234567890abcdef0123456789a", jobUrl: url }),
    ).toBe(`<sub>finished in 12s · \`5564be9\` · [View job](${url})</sub>`);
  });
  it("drops the segments it has no value for", () => {
    expect(headerMeta({ jobUrl: url })).toBe(`<sub>[View job](${url})</sub>`);
  });
});

describe("alert", () => {
  it("quotes every line so a multi-line detail stays one GitHub alert", () => {
    expect(alert("WARNING", "Partial review", "chunk 2 failed\n[finish_reason: length]")).toBe(
      "> [!WARNING]\n> **Partial review:** chunk 2 failed\n> [finish_reason: length]",
    );
  });
});

describe("details", () => {
  it("wraps markdown in a collapsed block with blank lines around the body", () => {
    expect(details("<b>Review plan</b>", "Check prompt.ts.")).toBe(
      "<details><summary><b>Review plan</b></summary>\n\nCheck prompt.ts.\n\n</details>",
    );
  });
  it("neutralizes a closing tag in the body so the block cannot end early", () => {
    const out = details("<b>Review plan</b>", "Quote: </details> and </DETAILS >");
    expect(out.match(/<\/details>/gi)).toHaveLength(1);
    expect(out).toContain("Quote: &lt;/details&gt; and &lt;/details&gt;");
  });
});

describe("buildTiles", () => {
  it("renders PR #138 as three tiles: no findings, a first pass, 1 filtered", () => {
    const out = buildTiles({
      findings: [],
      coverage: counts(),
      changedFiles: 8,
      memory: { passes: 1, resolved: 0 },
      mechanical: [],
    });
    expect(cells(out)).toEqual([
      "33%|<sub>FINDINGS</sub><h3>0</h3><sub>on this pass</sub>",
      "33%|<sub>RESOLVED</sub><h3>0</h3><sub>first pass</sub>",
      "33%|<sub>REVIEWED</sub><h3>7 <sub>FILES</sub></h3><sub>1 filtered</sub>",
    ]);
    expect(out.startsWith("<table>\n<tr>\n")).toBe(true);
    expect(out.endsWith("\n</tr>\n</table>")).toBe(true);
  });

  it("captions findings by severity and puts CARRIED fourth when paths were carried", () => {
    const out = buildTiles({
      findings: [
        finding("blocker", "apps/api/src/auth.ts", 75),
        finding("high", "apps/api/src/session.ts", 12),
        finding("medium", "apps/console/src/hooks/use-delete-repos.ts", 58),
      ],
      coverage: counts({ reviewed: 31, excluded: 2, carried: 3 }),
      changedFiles: 36,
      memory: { passes: 2, resolved: 4 },
      mechanical: [...mechanical("gitleaks", 7), ...mechanical("opengrep", 15)],
    });
    expect(cells(out)).toEqual([
      "25%|<sub>FINDINGS</sub><h3>3</h3><sub>1 blocker · 1 high · 1 medium</sub>",
      "25%|<sub>RESOLVED</sub><h3>4</h3><sub>across 2 passes</sub>",
      "25%|<sub>REVIEWED</sub><h3>31 <sub>FILES</sub></h3><sub>2 filtered</sub>",
      "25%|<sub>CARRIED</sub><h3>3 <sub>FILES</sub></h3><sub>from earlier passes</sub>",
    ]);
  });

  it("shows SCANNERS with per-tool counts when nothing was carried", () => {
    const out = buildTiles({
      findings: [],
      coverage: counts({ reviewed: 32, excluded: 2 }),
      changedFiles: 34,
      memory: { passes: 3, resolved: 8 },
      mechanical: [...mechanical("gitleaks", 7), ...mechanical("opengrep", 15)],
    });
    expect(cells(out).at(-1)).toBe(
      "25%|<sub>SCANNERS</sub><h3>22</h3><sub>7 gitleaks · 15 opengrep</sub>",
    );
  });

  it("drops RESOLVED without review memory and falls back to the diff size without a ledger", () => {
    const out = buildTiles({ findings: [], changedFiles: 4, mechanical: [] });
    expect(cells(out)).toEqual([
      "50%|<sub>FINDINGS</sub><h3>0</h3><sub>on this pass</sub>",
      "50%|<sub>REVIEWED</sub><h3>4 <sub>FILES</sub></h3><sub>files in diff</sub>",
    ]);
  });

  it("warns on unreviewed and pending paths before any filtered count", () => {
    const out = buildTiles({
      findings: [],
      coverage: counts({ reviewed: 5, unreviewed: 1, pending: 1 }),
      changedFiles: 8,
      mechanical: [],
    });
    expect(cells(out)[1]).toBe(
      "50%|<sub>REVIEWED</sub><h3>5 <sub>FILES</sub></h3><sub>⚠️ 2 not reviewed</sub>",
    );
  });

  it("says nothing was filtered, and handles an empty ledger", () => {
    const clean = buildTiles({
      findings: [],
      coverage: counts({ reviewed: 3, excluded: 0 }),
      changedFiles: 3,
      mechanical: [],
    });
    expect(cells(clean)[1]).toContain("<sub>nothing filtered</sub>");
    const empty = buildTiles({
      findings: [],
      coverage: counts({ reviewed: 0, excluded: 0 }),
      changedFiles: 0,
      mechanical: [],
    });
    expect(cells(empty)[1]).toBe(
      "50%|<sub>REVIEWED</sub><h3>0 <sub>FILES</sub></h3><sub>no changed files</sub>",
    );
  });
});

describe("buildJevSection", () => {
  const summary: EnhancementSummary = {
    assessed: 1,
    rechecked: 0,
    dismissed: 0,
    additionalReviews: 0,
    unavailable: 0,
    skipped: 0,
    calls: 1,
    elapsedMs: 2400,
    assessments: [],
  };
  it("summarizes the pass and lists every counter in the body (PR #138)", () => {
    expect(buildJevSection(summary)).toBe(
      "<details><summary><b>Jev second opinion</b> · 1 assessed</summary>\n\n" +
        "**1** assessments · **0** findings rechecked · **0** confirmed dismissals · " +
        "**0** additional package reviews · **0** unavailable · **0** skipped\n\n</details>",
    );
  });
  it("surfaces unavailable answers and a wholesale skip in the summary", () => {
    const out = buildJevSection({
      ...summary,
      assessed: 0,
      unavailable: 3,
      skipped: 16,
      skipReason: "deadline",
    });
    expect(out).toContain(
      "<summary><b>Jev second opinion</b> · 0 assessed · 3 unavailable · skipped</summary>",
    );
    expect(out).toContain("**16** skipped (wall deadline reached)");
  });
});
