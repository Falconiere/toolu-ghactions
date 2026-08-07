// ledger-round.test.ts — the three ledger entry points with production call sites
// that ledger.test.ts (a renderLedger suite) never reached: `buildRoundLedger`'s
// 5-rule precedence, `renderLedgerSummary` (the shrink ladder's middle rung,
// review/verdict.ts) and `pathsWithStatus` (the marker's exception lists and the
// approval degrade, pipeline/settle.ts).
//
// The precedence table is driven with the exact shapes each producing layer emits
// (`DiffData.dropped_files`, Layer 0 `strata`, Layer 2 `onCoverage` entries), and
// the vendored/generated row is driven end-to-end from a REAL scratch repo whose
// REAL `.gitattributes` carries the linguist attributes.
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRoundLedger,
  renderLedger,
  renderLedgerSummary,
  pathsWithStatus,
  LEDGER_MAX_ROWS,
  type CoverageEntry,
  type RoundLedgerInput,
} from "@/review/ledger.js";
import { fetchDiff } from "@/git/diff.js";
import { distill } from "@/git/distill.js";
import { git, setupGitRepo, writeFile, removeRepo } from "@/git/__tests__/helpers.js";

const repos: string[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) removeRepo(r);
});

/** A RoundLedgerInput with every source empty — tests fill only what they exercise. */
function input(over: Partial<RoundLedgerInput> = {}): RoundLedgerInput {
  return {
    changedFiles: [],
    binaryFiles: [],
    droppedFiles: [],
    strata: {},
    exemplars: new Set<string>(),
    coverage: new Map<string, CoverageEntry>(),
    carried: [],
    ...over,
  };
}

