import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { posix } from "node:path";
import { createRepositoryContext, testLikePaths } from "../repositoryContext.js";
import { setupGitRepo, git, writeFile, removeRepo } from "@/git/__tests__/helpers.js";

const repos: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) removeRepo(repo);
});

function fixture(): string {
  const dir = setupGitRepo();
  repos.push(dir);
  const files = {
    "apps/api/package.json": JSON.stringify({ name: "@example/api" }),
    "packages/db/package.json": JSON.stringify({
      name: "@example/db",
      exports: { "./schema": "./src/schema.ts", "./tables/*": "./src/tables/*.ts" },
    }),
    "packages/db/src/schema.ts":
      "import { timestamps } from './timestamps.js';\nexport const schema = { timestamps };\n",
    "packages/db/src/timestamps.ts":
      "export const timestamps = { createdAt: 'DATABASE DEFAULT' };\n",
    "packages/db/src/tables/policy.ts":
      "export const columns = ['organizationId', 'revision', 'mode'];\n",
    "apps/api/src/service.ts":
      "import { schema } from '@example/db/schema';\nimport { columns } from '@example/db/tables/policy';\nimport { helper } from '@/helper';\nexport const result = helper(schema, columns);\n",
    "apps/api/src/helper.ts": "export function helper(...args: unknown[]) { return args; }\n",
    "apps/api/src/__tests__/service.test.ts":
      "test('partial failure preserves cached rows', () => {});\n",
  };
  for (const [path, content] of Object.entries(files)) writeFile(dir, path, content);
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "context", "--quiet");
  return dir;
}

it("provides actual exports, tests and transitive schema evidence from the review ref", () => {
  const dir = fixture();
  const sha = git(dir, "rev-parse", "HEAD").trim();
  writeFile(dir, "packages/db/src/schema.ts", "uncommitted misleading content");
  writeFile(dir, "apps/api/src/__tests__/untracked.test.ts", "untracked");
  const context = createRepositoryContext(sha, dir)(["apps/api/src/service.ts"]);
  expect(context.inventory).toContain("apps/api/src/__tests__/service.test.ts");
  expect(context.inventory).not.toContain("untracked.test.ts");
  const files = new Map(context.files.map((f) => [f.path, f.content]));
  expect(files.get("packages/db/package.json")).toContain('"./schema":"./src/schema.ts"');
  expect(files.get("packages/db/src/timestamps.ts")).toContain("DATABASE DEFAULT");
  expect(files.get("packages/db/src/tables/policy.ts")).toContain("'revision', 'mode'");
  expect(files.get("apps/api/src/helper.ts")).toContain("export function helper");
  expect(files.get("apps/api/src/__tests__/service.test.ts")).toContain("partial failure");
  expect([...files.values()].join("\n")).not.toContain("uncommitted misleading");
});

it("bounds context and makes omitted files explicit rather than claiming they are absent", () => {
  const dir = fixture();
  writeFile(dir, "apps/api/src/huge.ts", "x".repeat(100_000));
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "huge", "--quiet");
  const context = createRepositoryContext(
    "HEAD",
    dir,
  )(["apps/api/src/huge.ts", "apps/api/src/service.ts"]);
  expect(context.files.reduce((n, f) => n + Buffer.byteLength(f.content), 0)).toBeLessThanOrEqual(
    32768,
  );
  expect(context.files.some((f) => f.path.endsWith("huge.ts"))).toBe(false);
  expect(context.omitted).toContain("apps/api/src/huge.ts");
  expect(context.inventory).toContain("apps/api/src/huge.ts");
});

it("fails open with explicitly unavailable context when the review ref cannot be read", () => {
  const context = createRepositoryContext("missing-ref", fixture())(["src/a.ts"]);
  expect(context.files).toEqual([]);
  expect(context.inventory).toContain("unavailable");
});

