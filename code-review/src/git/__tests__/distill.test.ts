// AC-1: Layer 0 distillation against a REAL scratch git repo replicating comemory
// PR-72's shape — 140 files receiving an identical one-line insertion, 20 exact
// renames, 2 whitespace-only reformats, 10 substantive edits (plus a changed
// CLAUDE.md). Real `git` throughout (execFileSync via fetchDiff), no mocks: the
// diff distill() classifies is the same diff the reviewer would see.
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fetchDiff } from "@/git/diff.js";
import { distill, type Stratum } from "@/git/distill.js";
import { splitDiffByFile } from "@/git/chunk.js";
import { git, setupGitRepo, writeFile, removeRepo } from "./helpers.js";

const repos: string[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) removeRepo(r);
});

const BASE = { baseBranch: "main", githubBaseRef: "main", maxFiles: 0, maxDiffLines: 0 } as const;

const PATTERN_FILES = 140;
const RENAME_FILES = 20;
const SUBSTANTIVE_FILES = 10;

const LIB_BASE = "pub fn helper() {}\npub fn other() {}\n";
const LIB_NEW = `mod tests;\n${LIB_BASE}`;

/** Init a repo, register it for cleanup, and commit `files` on main. */
function baseRepo(files: Record<string, string>): string {
  const dir = setupGitRepo();
  repos.push(dir);
  for (const [path, content] of Object.entries(files)) writeFile(dir, path, content);
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "base", "--quiet");
  git(dir, "checkout", "-b", "feature", "--quiet");
  return dir;
}

/** Commit `files` on the feature branch (already checked out). */
function commitChange(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) writeFile(dir, path, content);
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "change", "--quiet");
}

/** Count how many paths carry each stratum. */
function tally(strata: Record<string, Stratum>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const stratum of Object.values(strata)) counts[stratum] = (counts[stratum] ?? 0) + 1;
  return counts;
}

/** The PR-72-shaped repo: returns the checked-out repo dir on branch `feature`. */
function pr72Repo(): string {
  const base: Record<string, string> = { "CLAUDE.md": "# Rules\n- always test\n" };
  for (let i = 0; i < PATTERN_FILES; i++) base[`src/mod${i}/lib.rs`] = LIB_BASE;
  for (let i = 0; i < RENAME_FILES; i++) base[`legacy/old${i}.ts`] = `export const r${i} = ${i};\n`;
  for (let i = 0; i < SUBSTANTIVE_FILES; i++)
    base[`src/feat/f${i}.ts`] = `export const f${i} = ${i};\n`;
  base["src/fmt/alpha.ts"] = "export function alpha() {\n  return 1;\n}\n";
  base["src/fmt/beta.ts"] = "export function beta() {\n  return 2;\n}\n";
  const dir = baseRepo(base);

  // 20 EXACT renames (content untouched → R100 under -M).
  mkdirSync(join(dir, "modern"), { recursive: true });
  for (let i = 0; i < RENAME_FILES; i++) {
    git(dir, "mv", `legacy/old${i}.ts`, `modern/new${i}.ts`);
  }

  const changes: Record<string, string> = {
    "CLAUDE.md": "# Rules\n- always test\n- always type\n",
  };
  // 140 IDENTICAL one-line insertions at the same position.
  for (let i = 0; i < PATTERN_FILES; i++) changes[`src/mod${i}/lib.rs`] = LIB_NEW;
  // 10 distinct substantive edits.
  for (let i = 0; i < SUBSTANTIVE_FILES; i++) {
    changes[`src/feat/f${i}.ts`] =
      `export const f${i} = ${i};\nexport function use${i}(x: number): number {\n  return x * ${i} + ${i};\n}\n`;
  }
  // 2 whitespace-only reformats (2-space → 4-space indent).
  changes["src/fmt/alpha.ts"] = "export function alpha() {\n    return 1;\n}\n";
  changes["src/fmt/beta.ts"] = "export function beta() {\n    return 2;\n}\n";
  commitChange(dir, changes);
  return dir;
}

