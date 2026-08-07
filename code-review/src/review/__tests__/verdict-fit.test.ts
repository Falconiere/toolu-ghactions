// verdict-fit.test.ts — fitToSizeLimit's shrink ladder walked at the real
// BODY_SIZE_LIMIT (65000). verdict.test.ts only ever exercised the LAST rung
// (findings shrinking); the two ledger rungs above it and the narrowed
// VerdictIntegrityError condition had no coverage at all, so an over-size body
// could have started dropping findings while a 60 KB coverage table survived.
//
// The ledger sections are rendered by review/ledger.ts from a real
// `buildRoundLedger` ledger — the exact strings pipeline/publish.ts passes in.
import { describe, expect, it } from "vitest";
import { formatVerdict, VerdictIntegrityError } from "@/review/verdict.js";
import {
  buildRoundLedger,
  renderLedger,
  renderLedgerSummary,
  LEDGER_MAX_ROWS,
  type CoverageEntry,
} from "@/review/ledger.js";
import type { ProviderResult } from "@/llm/reviewWithModel.js";
import type { Finding } from "@/llm/schema.js";
import { encodeMarker } from "@/state.js";

/** GitHub's ceiling, restated: verdict.ts keeps this private on purpose. */
const BODY_SIZE_LIMIT = 65000;

const MARKER = encodeMarker({
  schema: "toolu-review-state",
  version: 1,
  findings: [{ path: "src/a.ts", line: 10, text: "remembered", category: "c", fp: "x" }],
  history: [],
});

/** The last non-empty line of a body. */
function lastLine(body: string): string {
  const trimmed = body.replace(/\n+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("\n") + 1);
}

/** A handful of real findings, worst-first-sortable, none of them bulky. */
function findings(n: number): Finding[] {
  return Array.from({ length: n }, (_, i) => ({
    path: `src/f${i}.ts`,
    line: 10 + i,
    severity: i === 0 ? ("blocker" as const) : i < 3 ? ("high" as const) : ("low" as const),
    text: `finding number ${i} that must survive the ledger rungs`,
    confidence: "high" as const,
  }));
}

/**
 * A ledger whose rendered section is ~`targetChars` long: LEDGER_MAX_ROWS rows of
 * deeply-nested paths (a monorepo shape). The ROW CAP is what forces the bulk into
 * path length rather than row count — the section is capped at 50 rows no matter
 * how many paths are unreviewed.
 */
function fatLedgerSections(targetChars: number): { ledger: string; summary: string } {
  const perRow = Math.ceil(targetChars / LEDGER_MAX_ROWS);
  const depth = Math.max(1, Math.floor((perRow - 30) / 5));
  const paths = Array.from(
    { length: LEDGER_MAX_ROWS },
    (_, i) => `src/${"deep/".repeat(depth)}file-${String(i).padStart(3, "0")}.ts`,
  );
  const ledger = buildRoundLedger({
    changedFiles: paths,
    binaryFiles: [],
    droppedFiles: [],
    strata: {},
    exemplars: new Set<string>(),
    coverage: new Map<string, CoverageEntry>(paths.map((p) => [p, { status: "unreviewed" }])),
    carried: [],
  });
  return { ledger: renderLedger(ledger, "full"), summary: renderLedgerSummary(ledger) };
}

const CHANGES: ProviderResult = {
  verdict: "changes",
  findings: [],
  review_plan: "Reviewed the diff.",
  other_checks: "",
  top_must_fix: [],
};

