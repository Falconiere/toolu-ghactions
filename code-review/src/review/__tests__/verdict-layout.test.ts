// verdict-layout.test.ts — the golden verdict comments. Each body is rendered by the
// REAL formatVerdict from real inputs (PR #138's live sticky; the finding text the
// parse-verdict.bats suite captured; a provider failure) and pinned to a fixture
// file. The same fixture files are what scripts/__tests__/parse-verdict.bats, the
// pr-babysit parser and GitHub's renderer are checked against, so the layout and
// every parser contract are proven on the same bytes.
import { describe, it, expect } from "vitest";
import { formatVerdict } from "@/review/verdict.js";
import { buildFindingsSection } from "@/review/findings.js";
import { buildLedger, coverageCounts, renderLedger } from "@/review/ledger.js";
import type { CoverageEntry } from "@/review/ledger.js";
import { renderHistorySection, renderRecapSection } from "@/review/recap.js";
import { attachFps, diffState, encodeMarker, type ReviewState } from "@/state.js";
import type { Finding } from "@/llm/schema.js";
import type { MechanicalFinding } from "@/mechanical/sarif.js";

const FIXTURES = "./fixtures/verdict-body";
const LOGO =
  "https://raw.githubusercontent.com/falconiere/toolu-ghactions/main/code-review/assets/logo.png";

/** The body's lines with the trailing newline dropped. */
const linesOf = (body: string) => body.replace(/\n+$/, "").split("\n");

/** Index of the first line equal to (or, for a RegExp, matching) `needle`. */
function at(lines: string[], needle: string | RegExp): number {
  return lines.findIndex((l) => (typeof needle === "string" ? l === needle : needle.test(l)));
}

function gitleaks(n: number): MechanicalFinding[] {
  return Array.from({ length: n }, (_, i) => ({
    tool: "gitleaks",
    ruleId: "generic-api-key",
    path: `packages/api/src/__tests__/fixtures/keys-${i}.json`,
    line: 3,
    severity: "error",
    message: "Detected a Generic API Key, potentially exposing access to various services.",
  }));
}

function opengrep(n: number): MechanicalFinding[] {
  return Array.from({ length: n }, (_, i) => ({
    tool: "opengrep",
    ruleId: "typescript.lang.security.audit.unsafe-formatstring",
    path: `apps/console/src/lib/log-${i}.ts`,
    line: 10 + i,
    severity: "warning",
    message: "String passed to a format function is built from a non-literal.",
  }));
}