describe("distill — PR-72 shape (AC-1)", () => {
  it("collapses the pattern, strips renames/formatting, and shrinks the review diff", () => {
    const dir = pr72Repo();
    const diff = fetchDiff({ ...BASE, cwd: dir });
    const d = distill(diff, { rulesPaths: ["CLAUDE.md"], cwd: dir });

    // 140 pattern + 20 rename sources + 20 rename targets + 2 formatting
    // + 10 substantive + CLAUDE.md.
    expect(diff.changed_files).toHaveLength(193);

    // Every changed path is classified exactly once.
    expect(Object.keys(d.strata).sort()).toEqual([...diff.changed_files].sort());
    expect(Object.keys(d.strata)).toHaveLength(diff.changed_files.length);
    expect(tally(d.strata)).toEqual({
      pattern: PATTERN_FILES,
      rename: RENAME_FILES * 2,
      formatting: 2,
      substantive: SUBSTANTIVE_FILES + 1, // + CLAUDE.md
    });

    // One pattern group over all 140 files, exemplar = lexicographically first.
    expect(d.pattern_groups).toHaveLength(1);
    const group = d.pattern_groups[0];
    expect(group?.members).toHaveLength(PATTERN_FILES);
    const expectedMembers = Array.from(
      { length: PATTERN_FILES },
      (_, i) => `src/mod${i}/lib.rs`,
    ).sort();
    expect(group?.members).toEqual(expectedMembers);
    expect(group?.exemplar).toBe(expectedMembers[0]);
    expect(group?.summary).toBe(`identical 1-line insertion in ${PATTERN_FILES} files`);
    expect(group?.hunk_hash).toMatch(/^[0-9a-f]{40}$/);

    // Strata spot checks against real git output.
    expect(d.strata["src/mod7/lib.rs"]).toBe("pattern");
    expect(d.strata["legacy/old3.ts"]).toBe("rename");
    expect(d.strata["modern/new3.ts"]).toBe("rename");
    expect(d.strata["src/fmt/alpha.ts"]).toBe("formatting");
    expect(d.strata["src/feat/f4.ts"]).toBe("substantive");
    expect(d.strata["CLAUDE.md"]).toBe("substantive");

    // review_diff: exemplar + substantive segments only, shaped format intact.
    const segments = splitDiffByFile(d.review_diff.diff);
    expect(segments.map((s) => s.path).sort()).toEqual(
      [
        "CLAUDE.md",
        "src/mod0/lib.rs",
        ...Array.from({ length: 10 }, (_, i) => `src/feat/f${i}.ts`),
      ].sort(),
    );
    expect(d.review_diff.total_files).toBe(12);
    expect(d.review_diff.total_lines).toBe(segments.reduce((n, s) => n + s.lines, 0));
    expect(d.review_diff.diff).toContain("L1: +mod tests;");
    expect(d.review_diff.diff).not.toContain("b/src/mod1/lib.rs");
    expect(d.review_diff.diff).not.toContain("b/modern/new0.ts");
    expect(d.review_diff.diff).not.toContain("b/src/fmt/alpha.ts");
    expect(d.review_diff.files.map((f) => f.path).sort()).toEqual(
      segments.map((s) => s.path).sort(),
    );

    // The shrink itself: ≤ 20% of the input diff's primed lines.
    expect(d.review_diff.total_lines).toBeLessThanOrEqual(diff.total_lines * 0.2);

    // changed_files stays the FULL list — the coverage ledger accounts for every path.
    expect(d.review_diff.changed_files).toEqual(diff.changed_files);

    // Manifest covers every path once, with real numstat counts.
    expect(d.manifest.map((m) => m.path)).toEqual(diff.changed_files);
    expect(d.manifest.find((m) => m.path === "src/mod0/lib.rs")).toEqual({
      path: "src/mod0/lib.rs",
      stratum: "pattern",
      additions: 1,
      deletions: 0,
    });
    expect(d.manifest.find((m) => m.path === "legacy/old0.ts")).toEqual({
      path: "legacy/old0.ts",
      stratum: "rename",
      additions: 0,
      deletions: 0,
    });

    expect(d.rules_changed).toEqual(["CLAUDE.md"]);
  });

  it("reports no rules_changed when no rule file is touched", () => {
    const dir = pr72Repo();
    const diff = fetchDiff({ ...BASE, cwd: dir });
    const d = distill(diff, { rulesPaths: ["AGENTS.md", ".cursor/rules/**"], cwd: dir });
    expect(d.rules_changed).toEqual([]);
  });
});