describe("fitToSizeLimit — the ledger rungs run BEFORE findings shrink", () => {
  it("rung 2: drops the ledger's per-path rows, keeps its counts summary, keeps every finding", () => {
    const { ledger, summary } = fatLedgerSections(64_000);
    const result: ProviderResult = { ...CHANGES, findings: findings(10) };

    // The premise: rung 1 (everything) overflows, rung 2 (summary) does not.
    expect(ledger.length).toBeGreaterThan(60_000);
    expect(summary.length).toBeLessThan(200);

    const { body } = formatVerdict(result, {
      ledger,
      ledgerSummary: summary,
      historyMarker: MARKER,
    });

    expect(body.length).toBeLessThanOrEqual(BODY_SIZE_LIMIT);
    // The section is still there — only its rows went.
    expect(body).toContain("### Coverage");
    expect(body).toContain("unreviewed: 50");
    expect(body).not.toContain("deep/deep/");
    // Findings are untouched: not one was dropped and nothing was truncated.
    expect(body).toContain("### Findings (10)");
    for (const f of findings(10)) expect(body).toContain(f.text);
    expect(body).not.toMatch(/_… \d+ more findings/);
    expect(lastLine(body)).toBe(MARKER);
  });

  it("rung 3: drops the ledger SECTION entirely when there is no summary rung to fall to", () => {
    // pipeline/publish.ts omits `ledgerSummary` for a ledger that has no rows to
    // shed; the ladder then goes straight from "everything" to "no section".
    const { ledger } = fatLedgerSections(64_000);
    const result: ProviderResult = { ...CHANGES, findings: findings(10) };

    const { body } = formatVerdict(result, { ledger, historyMarker: MARKER });

    expect(body.length).toBeLessThanOrEqual(BODY_SIZE_LIMIT);
    expect(body).not.toContain("### Coverage");
    // Findings still survive the whole ledger being sacrificed for them.
    expect(body).toContain("### Findings (10)");
    for (const f of findings(10)) expect(body).toContain(f.text);
    expect(body).not.toMatch(/_… \d+ more findings/);
    expect(lastLine(body)).toBe(MARKER);
  });

  it("rung 3 then 4: a body still over the cap with the section gone finally shrinks findings", () => {
    // Both the ledger AND the findings are oversized: the ledger goes first (all
    // three rungs), and only then does the findings list start halving.
    const { ledger, summary } = fatLedgerSections(64_000);
    const pad = "x".repeat(400);
    const bulky: Finding[] = Array.from({ length: 200 }, (_, i) => ({
      path: `src/big${i}.ts`,
      line: 1,
      severity: i < 2 ? ("blocker" as const) : ("nit" as const),
      text: `bulky finding ${i} ${pad}`,
      confidence: "high" as const,
    }));

    const { body } = formatVerdict(
      { ...CHANGES, findings: bulky },
      { ledger, ledgerSummary: summary, historyMarker: MARKER, jobUrl: "https://ci.example/job/1" },
    );

    expect(body.length).toBeLessThanOrEqual(BODY_SIZE_LIMIT);
    // The ledger was sacrificed BEFORE any finding was — that is the ladder's order.
    expect(body).not.toContain("### Coverage");
    // Findings shrank, worst-first, with the drop stated (never silent).
    expect(body).toContain("### Findings (200)");
    expect(body).toMatch(
      /_… \d+ more findings — see the \[job log]\(https:\/\/ci\.example\/job\/1\)_/,
    );
    expect(body).toContain("blocker: bulky finding 0");
    expect(lastLine(body)).toBe(MARKER);
  });

  it("a body that already fits keeps the full ledger rows untouched", () => {
    // The control: rung 1 is returned as-is, so the rungs below never run.
    const { ledger, summary } = fatLedgerSections(3_000);
    const { body } = formatVerdict(
      { ...CHANGES, findings: findings(3) },
      { ledger, ledgerSummary: summary, historyMarker: MARKER },
    );
    expect(body.length).toBeLessThanOrEqual(BODY_SIZE_LIMIT);
    expect(body).toContain("### Coverage");
    expect(body).toContain("deep/");
    expect(body).toContain("unreviewed: 50");
  });
});

describe("fitToSizeLimit — VerdictIntegrityError's narrowed condition", () => {
  /** A recap so large no rung can save the body — the memory blocks are never
   *  ladder candidates, so this is the one genuinely unfittable shape. */
  const HUGE_RECAP = `### Changes since last review\n\n${"r".repeat(70_000)}`;

  it("throws when findings were shrunk to zero and the body STILL overflows", () => {
    expect(() =>
      formatVerdict(
        { ...CHANGES, findings: findings(5) },
        { recap: HUGE_RECAP, historyMarker: MARKER },
      ),
    ).toThrow(VerdictIntegrityError);
    expect(() =>
      formatVerdict(
        { ...CHANGES, findings: findings(5) },
        { recap: HUGE_RECAP, historyMarker: MARKER },
      ),
    ).toThrow(/cannot fit under 65000 chars even with no findings/);
  });

  it("does NOT throw for a findings-FREE body that overflows — it is returned as-is", () => {
    // The narrowing that matters: with no findings there is nothing the ladder
    // could have shrunk, so failing the run would punish a report it cannot fix.
    const { body } = formatVerdict(
      { ...CHANGES, findings: [], verdict: "approved" },
      { recap: HUGE_RECAP, historyMarker: MARKER },
    );
    expect(body.length).toBeGreaterThan(BODY_SIZE_LIMIT);
    // Over-size, but never at the marker's expense — it is still the last line.
    expect(lastLine(body)).toBe(MARKER);
  });

  it("never drops the marker on the way down the ladder", () => {
    const { ledger, summary } = fatLedgerSections(64_000);
    const { body } = formatVerdict(
      { ...CHANGES, findings: findings(10) },
      { ledger, ledgerSummary: summary, historyMarker: MARKER },
    );
    expect(body).toContain(MARKER);
    expect(lastLine(body)).toBe(MARKER);
  });
});
