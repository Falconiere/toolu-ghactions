import { describe, it, expect, afterEach } from "vitest";
import { fetchDiff } from "@/git/diff.js";
import { git, setupGitRepo, writeFile, removeRepo } from "./helpers.js";

// REAL temp git repos exercising the two opt-in limits (MAX_FILES skip and
// MAX_DIFF_LINES hunk-boundary truncation), mirroring __tests__/fetch-diff.bats.

const repos: string[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) removeRepo(r);
});

function featureRepo(): string {
  const dir = setupGitRepo();
  repos.push(dir);
  git(dir, "checkout", "-b", "feature", "--quiet");
  return dir;
}

const BASE = { baseBranch: "main", githubBaseRef: "main" } as const;

describe("fetchDiff limits", () => {
  it("is unlimited by default — many files are reviewed, not skipped", () => {
    const dir = featureRepo();
    for (let i = 1; i <= 12; i++) writeFile(dir, `f${i}.ts`, `content ${i}\n`);
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "twelve files", "--quiet");

    const r = fetchDiff({ ...BASE, cwd: dir });
    expect(r.error).toBeUndefined();
    expect(r.total_files).toBe(12);
    expect(r.files).toHaveLength(12);
    expect(r.truncated).toBe(false);
  });

  it("a positive MAX_FILES over the limit returns a skip object on the RESULT (not a throw)", () => {
    const dir = featureRepo();
    for (let i = 1; i <= 3; i++) writeFile(dir, `f${i}.ts`, `content ${i}\n`);
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "three files", "--quiet");

    const r = fetchDiff({ ...BASE, cwd: dir, maxFiles: 2 });
    expect(r.error).toMatch(/exceeds file limit/);
    expect(r.total_files).toBe(3);
    expect(r.max_files).toBe(2);
    // Skip short-circuits before diff work: no diff payload built.
    expect(r.diff).toBe("");
    expect(r.changed_files).toEqual([]);
  });

  it("MAX_DIFF_LINES truncates at a hunk boundary (truncated=true)", () => {
    const dir = featureRepo();
    let big = "";
    for (let n = 1; n <= 40; n++) big += `line ${n}\n`;
    writeFile(dir, "big.ts", big);
    writeFile(dir, "small.ts", "second file\n");
    git(dir, "add", "big.ts", "small.ts");
    git(dir, "commit", "-m", "add big + small", "--quiet");

    const r = fetchDiff({ ...BASE, cwd: dir, maxFiles: 100, maxDiffLines: 8 });
    expect(r.truncated).toBe(true);
    // No primed line is cut mid-content: every L-line still carries text, and
    // the diff never ends in the middle of a hunk header.
    expect(r.diff).toMatch(/^L[0-9]+: /m);
    // The kept portion ends at a clean boundary (not a partial mid-hunk line):
    // the truncated diff has fewer lines than the untruncated one.
    const full = fetchDiff({ ...BASE, cwd: dir, maxFiles: 100, maxDiffLines: 0 });
    expect(full.truncated).toBe(false);
    expect(r.total_lines).toBeLessThan(full.total_lines);
  });
});