describe("distill — edges", () => {
  it("does not group 2 identical changes but does group 3 (PATTERN_MIN_MEMBERS)", () => {
    const twoDir = baseRepo({ "a.ts": "const x = 1;\n", "b.ts": "const x = 1;\n" });
    commitChange(twoDir, { "a.ts": "// note\nconst x = 1;\n", "b.ts": "// note\nconst x = 1;\n" });
    const two = distill(fetchDiff({ ...BASE, cwd: twoDir }), { rulesPaths: [], cwd: twoDir });
    expect(two.pattern_groups).toEqual([]);
    expect(tally(two.strata)).toEqual({ substantive: 2 });
    expect(
      splitDiffByFile(two.review_diff.diff)
        .map((s) => s.path)
        .sort(),
    ).toEqual(["a.ts", "b.ts"]);

    const threeDir = baseRepo({
      "a.ts": "const x = 1;\n",
      "b.ts": "const x = 1;\n",
      "c.ts": "const x = 1;\n",
    });
    commitChange(threeDir, {
      "a.ts": "// note\nconst x = 1;\n",
      "b.ts": "// note\nconst x = 1;\n",
      "c.ts": "// note\nconst x = 1;\n",
    });
    const three = distill(fetchDiff({ ...BASE, cwd: threeDir }), { rulesPaths: [], cwd: threeDir });
    expect(three.pattern_groups).toHaveLength(1);
    expect(three.pattern_groups[0]?.members).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(splitDiffByFile(three.review_diff.diff).map((s) => s.path)).toEqual(["a.ts"]);
  });

  it("keeps only the edit hunks of a near-rename and marks its old path renamed", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `export const l${i} = ${i};`).join("\n");
    const dir = baseRepo({ "src/big.ts": `${lines}\n` });
    git(dir, "mv", "src/big.ts", "src/moved.ts");
    const edited = lines.replace("export const l3 = 3;", "export const l3 = 300;");
    commitChange(dir, { "src/moved.ts": `${edited}\n` });

    const diff = fetchDiff({ ...BASE, cwd: dir });
    expect(diff.renames).toEqual([{ from: "src/big.ts", to: "src/moved.ts" }]);
    const d = distill(diff, { rulesPaths: [], cwd: dir });

    expect(d.strata["src/big.ts"]).toBe("rename");
    expect(d.strata["src/moved.ts"]).toBe("substantive");
    // Only the 1-line edit rides in the review diff, not the whole 20-line file.
    expect(d.manifest.find((m) => m.path === "src/moved.ts")).toEqual({
      path: "src/moved.ts",
      stratum: "substantive",
      additions: 1,
      deletions: 1,
    });
    expect(splitDiffByFile(d.review_diff.diff).map((s) => s.path)).toEqual(["src/moved.ts"]);
    expect(d.review_diff.diff).toContain("rename from src/big.ts");
    expect(d.review_diff.diff).toContain("L4: +export const l3 = 300;");
  });

  it("drops linguist-vendored files from the review diff", () => {
    const dir = baseRepo({
      ".gitattributes": "libs/** linguist-vendored\n",
      "libs/upstream.js": "function upstream() { return 1; }\n",
    });
    commitChange(dir, { "libs/upstream.js": "function upstream() { return 2; }\n" });

    const diff = fetchDiff({ ...BASE, cwd: dir });
    expect(diff.changed_files).toEqual(["libs/upstream.js"]);
    const d = distill(diff, { rulesPaths: [], cwd: dir });
    expect(d.strata).toEqual({ "libs/upstream.js": "vendored" });
    expect(d.review_diff.diff).toBe("");
    expect(d.review_diff.total_files).toBe(0);
    expect(d.review_diff.total_lines).toBe(0);
  });

  // Regression: despacing the compared lines made an edit INSIDE a string literal
  // compare equal to its own original, classifying the file `formatting` and
  // dropping it from the review diff entirely. Trim-only comparison sends every
  // interior whitespace change to `substantive` instead.
  it("classifies an in-literal whitespace edit substantive, not formatting", () => {
    const dir = baseRepo({ "src/db.ts": 'const sql = "select * from  t";\n' });
    commitChange(dir, { "src/db.ts": 'const sql = "select *from t";\n' });

    const diff = fetchDiff({ ...BASE, cwd: dir });
    const d = distill(diff, { rulesPaths: [], cwd: dir });
    expect(d.strata).toEqual({ "src/db.ts": "substantive" });
    expect(splitDiffByFile(d.review_diff.diff).map((s) => s.path)).toEqual(["src/db.ts"]);
    expect(d.review_diff.diff).toContain('L1: +const sql = "select *from t";');
  });

  it("still classifies a pure indentation reflow formatting, and drops it", () => {
    const dir = baseRepo({ "src/fmt.ts": "function f() {\n  return 1;\n}\n" });
    // Leading whitespace only: every changed line is byte-identical once trimmed.
    commitChange(dir, { "src/fmt.ts": "function f() {\n\t\treturn 1;\n}\n" });

    const diff = fetchDiff({ ...BASE, cwd: dir });
    const d = distill(diff, { rulesPaths: [], cwd: dir });
    expect(d.strata).toEqual({ "src/fmt.ts": "formatting" });
    expect(d.review_diff.diff).toBe("");
    expect(d.review_diff.total_files).toBe(0);
  });

  it("classifies a trailing-whitespace-only change formatting", () => {
    const dir = baseRepo({ "src/tail.ts": "const x = 1;\nconst y = 2;\n" });
    commitChange(dir, { "src/tail.ts": "const x = 1;   \nconst y = 2;\t\n" });

    const diff = fetchDiff({ ...BASE, cwd: dir });
    const d = distill(diff, { rulesPaths: [], cwd: dir });
    expect(d.strata).toEqual({ "src/tail.ts": "formatting" });
    expect(d.review_diff.diff).toBe("");
  });

  it("returns an empty distillation for an empty diff", () => {
    const dir = baseRepo({ "only.ts": "const x = 1;\n" });
    const diff = fetchDiff({ ...BASE, cwd: dir });
    expect(diff.total_files).toBe(0);

    const d = distill(diff, { rulesPaths: ["CLAUDE.md"], cwd: dir });
    expect(d.strata).toEqual({});
    expect(d.pattern_groups).toEqual([]);
    expect(d.manifest).toEqual([]);
    expect(d.rules_changed).toEqual([]);
    expect(d.review_diff.diff).toBe("");
    expect(d.review_diff.total_files).toBe(0);
    expect(d.review_diff.files).toEqual([]);
  });
});
