// findings.test.ts — the `### Findings` layout (review/findings.ts) and its
// machine-readable contract. The layout tests assert the SHAPE a reader sees
// (severity groups, one paragraph per finding); the round-trip test feeds a real
// rendered body to the real scripts/parse-verdict.sh, which is what the babysit
// loop runs — so a layout change that the parser cannot read fails here.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Finding } from "@/llm/schema.js";
import { buildFindingsSection, buildTruncatedFindingsSection } from "@/review/findings.js";

const finding = (
  over: Partial<Finding> & Pick<Finding, "path" | "severity" | "text">,
): Finding => ({
  line: 10,
  ...over,
});

/**
 * A finding that reached the renderer WITHOUT a line. The schema marks `line`
 * required, but repaired model JSON and carried-forward state can still arrive
 * without one, and both renderers guard for it — so the guard gets a test.
 * `Reflect.deleteProperty` (not `delete`) because the property is non-optional.
 */
function withoutLine(f: Finding): Finding {
  const copy: Finding = { ...f };
  Reflect.deleteProperty(copy, "line");
  return copy;
}

const MIXED: Finding[] = [
  finding({ path: "src/nit.ts", line: 3, severity: "nit", text: "spacing", category: "style" }),
  finding({
    path: "src/auth.ts",
    line: 75,
    severity: "blocker",
    text: "auth bypass",
    category: "security",
    confidence: "high",
  }),
  finding({ path: "src/a.ts", line: 12, severity: "high", text: "off-by-one" }),
  finding({ path: "src/b.ts", line: 8, severity: "high", text: "unchecked cast" }),
];