it("does not list a deleted changed file as present in the reviewed tree", () => {
  const context = createRepositoryContext("HEAD", fixture())(["deleted.ts"]);
  expect(context.inventory).not.toContain('"deleted.ts"');
  expect(context.omitted).toContain("deleted.ts");
});

it("reads fully visible source for imports without emitting a duplicate copy", () => {
  const dir = fixture();
  const source = "void 0;\n".repeat(1600);
  writeFile(dir, "new.ts", source);
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "new", "--quiet");
  const diff =
    "diff --git a/new.ts b/new.ts\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,1600 @@\n" +
    Array.from({ length: 1600 }, (_, i) => `L${i + 1}: +void 0;\n`).join("");
  const context = createRepositoryContext("HEAD", dir)(["new.ts"], diff);
  expect(context.files.some((file) => file.path === "new.ts")).toBe(false);
});

// ── The narrowed sibling-test scan ─────────────────────────────────────────────
// createRepositoryContext used to spread the FULL `git ls-tree` listing and run three
// `startsWith` per entry, once per changed path, once per package (and again per retry
// and per bisected half). `testLikePaths` narrows that scan to once per review. These
// assert the narrowing selects exactly the same paths — a differential test against
// the original prefix match over a real tree, not a restatement of the new code.

/** A tree whose test-like paths sit among look-alikes the prefixes must NOT match. */
function siblingTestTree(): string {
  const dir = setupGitRepo();
  repos.push(dir);
  const files: Record<string, string> = {
    "apps/api/package.json": JSON.stringify({ name: "@example/api" }),
    "apps/api/src/service.ts": "export const service = 1;\n",
    // Match: `<dir>/__tests__/<stem>.` — any extension, fixtures included.
    "apps/api/src/__tests__/service.test.ts": "test('service', () => {});\n",
    "apps/api/src/__tests__/service.fixture.ts": "export const rows = [];\n",
    // Match: `<dir>/<stem>.test.` and `<dir>/<stem>.spec.`
    "apps/api/src/service.test.ts": "test('sibling', () => {});\n",
    "apps/api/src/service.spec.ts": "test('spec sibling', () => {});\n",
    // Match: the prefix is not anchored at the end, so a backup suffix rides along.
    "apps/api/src/service.test.ts.bak": "stale\n",
    // No match: helper, other stem, other dir, nested dir, look-alike names.
    "apps/api/src/service.helper.ts": "export const helper = 1;\n",
    "apps/api/src/__tests__/other.test.ts": "test('other', () => {});\n",
    "apps/api/service.test.ts": "test('wrong dir', () => {});\n",
    "apps/api/src/nested/service.test.ts": "test('nested', () => {});\n",
    "apps/api/src/myservice.test.ts": "test('longer stem', () => {});\n",
    "apps/api/src/service.testing.ts": "export const testing = 1;\n",
  };
  for (const [path, content] of Object.entries(files)) writeFile(dir, path, content);
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "sibling tests", "--quiet");
  return dir;
}

/** The tree's regular-file blob paths, parsed exactly as createRepositoryContext does. */
function trackedFiles(dir: string, ref: string): string[] {
  return git(dir, "ls-tree", "-r", "-z", "--full-tree", ref)
    .split("\0")
    .flatMap((entry) => {
      const tab = entry.indexOf("\t");
      return /^100(?:644|755) blob /.test(entry) && tab >= 0 ? [entry.slice(tab + 1)] : [];
    });
}

/** The three prefixes createRepositoryContext matches, rebuilt verbatim per changed path. */
function siblingTestMatches(changed: readonly string[]): Array<(p: string) => boolean> {
  return changed.map((path) => {
    const dir = posix.dirname(path);
    const stem = posix.basename(path).replace(/\.[^.]+$/, "");
    return (p: string): boolean =>
      p.startsWith(`${dir}/__tests__/${stem}.`) ||
      p.startsWith(`${dir}/${stem}.test.`) ||
      p.startsWith(`${dir}/${stem}.spec.`);
  });
}