describe("golden: approved (PR #138's live sticky data)", () => {
  // Decoded from the live marker on Falconiere/toolu-ghactions#138.
  const state: ReviewState = {
    schema: "toolu-review-state",
    version: 1,
    findings: [],
    history: [
      {
        sha: "5564be9",
        ts: 1792780862,
        verdict: "approved",
        counts: { new: 0, open: 0, resolved: 0, total: 0 },
      },
    ],
    reviewed_sha: "5564be975cad6a63a1ed1ac85b2a94ad0bfe5b52",
    reviewed_tree: "bc4f201776db0c8fe691e722bb335ce3d94ccd5d",
  };
  // The PR's 8 changed files: the bundle is the one the noise filter dropped.
  const reviewed = [
    "code-review/README.md",
    "code-review/action.yml",
    "code-review/prompts/review-checklist.txt",
    "code-review/src/__tests__/prompt.test.ts",
    "code-review/src/prompt.ts",
    "code-review/src/prompt/blocks.ts",
    "code-review/src/review/cartographer.ts",
  ];
  const ledger = buildLedger([
    ...reviewed.map((p): [string, CoverageEntry] => [p, { status: "reviewed" }]),
    ["code-review/run/index.cjs", { status: "excluded", reason: "build-output" }],
  ]);
  const MARKER = encodeMarker(state);
  const { body } = formatVerdict(
    {
      verdict: "approved",
      findings: [],
      review_plan:
        "Check the diff for correctness, security, performance, test coverage, doc accuracy, and convention violations. Focus on the new caps in prompt.ts, blocks.ts, cartographer.ts, and the checklist/action.yml wording changes.",
      other_checks: "",
      enhancement: {
        assessed: 1,
        rechecked: 0,
        dismissed: 0,
        additionalReviews: 0,
        unavailable: 0,
        skipped: 0,
        calls: 1,
        elapsedMs: 2100,
        assessments: [],
      },
    },
    {
      branch: "code-review/out-of-box-defaults-prompts",
      jobUrl: "https://github.com/Falconiere/toolu-ghactions/actions/runs/40005223494",
      duration: "12s",
      headSha: state.reviewed_sha,
      changedFiles: 8,
      coverage: coverageCounts(ledger),
      memory: { passes: 1, resolved: 0 },
      ledger: renderLedger(ledger, "compact"),
      history: renderHistorySection(state.history),
      historyMarker: MARKER,
    },
  );

  it("AC-1: header, heading, pill, three tiles, findings, coverage, details, checklist, label, marker", () => {
    const lines = linesOf(body);
    const order = [
      at(
        lines,
        `<img src="${LOGO}" width="20" align="left"> **Toolu — Code Review** <sub>finished in 12s · \`5564be9\` · [View job](https://github.com/Falconiere/toolu-ghactions/actions/runs/40005223494)</sub>`,
      ),
      at(lines, "### Code Review — `code-review/out-of-box-defaults-prompts`"),
      at(lines, "**Verdict:** <kbd>✅ Approved</kbd>"),
      at(lines, '<td width="33%"><sub>FINDINGS</sub><h3>0</h3><sub>on this pass</sub></td>'),
      at(lines, '<td width="33%"><sub>RESOLVED</sub><h3>0</h3><sub>first pass</sub></td>'),
      at(
        lines,
        '<td width="33%"><sub>REVIEWED</sub><h3>7 <sub>FILES</sub></h3><sub>1 filtered</sub></td>',
      ),
      at(lines, "### Findings (0)"),
      at(lines, "**Coverage** · reviewed: 7 · excluded: 1"),
      at(lines, "<details><summary><b>Review plan</b></summary>"),
      at(lines, "<details><summary><b>Jev second opinion</b> · 1 assessed</summary>"),
      at(lines, "<details><summary><b>Review history</b> · 1 pass</summary>"),
      at(lines, "- [x] Reviewed 8-file diff — verdict set"),
      at(lines, "`merge-approved`"),
    ];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(order[0]).toBe(0);
    expect(lines.at(-1)).toBe(MARKER);
    expect(body).not.toContain("### Top-N must-fix");
  });

  it("matches the golden fixture", async () => {
    await expect(body).toMatchFileSnapshot(`${FIXTURES}/approved.md`);
  });
});

