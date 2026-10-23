// verdict-layout.test.ts — the golden verdict comments (built in goldenBodies.ts
// from real inputs) asserted block by block, then pinned byte-for-byte to the fixture
// files scripts/__tests__/parse-verdict.bats, pr-babysit's parser and GitHub's
// renderer are checked against — so the layout and every parser contract are proven
// on the same bytes.
import { describe, it, expect } from "vitest";
import { buildFindingsSection } from "@/review/findings.js";
import { approvedBody, changesBody, providerErrorBody } from "./goldenBodies.js";

const FIXTURES = "./fixtures/verdict-body";
const LOGO =
  "https://raw.githubusercontent.com/falconiere/toolu-ghactions/main/code-review/assets/logo.png";

/** The body's lines with the trailing newline dropped. */
const linesOf = (body: string) => body.replace(/\n+$/, "").split("\n");

/** Index of the first line equal to (or, for a RegExp, matching) `needle`. */
function at(lines: string[], needle: string | RegExp): number {
  return lines.findIndex((l) => (typeof needle === "string" ? l === needle : needle.test(l)));
}

/** True when every index exists and they ascend. */
function ascending(order: number[]): boolean {
  return order.every((i) => i >= 0) && order.every((i, k) => k === 0 || i > (order[k - 1] ?? -1));
}

describe("golden: approved (PR #138's live sticky data)", () => {
  const { body, marker } = approvedBody();

  it("AC-1: header, heading, checklist, pill, three tiles, findings, details, label, marker", () => {
    const lines = linesOf(body);
    const order = [
      at(
        lines,
        `<img src="${LOGO}" width="20" align="left"> **Toolu — Code Review** <sub>finished in 12s · \`5564be9\` · [View job](https://github.com/Falconiere/toolu-ghactions/actions/runs/40005223494)</sub>`,
      ),
      at(lines, "### Code Review — `code-review/out-of-box-defaults-prompts`"),
      at(lines, "- [x] Reviewed 8-file diff — verdict set"),
      at(lines, "**Verdict:** <kbd>✅ Approved</kbd>"),
      at(lines, '<td width="33%"><sub>FINDINGS</sub><h3>0</h3><sub>on this pass</sub></td>'),
      at(lines, '<td width="33%"><sub>RESOLVED</sub><h3>0</h3><sub>first pass</sub></td>'),
      at(
        lines,
        '<td width="33%"><sub>REVIEWED</sub><h3>7 <sub>FILES</sub></h3><sub>1 filtered</sub></td>',
      ),
      at(lines, "### Findings (0)"),
      at(lines, "### Review details"),
      at(lines, "**Coverage** · reviewed: 7 · excluded: 1"),
      at(lines, "<details><summary><b>Review plan</b></summary>"),
      at(lines, "<details><summary><b>Jev second opinion</b> · 1 assessed</summary>"),
      at(lines, "<details><summary><b>Review history</b> · 1 pass</summary>"),
      at(lines, "`merge-approved`"),
    ];
    expect(ascending(order)).toBe(true);
    expect(order[0]).toBe(0);
    expect(lines.at(-1)).toBe(marker);
    expect(body).not.toContain("### Top-N must-fix");
  });

  it("matches the golden fixture", async () => {
    await expect(body).toMatchFileSnapshot(`${FIXTURES}/approved.md`);
  });
});

describe("golden: changes (bats-captured findings, a real prior round)", () => {
  const { body, marker, findings } = changesBody();

  it("AC-2: pill with severities, four tiles ending in CARRIED, since row, Top-N right above Findings", () => {
    const lines = linesOf(body);
    expect(lines).toContain(
      "**Verdict:** <kbd>⚠️ Changes requested</kbd> 🔴 1 blocker 🟠 1 high 🟡 1 medium",
    );
    const tiles = lines.filter((l) => l.startsWith('<td width="25%">'));
    expect(tiles).toHaveLength(4);
    expect(tiles[3]).toBe(
      '<td width="25%"><sub>CARRIED</sub><h3>3 <sub>FILES</sub></h3><sub>from earlier passes</sub></td>',
    );
    expect(lines).toContain(
      "**Since `d2033cc`** &nbsp;✅ **1** resolved · 🔁 **1** still open · ⚠️ **2** new",
    );
    const top = at(lines, "### Top-N must-fix");
    const findingsAt = at(lines, "### Findings (3)");
    expect(top).toBeGreaterThan(at(lines, /^\*\*Since /));
    expect(lines.slice(top + 1, findingsAt)).toEqual([
      "- `apps/api/src/auth.ts:75` — The allowlist pattern `:name` matches exactly one non-empty segment.",
      "- `apps/api/src/session.ts:12` — Session tokens are compared with === instead of a constant-time comparison.",
      "- `apps/console/src/hooks/use-delete-repos.ts:58` — The deleteInTurn function uses recursion instead of a loop.",
      "",
    ]);
    // The findings section is byte-identical to the contract builder's output, and
    // `### Review details` is the next `### ` line after it.
    expect(body).toContain(
      `### Findings (3)\n\n${buildFindingsSection(findings)}\n\n### Review details\n\n`,
    );
    expect(lines.at(-1)).toBe(marker);
    expect(lines.at(-3)).toBe("`request-changes`");
  });

  it("matches the golden fixture", async () => {
    await expect(body).toMatchFileSnapshot(`${FIXTURES}/changes.md`);
  });
});

describe("golden: provider error (the model never answered)", () => {
  const { body, marker } = providerErrorBody();

  it("AC-4: provider-error pill, CAUTION alert under it, LLM-unavailable WARNING with the scanner line", () => {
    const lines = linesOf(body);
    const verdict = at(lines, "**Verdict:** <kbd>🚫 Review incomplete — provider error</kbd>");
    expect(verdict).toBe(6);
    expect(lines.slice(verdict + 2, verdict + 4)).toEqual([
      "> [!CAUTION]",
      "> **Provider error:** OpenRouter request failed after 3 attempts: 502 Bad Gateway",
    ]);
    expect(body).toContain(
      "**Mechanical checks** · 2 deterministic finding(s) — 2 gitleaks. See the **Code Scanning** tab for details.\n\n" +
        "> [!WARNING]\n> **LLM judgment unavailable:** showing deterministic findings only.",
    );
    expect(lines).toContain(
      '<td width="33%"><sub>REVIEWED</sub><h3>0 <sub>FILES</sub></h3><sub>⚠️ 4 not reviewed</sub></td>',
    );
    expect(lines.at(-1)).toBe(marker);
  });

  it("matches the golden fixture", async () => {
    await expect(body).toMatchFileSnapshot(`${FIXTURES}/provider-error.md`);
  });
});