const SELECTED = ["apps/api/src/service.test.ts", "apps/api/src/service.spec.ts"];
const NOT_SELECTED = [
  "apps/api/src/service.helper.ts",
  "apps/api/src/__tests__/other.test.ts",
  "apps/api/service.test.ts",
  "apps/api/src/nested/service.test.ts",
  "apps/api/src/myservice.test.ts",
  "apps/api/src/service.testing.ts",
];

it("narrows the tree scan without changing which sibling tests the prefixes select", () => {
  const dir = siblingTestTree();
  const paths = trackedFiles(dir, "HEAD");
  const changed = ["apps/api/src/service.ts", "apps/api/src/nested/service.ts"];
  const matches = siblingTestMatches(changed);

  const unfiltered = paths.filter((p) => matches.some((m) => m(p)));
  const narrow = testLikePaths(paths);

  // The narrowing really drops most of the tree — otherwise it proves nothing.
  expect(narrow.length).toBeLessThan(paths.length);
  // Invariant: nothing a prefix can match is filtered out…
  for (const p of unfiltered) expect(narrow).toContain(p);
  // …so running the SAME prefixes over the narrowed list is byte-identical.
  expect(narrow.filter((p) => matches.some((m) => m(p)))).toEqual(unfiltered);
  expect(unfiltered.sort()).toEqual([
    "apps/api/src/__tests__/service.fixture.ts",
    "apps/api/src/__tests__/service.test.ts",
    "apps/api/src/nested/service.test.ts",
    "apps/api/src/service.spec.ts",
    "apps/api/src/service.test.ts",
    "apps/api/src/service.test.ts.bak",
  ]);
});

it("attaches the same sibling tests end to end, look-alikes excluded", () => {
  const dir = siblingTestTree();
  const context = createRepositoryContext("HEAD", dir)(["apps/api/src/service.ts"]);
  const seen = new Set([...context.files.map((f) => f.path), ...context.omitted]);
  for (const path of SELECTED) expect(seen).toContain(path);
  for (const path of NOT_SELECTED) expect(seen).not.toContain(path);
});

it("scans the tree once per review, not once per changed path", () => {
  // A real 20 000-path tree built with git plumbing (one shared blob, nothing on
  // disk) — the monorepo shape the scan used to be quadratic in. `MAX_CANDIDATES`
  // caps the changed paths per call at 96, so the closure is called repeatedly the
  // way the pipeline calls it: once per package, retry and bisected half.
  const dir = setupGitRepo();
  repos.push(dir);
  writeFile(dir, "seed.ts", "export const seed = 1;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "seed", "--quiet");
  const blob = git(dir, "rev-parse", "HEAD:seed.ts").trim();
  const indexInfo = Array.from(
    { length: 20_000 },
    (_, i) => `100644 ${blob} 0\tvendor/pkg${i % 200}/file${i}.ts`,
  ).join("\n");
  execFileSync("git", ["update-index", "--index-info"], { cwd: dir, input: indexInfo });
  const ref = git(
    dir,
    "commit-tree",
    git(dir, "write-tree").trim(),
    "-p",
    git(dir, "rev-parse", "HEAD").trim(),
    "-m",
    "wide",
  ).trim();

  const changed = Array.from({ length: 96 }, (_, i) => `vendor/pkg${i}/file${i}.ts`);
  const context = createRepositoryContext(ref, dir);
  const started = performance.now();
  for (let call = 0; call < 20; call++) context(changed);
  const elapsed = performance.now() - started;

  // Measured on this shape: 95 ms narrowed vs 4 376 ms re-spreading the 20 000-path
  // tree per changed path — a 46× gap. The bound sits ~20× above the former so a slow
  // runner cannot flake it, and ~2× below the latter so the regression still trips it
  // (the slower the runner, the harder it trips).
  expect(elapsed).toBeLessThan(2_000);
  expect(context(changed).inventory).toContain("vendor/pkg0/file0.ts");
});
