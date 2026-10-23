// goldenBodies.ts — the three golden verdict comments, rendered by the REAL
// formatVerdict from real inputs: PR #138's live sticky (approved), the finding text
// scripts/__tests__/parse-verdict.bats captured over a real prior round (changes),
// and a provider failure (error). verdict-layout.test.ts pins each body to a fixture
// file that the bats suite, pr-babysit's parser and GitHub's renderer are checked on.
import { formatVerdict } from "@/review/verdict.js";
import { buildLedger, coverageCounts, renderLedger } from "@/review/ledger.js";
import type { CoverageEntry } from "@/review/ledger.js";
import { renderHistorySection, renderRecapSection } from "@/review/recap.js";
import { attachFps, diffState, encodeMarker, type ReviewState } from "@/state.js";
import type { Finding } from "@/llm/schema.js";
import type { MechanicalFinding } from "@/mechanical/sarif.js";

/** One golden comment: its body, the marker it must end with, its findings. */
export interface GoldenBody {
  body: string;
  marker: string;
  findings: Finding[];
}

const reviewedEntry = (p: string): [string, CoverageEntry] => [p, { status: "reviewed" }];

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

/** PR #138's live sticky: approved, first pass, 7 reviewed + the bundle filtered. */
export function approvedBody(): GoldenBody {
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
  const ledger = buildLedger([
    ...[
      "code-review/README.md",
      "code-review/action.yml",
      "code-review/prompts/review-checklist.txt",
      "code-review/src/__tests__/prompt.test.ts",
      "code-review/src/prompt.ts",
      "code-review/src/prompt/blocks.ts",
      "code-review/src/review/cartographer.ts",
    ].map(reviewedEntry),
    ["code-review/run/index.cjs", { status: "excluded", reason: "build-output" }],
  ]);
  const marker = encodeMarker(state);
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
      historyMarker: marker,
    },
  );
  return { body, marker, findings: [] };
}

/** A second pass requesting changes: 1 resolved, 1 still open, 2 new; 3 carried. */
export function changesBody(): GoldenBody {
  const PRIOR_SHA = "d2033cc4a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const HEAD_SHA = "5a5e23f6b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d";
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
  // The blocker and the medium are the parse-verdict.bats suite's captured findings.
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
    head_sha: HEAD_SHA,
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
    ].map(reviewedEntry),
    ["bun.lock", { status: "excluded", reason: "lockfile" }],
    ...[
      "packages/api/src/providers/select.ts",
      "packages/api/src/__tests__/self-hosted-poll.test.ts",
      "packages/api/src/__tests__/self-hosted-revoke.test.ts",
    ].map((p): [string, CoverageEntry] => [p, { status: "carried" }]),
  ]);
  const marker = encodeMarker(state.next_state);
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
      headSha: HEAD_SHA,
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
      historyMarker: marker,
    },
  );
  return { body, marker, findings };
}

/** The model never answered: every file unreviewed, two gitleaks hits. */
export function providerErrorBody(): GoldenBody {
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
  const marker = encodeMarker({
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
      historyMarker: marker,
    },
  );
  return { body, marker, findings: [] };
}
