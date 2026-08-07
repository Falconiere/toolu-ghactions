// Tree-based incremental scope against REAL scratch git repos (no mocks): the
// marker's `reviewed_tree` from round 1 versus the head tree of round 2, run
// through the same fetchDiff → resolveTreeScope → filterDiffToScope path the
// pipeline uses. The point of exercising real git here is PATH SPELLING: the
// scope compares `git diff-tree` output against `DiffData.changed_files`, and
// the two only agree if both producers quote paths the same way.
import { describe, it, expect, afterEach } from "vitest";
import { fetchDiff } from "@/git/diff.js";
import type { ReviewState } from "@/state.js";
import { resolveTreeScope, filterDiffToScope, exceptionPaths } from "../scope.js";
import { resolveTreeSha } from "../git.js";
import {
  git,
  setupGitRepo,
  writeFile,
  removeRepo,
  canCreateFile,
} from "../../git/__tests__/helpers.js";

const repos: string[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) removeRepo(r);
});

const BASE = { baseBranch: "main", githubBaseRef: "main", maxFiles: 0, maxDiffLines: 0 } as const;

/** A marker state carrying only what the tree scope reads. */
function priorWithTree(tree: string | undefined): ReviewState {
  return {
    schema: "toolu-review-state",
    version: 1,
    findings: [],
    history: [],
    ...(tree === undefined ? {} : { reviewed_tree: tree }),
  };
}

/** Init a repo on `main` with `files`, branch to `feature`, and return its dir. */
function baseRepo(files: Record<string, string>): string {
  const dir = setupGitRepo();
  repos.push(dir);
  for (const [path, content] of Object.entries(files)) writeFile(dir, path, content);
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "base", "--quiet");
  git(dir, "checkout", "-b", "feature", "--quiet");
  return dir;
}

/** Commit `files` on the current branch and return the resulting ROOT TREE sha. */
function commitReturningTree(dir: string, files: Record<string, string>): string {
  for (const [path, content] of Object.entries(files)) writeFile(dir, path, content);
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "round", "--quiet");
  const tree = resolveTreeSha("HEAD", dir);
  if (tree === null) throw new Error("expected HEAD to resolve to a tree");
  return tree;
}

/** The scope + carried split the pipeline computes for one round. */
function scopeRound(
  dir: string,
  prior: ReviewState,
): { inScope: string[]; carried: string[]; scopeIsNull: boolean } {
  const diff = fetchDiff({ ...BASE, cwd: dir });
  const scope = resolveTreeScope({ prior, mode: "incremental", reviewHead: "HEAD", cwd: dir });
  if (scope === null) return { inScope: [], carried: [], scopeIsNull: true };
  const { diff: scoped, carried } = filterDiffToScope(diff, scope.inScope);
  return { inScope: scoped.changed_files, carried, scopeIsNull: false };
}

