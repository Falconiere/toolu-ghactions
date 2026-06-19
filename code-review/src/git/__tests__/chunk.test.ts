import { describe, it, expect, afterEach } from "vitest";
import { fetchDiff } from "@/git/diff.js";
import { splitDiffByFile, packChunks } from "@/git/chunk.js";
import type { FileSegment } from "@/git/chunk.js";
import { git, setupGitRepo, writeFile, removeRepo } from "./helpers.js";

// REAL temp git repos → real shaped diffs (no mocks). splitDiffByFile/packChunks
// are exercised on the exact output the pipeline feeds them.

const repos: string[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) removeRepo(r);
});

const BASE = { baseBranch: "main", githubBaseRef: "main" } as const;

/** A repo whose feature branch adds `count` source files of `linesEach` lines. */
function repoWithFiles(count: number, linesEach: number): string {
  const dir = setupGitRepo();
  repos.push(dir);
  git(dir, "checkout", "-b", "feature", "--quiet");
  for (let i = 0; i < count; i++) {
    const body = Array.from({ length: linesEach }, (_, n) => `export const v${i}_${n} = ${n}`).join(
      "\n",
    );
    writeFile(dir, `src/mod${String(i).padStart(2, "0")}.ts`, `${body}\n`);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "add modules", "--quiet");
  return dir;
}

function diffOf(dir: string): string {
  return fetchDiff({ ...BASE, cwd: dir, maxFiles: 0, maxDiffLines: 0 }).diff;
}

describe("splitDiffByFile", () => {
  it("round-trips: joining segment diffs reproduces the input exactly", () => {
    const diff = diffOf(repoWithFiles(4, 5));
    const segments = splitDiffByFile(diff);
    expect(segments.length).toBe(4);
    expect(segments.map((s) => s.diff).join("")).toBe(diff);
  });

  it("parses every changed file's path from its diff block", () => {
    const dir = repoWithFiles(3, 3);
    const r = fetchDiff({ ...BASE, cwd: dir, maxFiles: 0, maxDiffLines: 0 });
    const paths = splitDiffByFile(r.diff)
      .map((s) => s.path)
      .sort();
    expect(paths).toEqual([...r.changed_files].sort());
  });

  it("parses a deletion's path from `--- a/<path>` when `+++` is /dev/null", () => {
    const dir = setupGitRepo();
    repos.push(dir);
    writeFile(dir, "src/doomed.ts", "export const gone = 1\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "add doomed", "--quiet");
    git(dir, "checkout", "-b", "feature", "--quiet");
    git(dir, "rm", "--quiet", "src/doomed.ts");
    git(dir, "commit", "-m", "delete doomed", "--quiet");

    const diff = diffOf(dir);
    const segments = splitDiffByFile(diff);
    const doomed = segments.find((s) => s.diff.includes("doomed.ts"));
    expect(doomed?.diff).toContain("+++ /dev/null");
    expect(doomed?.path).toBe("src/doomed.ts");
  });

  it("strips git's trailing tab from a spaced path so it matches the SARIF key", () => {
    const dir = setupGitRepo();
    repos.push(dir);
    git(dir, "checkout", "-b", "feature", "--quiet");
    writeFile(dir, "src/with space.ts", "export const y = 2\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "spaced file", "--quiet");

    const r = fetchDiff({ ...BASE, cwd: dir, maxFiles: 0, maxDiffLines: 0 });
    const seg = splitDiffByFile(r.diff).find((s) => s.diff.includes("with space.ts"));
    // No trailing tab, and equal to the path git reports in changed_files.
    expect(seg?.path).toBe("src/with space.ts");
    expect(r.changed_files).toContain(seg?.path);
  });

  it("decodes a git C-quoted (octal-escaped) non-ASCII path to its UTF-8 form", () => {
    // Exactly how git emits a non-ASCII path block (café → caf\303\251).
    const quotedDiff =
      'diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"\n' +
      "new file mode 100644\n" +
      "index 0000000..1111111\n" +
      "--- /dev/null\n" +
      '+++ "b/src/caf\\303\\251.ts"\n' +
      "@@ -0,0 +1 @@\n" +
      "L1: +export const x = 1\n";
    const seg = splitDiffByFile(quotedDiff);
    expect(seg.length).toBe(1);
    expect(seg[0]?.path).toBe("src/café.ts");
  });

  it("decodes git's named C-quote escapes (an embedded quote in the filename)", () => {
    // git quotes a name containing a double-quote as \" inside the wrapper.
    const quotedDiff =
      'diff --git "a/src/a\\"b.ts" "b/src/a\\"b.ts"\n' +
      "--- /dev/null\n" +
      '+++ "b/src/a\\"b.ts"\n' +
      "@@ -0,0 +1 @@\n" +
      "L1: +export const x = 1\n";
    expect(splitDiffByFile(quotedDiff)[0]?.path).toBe('src/a"b.ts');
  });

  it("returns [] for an empty diff", () => {
    expect(splitDiffByFile("")).toEqual([]);
  });
});

describe("packChunks", () => {
  it("packs whole files into ≤ maxLines chunks, never splitting a file", () => {
    const diff = diffOf(repoWithFiles(6, 4)); // ~6 blocks, each ~9 primed lines
    const segments = splitDiffByFile(diff);
    const maxLines = 20;
    const { chunks, dropped } = packChunks(segments, maxLines, 0);

    expect(dropped).toEqual([]);
    expect(chunks.length).toBeGreaterThan(1);
    // No file appears in two chunks.
    const allPaths = chunks.flat().map((s) => s.path);
    expect(new Set(allPaths).size).toBe(allPaths.length);
    // Every chunk is within budget (each single file here is < maxLines).
    for (const chunk of chunks) {
      const total = chunk.reduce((n, s) => n + s.lines, 0);
      expect(total).toBeLessThanOrEqual(maxLines);
    }
    // Every input file is covered.
    expect(allPaths.length).toBe(segments.length);
  });

  it("emits files in path-sorted order so directory siblings stay adjacent", () => {
    const diff = diffOf(repoWithFiles(5, 3));
    const segments = splitDiffByFile(diff);
    const ordered = packChunks(segments, 12, 0)
      .chunks.flat()
      .map((s) => s.path);
    expect(ordered).toEqual([...ordered].sort());
  });

  it("gives a file larger than the budget its own oversized chunk", () => {
    const diff = diffOf(repoWithFiles(2, 50)); // each file ≫ maxLines
    const segments = splitDiffByFile(diff);
    const maxLines = 10;
    const { chunks } = packChunks(segments, maxLines, 0);
    expect(chunks.length).toBe(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBe(1);
      expect(chunk[0]!.lines).toBeGreaterThan(maxLines);
    }
  });

  it("spills chunks beyond maxChunks into dropped", () => {
    const diff = diffOf(repoWithFiles(6, 4));
    const segments = splitDiffByFile(diff);
    const { chunks, dropped } = packChunks(segments, 12, 1);
    expect(chunks.length).toBe(1);
    expect(dropped.length).toBeGreaterThan(0);
    // chunks + dropped still cover every file exactly once.
    const covered = [...chunks.flat(), ...dropped].map((s: FileSegment) => s.path).sort();
    expect(covered).toEqual([...segments.map((s) => s.path)].sort());
  });
});
