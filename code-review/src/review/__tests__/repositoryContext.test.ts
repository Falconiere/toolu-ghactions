import { afterEach, expect, it } from "vitest";
import { createRepositoryContext } from "../repositoryContext.js";
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