describe("resolveTreeScope — path spelling agreement with fetchDiff", () => {
  // Regression: `treeDiffPaths` read `git diff-tree -z` (raw bytes) while
  // `changed_files` came from a non-`-z` `git diff --name-only`, which C-quotes
  // any non-ASCII path under git's default core.quotepath. `日本語.txt` was
  // therefore never found in the tree diff, read as unchanged, and dropped from
  // the incremental review with no warning anywhere.
  it("re-reviews a NON-ASCII path changed since the last reviewed tree", () => {
    const dir = baseRepo({ "日本語.txt": "one\n", "src/app.ts": "export const x = 1;\n" });
    const round1 = commitReturningTree(dir, { "src/app.ts": "export const x = 2;\n" });
    // Round 2 touches ONLY the non-ASCII path.
    commitReturningTree(dir, { "日本語.txt": "two\n" });

    const r = scopeRound(dir, priorWithTree(round1));
    expect(r.scopeIsNull).toBe(false);
    expect(r.inScope).toContain("日本語.txt");
    expect(r.carried).not.toContain("日本語.txt");
    // src/app.ts changed in round 1 only → correctly carried, not re-reviewed.
    expect(r.carried).toEqual(["src/app.ts"]);
  });

  // git C-quotes this name on EVERY producer regardless of core.quotepath; both
  // sides are decoded at the boundary (git/path.ts), so the scope compares — and
  // reports — the REAL path.
  it.skipIf(!canCreateFile('we"ird.txt'))(
    "re-reviews a path whose name holds a double quote, under its REAL name",
    () => {
      const dir = baseRepo({ 'we"ird.txt': "one\n", "src/app.ts": "export const x = 1;\n" });
      const round1 = commitReturningTree(dir, { "src/app.ts": "export const x = 2;\n" });
      commitReturningTree(dir, { 'we"ird.txt': "two\n" });

      const diff = fetchDiff({ ...BASE, cwd: dir });
      expect(diff.changed_files).toContain('we"ird.txt');
      // No caller ever sees git's wire spelling.
      expect(diff.changed_files.some((p) => p.includes("\\"))).toBe(false);

      const r = scopeRound(dir, priorWithTree(round1));
      expect(r.scopeIsNull).toBe(false);
      expect(r.carried).toEqual(["src/app.ts"]);
      expect(r.inScope).toContain('we"ird.txt');
    },
  );

  it.skipIf(!canCreateFile("tab\there.txt"))(
    "re-reviews a path whose name holds a tab, under its REAL name",
    () => {
      const dir = baseRepo({ "tab\there.txt": "one\n", "src/app.ts": "export const x = 1;\n" });
      const round1 = commitReturningTree(dir, { "src/app.ts": "export const x = 2;\n" });
      commitReturningTree(dir, { "tab\there.txt": "two\n" });

      const r = scopeRound(dir, priorWithTree(round1));
      expect(r.inScope).toContain("tab\there.txt");
      expect(r.carried).toEqual(["src/app.ts"]);
    },
  );

  it("carries an ASCII path untouched since the last reviewed tree", () => {
    const dir = baseRepo({
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 1;\n",
    });
    const round1 = commitReturningTree(dir, {
      "src/a.ts": "export const a = 2;\n",
      "src/b.ts": "export const b = 2;\n",
    });
    commitReturningTree(dir, { "src/b.ts": "export const b = 3;\n" });

    const r = scopeRound(dir, priorWithTree(round1));
    expect(r.inScope).toEqual(["src/b.ts"]);
    expect(r.carried).toEqual(["src/a.ts"]);
  });
});

describe("resolveTreeScope — fail-open", () => {
  // A force-push can garbage-collect the tree the marker points at. Narrowing
  // against a tree that is not in this clone would silently drop every path.
  it("falls open to a full review when the prior reviewed_tree is not in the repo", () => {
    const dir = baseRepo({ "src/a.ts": "export const a = 1;\n" });
    commitReturningTree(dir, { "src/a.ts": "export const a = 2;\n" });
    // A well-formed sha that no object in this repo has.
    const gone = "0123456789abcdef0123456789abcdef01234567";

    const scope = resolveTreeScope({
      prior: priorWithTree(gone),
      mode: "incremental",
      reviewHead: "HEAD",
      cwd: dir,
    });
    expect(scope).toBeNull();

    // Fail-open means the pipeline reviews the whole diff: nothing is carried.
    const r = scopeRound(dir, priorWithTree(gone));
    expect(r.scopeIsNull).toBe(true);
    expect(r.carried).toEqual([]);
  });

  it("falls open when the marker carries no reviewed_tree at all", () => {
    const dir = baseRepo({ "src/a.ts": "export const a = 1;\n" });
    commitReturningTree(dir, { "src/a.ts": "export const a = 2;\n" });
    expect(
      resolveTreeScope({
        prior: priorWithTree(undefined),
        mode: "incremental",
        reviewHead: "HEAD",
        cwd: dir,
      }),
    ).toBeNull();
  });

  it("keeps exception paths in scope even when the tree diff does not list them", () => {
    const dir = baseRepo({
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 1;\n",
    });
    const round1 = commitReturningTree(dir, {
      "src/a.ts": "export const a = 2;\n",
      "src/b.ts": "export const b = 2;\n",
    });
    commitReturningTree(dir, { "src/b.ts": "export const b = 3;\n" });

    // src/a.ts was attempted and failed last round: it must be re-reviewed even
    // though the tree diff says it has not changed since.
    const prior: ReviewState = { ...priorWithTree(round1), unreviewed_paths: ["src/a.ts"] };
    expect([...exceptionPaths(prior)]).toEqual(["src/a.ts"]);

    const r = scopeRound(dir, prior);
    expect(r.inScope.sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(r.carried).toEqual([]);
  });
});