describe("buildRoundLedger — the documented precedence, highest rule first", () => {
  it("rule 1: dropped/binary beat carried, a stratum AND a coverage event on the same path", () => {
    // The path is claimed by every other source at once; `dropped` still wins,
    // because a file excluded before diffing is the one thing no later layer saw.
    const ledger = buildRoundLedger(
      input({
        changedFiles: ["package-lock.json", "assets/logo.png"],
        droppedFiles: [{ path: "package-lock.json", reason: "lockfile" }],
        binaryFiles: ["assets/logo.png"],
        strata: { "package-lock.json": "generated", "assets/logo.png": "formatting" },
        coverage: new Map<string, CoverageEntry>([
          ["package-lock.json", { status: "reviewed" }],
          ["assets/logo.png", { status: "reviewed" }],
        ]),
        carried: ["package-lock.json"],
      }),
    );
    expect(ledger.entries["package-lock.json"]).toEqual({
      status: "excluded",
      reason: "lockfile",
    });
    expect(ledger.entries["assets/logo.png"]).toEqual({ status: "excluded", reason: "binary" });
  });

  it("rule 2: carried beats a stale stratum and a coverage event", () => {
    // This round never looked at the path (out of tree scope), so a stratum left
    // over from a round that DID look at it must not describe this round.
    const ledger = buildRoundLedger(
      input({
        changedFiles: ["src/carried.ts"],
        strata: { "src/carried.ts": "formatting" },
        coverage: new Map<string, CoverageEntry>([["src/carried.ts", { status: "reviewed" }]]),
        carried: ["src/carried.ts"],
      }),
    );
    expect(ledger.entries["src/carried.ts"]).toEqual({ status: "carried" });
  });

  it("rule 2: carriedWithoutFinding carries too, and a carried path OUTSIDE changedFiles still gets a row", () => {
    const ledger = buildRoundLedger(
      input({
        changedFiles: ["src/in-diff.ts"],
        coverage: new Map<string, CoverageEntry>([["src/in-diff.ts", { status: "reviewed" }]]),
        carried: ["src/out-of-scope.ts"],
        carriedWithoutFinding: ["src/shape-check-failed.ts"],
      }),
    );
    expect(ledger.entries["src/in-diff.ts"]).toEqual({ status: "reviewed" });
    expect(ledger.entries["src/out-of-scope.ts"]).toEqual({ status: "carried" });
    expect(ledger.entries["src/shape-check-failed.ts"]).toEqual({ status: "carried" });
    // AC-8: exactly one entry per path, no duplicate row for the in-diff one.
    expect(Object.keys(ledger.entries).sort()).toEqual([
      "src/in-diff.ts",
      "src/out-of-scope.ts",
      "src/shape-check-failed.ts",
    ]);
  });

  it("rule 3: a non-substantive stratum beats a coverage event claiming the path was read", () => {
    // The whole-diff fast path reports DiffData.changed_files, which distill keeps
    // FULL — so it names paths deliberately absent from the review diff. The
    // stratum is the truth for those.
    const ledger = buildRoundLedger(
      input({
        changedFiles: ["src/fmt.ts", "legacy/old.ts", "vendor/lib.js", "gen/api.ts", "src/dup.ts"],
        strata: {
          "src/fmt.ts": "formatting",
          "legacy/old.ts": "rename",
          "vendor/lib.js": "vendored",
          "gen/api.ts": "generated",
          "src/dup.ts": "pattern",
        },
        coverage: new Map<string, CoverageEntry>(
          ["src/fmt.ts", "legacy/old.ts", "vendor/lib.js", "gen/api.ts", "src/dup.ts"].map((p) => [
            p,
            { status: "reviewed" },
          ]),
        ),
      }),
    );
    expect(ledger.entries["src/fmt.ts"]).toEqual({ status: "formatting" });
    expect(ledger.entries["legacy/old.ts"]).toEqual({ status: "rename" });
    expect(ledger.entries["vendor/lib.js"]).toEqual({ status: "vendored" });
    expect(ledger.entries["gen/api.ts"]).toEqual({ status: "generated" });
    expect(ledger.entries["src/dup.ts"]).toEqual({ status: "pattern" });
  });

  it("rule 3 exception: a pattern EXEMPLAR falls through to its coverage outcome", () => {
    // The exemplar is the member that actually rides the review diff, so its
    // coverage event is real — only the collapsed members it stands for are
    // `pattern`.
    const ledger = buildRoundLedger(
      input({
        changedFiles: ["src/dup-exemplar.ts", "src/dup-member.ts"],
        strata: { "src/dup-exemplar.ts": "pattern", "src/dup-member.ts": "pattern" },
        exemplars: new Set(["src/dup-exemplar.ts"]),
        coverage: new Map<string, CoverageEntry>([
          ["src/dup-exemplar.ts", { status: "reviewed" }],
          ["src/dup-member.ts", { status: "reviewed" }],
        ]),
      }),
    );
    expect(ledger.entries["src/dup-exemplar.ts"]).toEqual({ status: "reviewed" });
    expect(ledger.entries["src/dup-member.ts"]).toEqual({ status: "pattern" });
  });

  it("rule 4: a substantive path takes Layer 2's coverage outcome verbatim, reason included", () => {
    const ledger = buildRoundLedger(
      input({
        changedFiles: ["src/ok.ts", "src/failed.ts", "src/later.ts", "src/spilled.ts"],
        strata: {
          "src/ok.ts": "substantive",
          "src/failed.ts": "substantive",
          "src/later.ts": "substantive",
          "src/spilled.ts": "substantive",
        },
        coverage: new Map<string, CoverageEntry>([
          ["src/ok.ts", { status: "reviewed" }],
          ["src/failed.ts", { status: "unreviewed" }],
          ["src/later.ts", { status: "pending" }],
          ["src/spilled.ts", { status: "unreviewed", reason: "chunk-limit" }],
        ]),
      }),
    );
    expect(ledger.entries["src/ok.ts"]).toEqual({ status: "reviewed" });
    expect(ledger.entries["src/failed.ts"]).toEqual({ status: "unreviewed" });
    expect(ledger.entries["src/later.ts"]).toEqual({ status: "pending" });
    expect(ledger.entries["src/spilled.ts"]).toEqual({
      status: "unreviewed",
      reason: "chunk-limit",
    });
  });

  it("rule 5: a path no layer accounted for is loudly unreviewed (not-attempted)", () => {
    const ledger = buildRoundLedger(input({ changedFiles: ["src/orphan.ts"] }));
    expect(ledger.entries["src/orphan.ts"]).toEqual({
      status: "unreviewed",
      reason: "not-attempted",
    });
  });

  it("one path reported by distill + onCoverage + carried at once resolves to carried", () => {
    // The finding's headline merge case, isolated: three sources, one winner, and
    // the two losers leave no trace.
    const ledger = buildRoundLedger(
      input({
        changedFiles: ["src/contested.ts"],
        strata: { "src/contested.ts": "vendored" },
        coverage: new Map<string, CoverageEntry>([["src/contested.ts", { status: "unreviewed" }]]),
        carried: ["src/contested.ts"],
      }),
    );
    expect(ledger.entries["src/contested.ts"]).toEqual({ status: "carried" });
    expect(pathsWithStatus(ledger, "unreviewed")).toEqual([]);
    expect(pathsWithStatus(ledger, "vendored")).toEqual([]);
  });
});