describe("buildFindingsSection", () => {
  it("groups findings under one sub-heading per severity, worst-first, with counts", () => {
    const section = buildFindingsSection(MIXED);
    const headings = [...section.matchAll(/^#### (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual(["🔴 Blocker · 1", "🟠 High · 2", "⚪ Nit · 1"]);
  });

  it("numbers findings continuously across groups, in worst-first order", () => {
    const section = buildFindingsSection(MIXED);
    const blocks = [...section.matchAll(/^\*\*(\d+)\.\*\* `([^`]+)`/gm)].map((m) => [m[1], m[2]]);
    expect(blocks).toEqual([
      ["1", "src/auth.ts"],
      ["2", "src/a.ts"],
      ["3", "src/b.ts"],
      ["4", "src/nit.ts"],
    ]);
  });

  it("puts every finding in its own paragraph — text never shares a line with the next header", () => {
    const section = buildFindingsSection(MIXED);
    // The block that precedes a header is always ended by a blank line, which is
    // what stops GitHub from running consecutive findings together as one run of
    // text (the bug this layout replaced).
    const lines = section.split("\n");
    for (const [i, line] of lines.entries()) {
      if (i === 0) continue;
      if (/^(####|\*\*\d+\.\*\*) /.test(line)) expect(lines[i - 1]).toBe("");
    }
    expect(section).toContain(
      "**1.** `src/auth.ts` **L75**\n<sub>security · high confidence</sub>\n\nauth bypass",
    );
  });

  it("renders the meta line only from the fields the finding actually carries", () => {
    const [sparse] = buildFindingsSection([
      finding({ path: "src/a.ts", line: 12, severity: "high", text: "off-by-one" }),
    ]).split("\n\n");
    expect(sparse).toBe("#### 🟠 High · 1");
    const section = buildFindingsSection([
      finding({ path: "src/a.ts", line: 12, severity: "high", text: "off-by-one" }),
    ]);
    expect(section).toContain("**1.** `src/a.ts` **L12**\n\noff-by-one");
    expect(section).not.toContain("<sub>");
  });

  it("tags a deterministic tool's provenance in the meta line", () => {
    const section = buildFindingsSection([
      finding({
        path: "src/a.ts",
        line: 5,
        severity: "high",
        text: "leaked token",
        source: "gitleaks",
        category: "security",
      }),
    ]);
    expect(section).toContain("<sub>**[gitleaks]** · security</sub>");
  });

  it("omits the line anchor for a finding that carries none", () => {
    const section = buildFindingsSection([
      withoutLine(finding({ path: "docs/readme.md", severity: "low", text: "stale link" })),
    ]);
    expect(section).toContain("**1.** `docs/readme.md`\n\nstale link");
  });

  it("does not mutate the caller's array (the pipeline reuses it downstream)", () => {
    const snapshot = [...MIXED];
    buildFindingsSection(MIXED);
    expect(MIXED).toEqual(snapshot);
  });

  it("says so when there is nothing to report", () => {
    expect(buildFindingsSection([])).toBe("_No findings._");
  });
});

describe("buildTruncatedFindingsSection", () => {
  const jobUrl = "https://ci.example/job/1";

  it("keeps the worst `keep` findings and states how many were dropped", () => {
    const section = buildTruncatedFindingsSection(MIXED, 2, jobUrl);
    expect(section).toContain("`src/auth.ts`");
    expect(section).toContain("`src/a.ts`");
    expect(section).not.toContain("`src/nit.ts`");
    expect(section).toContain(`_… 2 more findings — see the [job log](${jobUrl})_`);
  });

  it("degrades to the note alone when nothing fits, with no stray blank lines", () => {
    const section = buildTruncatedFindingsSection(MIXED, 0, jobUrl);
    expect(section).toBe(`_… 4 more findings — see the [job log](${jobUrl})_`);
  });

  it("drops the note when every finding survived", () => {
    const section = buildTruncatedFindingsSection(MIXED, MIXED.length, jobUrl);
    expect(section).not.toContain("more findings");
  });
});

// The babysit loop reads the sticky comment with this script; it is the ONLY
// consumer that parses the rendered layout back into data.
const PARSE_VERDICT = resolve(import.meta.dirname, "../../../../scripts/parse-verdict.sh");
const hasJq = (() => {
  try {
    execFileSync("jq", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasJq)("scripts/parse-verdict.sh round-trip", () => {
  /** A comment body shaped like the real one: the parse contract's heading, a
   *  checked box, the rendered findings section, then a later `### ` section. */
  const comment = (findingsSection: string): string =>
    [
      "### Code Review — `feature-branch`",
      "",
      "- [x] Reviewed 4-file diff — verdict set",
      "",
      `### Findings (${MIXED.length})`,
      "",
      findingsSection,
      "",
      "### Other checks",
      "",
      "Tests look adequate.",
      "",
      "`agent-request-changes`",
    ].join("\n");

  const parse = (
    body: string,
  ): { findings: { path: string; line: number | null; severity: string; text: string }[] } =>
    JSON.parse(execFileSync("bash", [PARSE_VERDICT], { input: body, encoding: "utf8" }));

  it("exists where the test points", () => {
    expect(existsSync(PARSE_VERDICT)).toBe(true);
  });

  it("recovers every finding — path, line, severity and text — from the rendered layout", () => {
    const { findings } = parse(comment(buildFindingsSection(MIXED)));
    expect(findings).toEqual([
      {
        path: "src/auth.ts",
        line: 75,
        severity: "blocker",
        text: "auth bypass",
        key: expect.any(String),
      },
      { path: "src/a.ts", line: 12, severity: "high", text: "off-by-one", key: expect.any(String) },
      {
        path: "src/b.ts",
        line: 8,
        severity: "high",
        text: "unchecked cast",
        key: expect.any(String),
      },
      { path: "src/nit.ts", line: 3, severity: "nit", text: "spacing", key: expect.any(String) },
    ]);
  });

  it("recovers a finding with no line anchor as line: null", () => {
    const section = buildFindingsSection([
      withoutLine(finding({ path: "docs/readme.md", severity: "low", text: "stale link" })),
    ]);
    const { findings } = parse(comment(section));
    expect(findings).toEqual([
      {
        path: "docs/readme.md",
        line: null,
        severity: "low",
        text: "stale link",
        key: expect.any(String),
      },
    ]);
  });

  it("ignores the truncation note instead of reading it as a finding", () => {
    const section = buildTruncatedFindingsSection(MIXED, 1, "https://ci.example/job/1");
    const { findings } = parse(comment(section));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.path).toBe("src/auth.ts");
  });
});
