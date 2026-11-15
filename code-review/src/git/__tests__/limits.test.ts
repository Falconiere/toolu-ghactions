import { describe, it, expect, afterEach } from "vitest";
import { countLines, fetchDiff } from "@/git/diff.js";
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

  // MAX_DIFF_LINES must be a real cap. Hunk-boundary truncation can only cut at
  // the NEXT `diff --git `/`@@ ` line, so when the budget runs out inside the
  // LAST — or, here, the ONLY — hunk, no boundary ever arrives: the whole diff
  // came back while `truncated` was still set true and prompt.ts told the model
  // "[Diff truncated at N lines; some hunks omitted]" though nothing was omitted.
  // The two-file case above cannot catch this, because a second file supplies a
  // `diff --git` boundary to cut at.
  it("hard-caps a single hunk longer than MAX_DIFF_LINES, and reports truncated truthfully", () => {
    const dir = featureRepo();
    let big = "";
    for (let n = 1; n <= 60; n++) big += `line ${n}\n`;
    writeFile(dir, "solo.ts", big);
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "one big file", "--quiet");

    const full = fetchDiff({ ...BASE, cwd: dir, maxFiles: 100, maxDiffLines: 0 });
    expect(full.truncated).toBe(false);
    expect(full.total_lines).toBeGreaterThan(20);

    const r = fetchDiff({ ...BASE, cwd: dir, maxFiles: 100, maxDiffLines: 20 });
    expect(r.truncated).toBe(true);
    // The cap holds on both the reported count and the actual payload.
    expect(r.total_lines).toBe(20);
    expect(countLines(r.diff)).toBe(20);
    expect(r.total_lines).toBeLessThan(full.total_lines);
  });

  it("leaves truncated=false when the diff fits the budget exactly", () => {
    // The other direction of "honest": fitting under the cap is not truncation.
    const dir = featureRepo();
    writeFile(dir, "small.ts", "one\ntwo\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "small file", "--quiet");

    const full = fetchDiff({ ...BASE, cwd: dir, maxFiles: 100, maxDiffLines: 0 });
    const r = fetchDiff({ ...BASE, cwd: dir, maxFiles: 100, maxDiffLines: full.total_lines });
    expect(r.truncated).toBe(false);
    expect(r.total_lines).toBe(full.total_lines);
    expect(r.diff).toBe(full.diff);
  });
});