describe("buildRoundLedger — real .gitattributes linguist attributes reach the ledger", () => {
  /** A repo whose committed `.gitattributes` marks one vendored and one generated
   *  path, neither of which any STATIC noise pattern would catch on its own —
   *  so the attributes file is the only thing that can classify them. */
  function linguistRepo(): string {
    const dir = setupGitRepo();
    repos.push(dir);
    // Committed on the BASE so it governs the branch too. `libs/external/` and
    // `schema/api.pb.ts` deliberately dodge git/noise.ts's path patterns
    // (`vendor|third_party|node_modules/…`, `.pb.go`) — a green assertion below
    // therefore proves the ATTRIBUTES did the work.
    writeFile(
      dir,
      ".gitattributes",
      "libs/external/** linguist-vendored\nschema/*.pb.ts linguist-generated\n",
    );
    writeFile(dir, "libs/external/lib.js", "module.exports = 1;\n");
    writeFile(dir, "schema/api.pb.ts", "export const v = 1;\n");
    writeFile(dir, "src/app.ts", "export const app = 1;\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "base", "--quiet");
    git(dir, "checkout", "-b", "feature", "--quiet");
    writeFile(dir, "libs/external/lib.js", "module.exports = 2;\n");
    writeFile(dir, "schema/api.pb.ts", "export const v = 2;\n");
    writeFile(dir, "src/app.ts", "export const app = 2;\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "change", "--quiet");
    return dir;
  }

  it("linguist-vendored survives into the diff and ledgers as the `vendored` STATUS", () => {
    const dir = linguistRepo();
    const diff = fetchDiff({
      baseBranch: "main",
      githubBaseRef: "main",
      cwd: dir,
      maxFiles: 0,
      maxDiffLines: 0,
    });
    // fetchDiff suppresses linguist-GENERATED only, so the vendored file is a real
    // changed path and Layer 0's REAL `git check-attr` is what classifies it.
    expect(diff.changed_files).toContain("libs/external/lib.js");
    const { strata } = distill(diff, { rulesPaths: [], cwd: dir });
    expect(strata["libs/external/lib.js"]).toBe("vendored");
    expect(strata["src/app.ts"]).toBe("substantive");

    // The whole-diff fast path reports EVERY changed path as reviewed — including
    // the vendored one, whose segment distill already stripped from the review
    // diff. Precedence rule 3 is what stops that claim from landing.
    const coverage = new Map<string, CoverageEntry>(
      diff.changed_files.map((p) => [p, { status: "reviewed" }]),
    );
    const ledger = buildRoundLedger(
      input({
        changedFiles: diff.changed_files,
        droppedFiles: diff.dropped_files,
        binaryFiles: diff.binary_files,
        strata,
        coverage,
      }),
    );

    expect(ledger.entries["libs/external/lib.js"]).toEqual({ status: "vendored" });
    expect(ledger.entries["src/app.ts"]).toEqual({ status: "reviewed" });
    expect(pathsWithStatus(ledger, "vendored")).toEqual(["libs/external/lib.js"]);
    expect(renderLedger(ledger, "compact")).toContain("vendored: 1");
  });

  it("linguist-generated is pre-dropped by fetchDiff, so it ledgers `excluded (generated (.gitattributes))`", () => {
    // The route the `generated` STRATUM does NOT take. distill.ts says so in prose
    // ("fetchDiff already drops linguist-generated files before diffing"); this is
    // that sentence as an assertion, so the two look-alike statuses can't be
    // confused when reading a real coverage section.
    const dir = linguistRepo();
    const diff = fetchDiff({
      baseBranch: "main",
      githubBaseRef: "main",
      cwd: dir,
      maxFiles: 0,
      maxDiffLines: 0,
    });
    expect(diff.changed_files).not.toContain("schema/api.pb.ts");
    expect(diff.dropped_files).toContainEqual({
      path: "schema/api.pb.ts",
      reason: "generated (.gitattributes)",
    });

    const { strata } = distill(diff, { rulesPaths: [], cwd: dir });
    const ledger = buildRoundLedger(
      input({
        changedFiles: diff.changed_files,
        droppedFiles: diff.dropped_files,
        binaryFiles: diff.binary_files,
        strata,
        coverage: new Map<string, CoverageEntry>(
          diff.changed_files.map((p) => [p, { status: "reviewed" }]),
        ),
      }),
    );

    expect(ledger.entries["schema/api.pb.ts"]).toEqual({
      status: "excluded",
      reason: "generated (.gitattributes)",
    });
    expect(pathsWithStatus(ledger, "generated")).toEqual([]);
    // Accounted for exactly once, never silently missing (AC-8).
    expect(Object.keys(ledger.entries)).toContain("schema/api.pb.ts");
    expect(renderLedger(ledger, "full")).toContain(
      "`schema/api.pb.ts`: excluded (generated (.gitattributes))",
    );
  });
});

describe("renderLedgerSummary — the shrink ladder's middle rung", () => {
  it("keeps the counts line and drops every per-path row the full render emits", () => {
    const ledger = buildRoundLedger(
      input({
        changedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
        coverage: new Map<string, CoverageEntry>([
          ["src/a.ts", { status: "reviewed" }],
          ["src/b.ts", { status: "unreviewed" }],
          ["src/c.ts", { status: "pending" }],
        ]),
      }),
    );

    const full = renderLedger(ledger, "full");
    const summary = renderLedgerSummary(ledger);

    expect(summary).toBe("### Coverage\n\nreviewed: 1 · unreviewed: 1 · pending: 1\n");
    // The rung is STRICTLY smaller — that is the only reason the ladder has it.
    expect(summary.length).toBeLessThan(full.length);
    expect(full).toContain("`src/b.ts`: unreviewed");
    expect(summary).not.toContain("src/b.ts");
    expect(summary).not.toContain("src/c.ts");
  });

  it("renders `_no changed files_` for an empty ledger rather than an empty section", () => {
    expect(renderLedgerSummary(buildRoundLedger(input()))).toBe(
      "### Coverage\n\n_no changed files_\n",
    );
  });

  it("is order-independent: two build orders produce the identical summary", () => {
    const paths = ["src/z.ts", "src/a.ts", "src/m.ts"];
    const coverage = new Map<string, CoverageEntry>(paths.map((p) => [p, { status: "reviewed" }]));
    const a = buildRoundLedger(input({ changedFiles: paths, coverage }));
    const b = buildRoundLedger(input({ changedFiles: [...paths].reverse(), coverage }));
    expect(renderLedgerSummary(a)).toBe(renderLedgerSummary(b));
  });
});

describe("pathsWithStatus — the marker's exception lists", () => {
  const ledger = buildRoundLedger(
    input({
      changedFiles: ["src/z.ts", "src/a.ts", "src/m.ts", "src/ok.ts", "src/skip.ts"],
      strata: { "src/skip.ts": "formatting" },
      coverage: new Map<string, CoverageEntry>([
        ["src/z.ts", { status: "unreviewed", reason: "chunk-limit" }],
        ["src/a.ts", { status: "unreviewed" }],
        ["src/m.ts", { status: "pending" }],
        ["src/ok.ts", { status: "reviewed" }],
      ]),
    }),
  );

  it("filters to exactly the requested status, sorted by path", () => {
    // Sorted, not insertion-ordered: the marker must be byte-stable across runs.
    expect(pathsWithStatus(ledger, "unreviewed")).toEqual(["src/a.ts", "src/z.ts"]);
    expect(pathsWithStatus(ledger, "pending")).toEqual(["src/m.ts"]);
    expect(pathsWithStatus(ledger, "reviewed")).toEqual(["src/ok.ts"]);
    expect(pathsWithStatus(ledger, "formatting")).toEqual(["src/skip.ts"]);
  });

  it("returns [] for a status no path carries (the complete-round signal)", () => {
    expect(pathsWithStatus(ledger, "carried")).toEqual([]);
    expect(pathsWithStatus(ledger, "excluded")).toEqual([]);
  });

  it("ignores the entry's reason — a status is a status", () => {
    // src/z.ts carries reason "chunk-limit" and src/a.ts none; both are unreviewed.
    expect(pathsWithStatus(ledger, "unreviewed")).toContain("src/z.ts");
  });
});

describe("renderLedger — a round ledger over LEDGER_MAX_ROWS exceptions", () => {
  it("caps the rows a real round produces and states how many it hid", () => {
    const paths = Array.from({ length: LEDGER_MAX_ROWS + 12 }, (_, i) => `src/f${i}.ts`);
    const ledger = buildRoundLedger(
      input({
        changedFiles: paths,
        coverage: new Map<string, CoverageEntry>(paths.map((p) => [p, { status: "pending" }])),
      }),
    );
    const rendered = renderLedger(ledger, "compact");
    expect(rendered.split("\n").filter((l) => l.startsWith("- `"))).toHaveLength(LEDGER_MAX_ROWS);
    expect(rendered).toContain("… 12 more");
    expect(pathsWithStatus(ledger, "pending")).toHaveLength(LEDGER_MAX_ROWS + 12);
  });
});