describe("golden: changes (bats-captured findings, a real prior round)", () => {
  const PRIOR_SHA = "d2033cc4a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const prior: ReviewState = {
    schema: "toolu-review-state",
    version: 1,
    findings: attachFps([
      {
        path: "apps/console/src/hooks/use-delete-repos.ts",
        line: 58,
        severity: "medium",
        category: "correctness",
        text: "The deleteInTurn function uses recursion instead of a loop.",
      },
      {
        path: "packages/api/src/providers/vps/resolve.ts",
        line: 14,
        severity: "high",
        category: "correctness",
        text: "resolveProvider returns undefined for an unknown region instead of throwing.",
      },
    ]),
    history: [
      {
        sha: "d2033cc",
        ts: 1792700000,
        verdict: "changes",
        counts: { new: 2, open: 0, resolved: 0, total: 2 },
      },
    ],
    reviewed_sha: PRIOR_SHA,
  };
  const findings: Finding[] = [
    {
      path: "apps/api/src/auth.ts",
      line: 75,
      severity: "blocker",
      category: "security",
      confidence: "high",
      text: "The allowlist pattern `:name` matches exactly one non-empty segment.",
    },
    {
      path: "apps/api/src/session.ts",
      line: 12,
      severity: "high",
      category: "security",
      confidence: "high",
      text: "Session tokens are compared with === instead of a constant-time comparison.",
    },
    {
      path: "apps/console/src/hooks/use-delete-repos.ts",
      line: 58,
      severity: "medium",
      category: "correctness",
      confidence: "high",
      text: "The deleteInTurn function uses recursion instead of a loop.",
    },
  ];
  const state = diffState({
    prior,
    current_findings: findings,
    scope: {
      in_scope_paths: [...findings.map((f) => f.path), "packages/api/src/providers/vps/resolve.ts"],
      full_review: true,
    },
    head_sha: "5a5e23f6b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d",
    verdict: "changes",
    complete: true,
    now: () => 1792782000000,
  });
  const history = state.next_state.history;
  const ledger = buildLedger([
    ...[
      "apps/api/src/auth.ts",
      "apps/api/src/session.ts",
      "apps/console/src/hooks/use-delete-repos.ts",
      "apps/api/src/routes.ts",
      "packages/api/src/providers/vps/resolve.ts",
    ].map((p): [string, CoverageEntry] => [p, { status: "reviewed" }]),
    ["bun.lock", { status: "excluded", reason: "lockfile" }],
    ...[
      "packages/api/src/providers/select.ts",
      "packages/api/src/__tests__/self-hosted-poll.test.ts",
      "packages/api/src/__tests__/self-hosted-revoke.test.ts",
    ].map((p): [string, CoverageEntry] => [p, { status: "carried" }]),
  ]);
  const MARKER = encodeMarker(state.next_state);
  const { body } = formatVerdict(
    {
      verdict: "changes",
      findings,
      review_plan:
        "Review the auth allowlist, the session check and the repo-deletion hook for correctness, security and test coverage per the console AGENTS.md rules.",
      other_checks: "Tests look adequate.",
    },
    {
      branch: "feat/82-model-customer-owned-machines-as",
      jobUrl: "https://github.com/acme/console/actions/runs/40012345678",
      duration: "3m 19s",
      headSha: "5a5e23f6b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d",
      changedFiles: 6,
      coverage: coverageCounts(ledger),
      memory: {
        passes: history.length,
        resolved: history.reduce((sum, e) => sum + e.counts.resolved, 0),
      },
      recap: renderRecapSection(state, {
        history: [],
        fullReview: true,
        compact: true,
        sinceSha: PRIOR_SHA,
      }),
      history: renderHistorySection(history),
      ledger: renderLedger(ledger, "compact"),
      mechanical: [...gitleaks(7), ...opengrep(15)],
      historyMarker: MARKER,
    },
  );

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
    // The findings section is byte-identical to the contract builder's output.
    expect(body).toContain(`### Findings (3)\n\n${buildFindingsSection(findings)}\n\n`);
    expect(lines.at(-1)).toBe(MARKER);
    expect(lines.at(-3)).toBe("`request-changes`");
  });

  it("matches the golden fixture", async () => {
    await expect(body).toMatchFileSnapshot(`${FIXTURES}/changes.md`);
  });
});

describe("golden: provider error (the model never answered)", () => {
  const unreviewed = [
    "apps/api/src/session.ts",
    "apps/api/src/session-store.ts",
    "apps/api/src/__tests__/session.test.ts",
    "docs/sessions.md",
  ];
  const ledger = buildLedger(
    unreviewed.map((p): [string, CoverageEntry] => [
      p,
      { status: "unreviewed", reason: "provider-error" },
    ]),
  );
  const MARKER = encodeMarker({
    schema: "toolu-review-state",
    version: 1,
    findings: [],
    history: [],
    unreviewed_paths: unreviewed,
  });
  const { body } = formatVerdict(
    {
      verdict: "error",
      findings: [],
      error: "OpenRouter request failed after 3 attempts: 502 Bad Gateway",
    },
    {
      branch: "fix/session-timeout",
      jobUrl: "https://github.com/acme/console/actions/runs/40019876543",
      duration: "41s",
      headSha: "9c1e0b7d2f3a4b5c6d7e8f9012a3b4c5d6e7f801",
      changedFiles: 4,
      coverage: coverageCounts(ledger),
      ledger: renderLedger(ledger, "compact"),
      mechanical: gitleaks(2),
      historyMarker: MARKER,
    },
  );

  it("AC-4: provider-error pill, CAUTION alert under it, LLM-unavailable WARNING with the scanner line", () => {
    const lines = linesOf(body);
    const verdict = at(lines, "**Verdict:** <kbd>🚫 Review incomplete — provider error</kbd>");
    expect(verdict).toBe(4);
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
    expect(lines.at(-1)).toBe(MARKER);
  });

  it("matches the golden fixture", async () => {
    await expect(body).toMatchFileSnapshot(`${FIXTURES}/provider-error.md`);
  });
});
