import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchDiff } from "@/git/diff.js";
import { git, setupGitRepo, writeFile, removeRepo, makeTmpDir } from "./helpers.js";

// REAL temp git repos (no mocks), mirroring the cases in __tests__/fetch-diff.bats.
// No `origin` remote in the fixtures, so the base resolves to the local `main`
// branch — the same fallback the bats tests rely on.

const repos: string[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) removeRepo(r);
});

/** Set up a repo, register it for cleanup, and switch to a feature branch. */
function featureRepo(): string {
  const dir = setupGitRepo();
  repos.push(dir);
  git(dir, "checkout", "-b", "feature", "--quiet");
  return dir;
}

const BASE = { baseBranch: "main", githubBaseRef: "main" } as const;

describe("fetchDiff", () => {
  it("outputs the expected DiffData shape", () => {
    const dir = featureRepo();
    writeFile(dir, "newfile.ts", "export const changed = true\n");
    git(dir, "add", "newfile.ts");
    git(dir, "commit", "-m", "add newfile", "--quiet");

    const r = fetchDiff({ ...BASE, cwd: dir, maxFiles: 100, maxDiffLines: 8000 });
    expect(Array.isArray(r.changed_files)).toBe(true);
    expect(Array.isArray(r.binary_files)).toBe(true);
    expect(Array.isArray(r.dropped_files)).toBe(true);
    expect(Array.isArray(r.files)).toBe(true);
    expect(typeof r.truncated).toBe("boolean");
    expect(typeof r.diff).toBe("string");
    expect(r.total_files).toBeGreaterThanOrEqual(1);
    expect(r.changed_files).toContain("newfile.ts");
  });

  it("emits base_sha as the 40-hex base-branch tip", () => {
    const dir = featureRepo();
    writeFile(dir, "newfile.ts", "changed\n");
    git(dir, "add", "newfile.ts");
    git(dir, "commit", "-m", "add newfile", "--quiet");

    const r = fetchDiff({ ...BASE, cwd: dir, maxFiles: 100, maxDiffLines: 8000 });
    expect(r.base_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(r.base_sha).toBe(git(dir, "rev-parse", "main").trim());
  });

  it("detects binary files and keeps text files", () => {
    const dir = featureRepo();
    writeFile(dir, "text.txt", "text content\n");
    // A NUL byte forces git to treat the file as binary.
    execFileSync("bash", ["-c", `printf 'bin\\x00data' > '${join(dir, "binary.bin")}'`]);
    git(dir, "add", "text.txt", "binary.bin");
    git(dir, "commit", "-m", "add text and binary", "--quiet");

    const r = fetchDiff({ ...BASE, cwd: dir, maxFiles: 100, maxDiffLines: 8000 });
    expect(r.binary_files).toContain("binary.bin");
    expect(r.changed_files).toContain("text.txt");
  });

  it("line-primes the diff and records changed_lines", () => {
    const dir = featureRepo();
    writeFile(dir, "app.ts", "line one\nline two\nline three\n");
    git(dir, "add", "app.ts");
    git(dir, "commit", "-m", "add app.ts", "--quiet");

    const r = fetchDiff({ ...BASE, cwd: dir, maxFiles: 100, maxDiffLines: 8000 });
    expect(r.diff).toMatch(/^L[0-9]+: \+line one$/m);
    const appFile = r.files.find((f) => f.path === "app.ts");
    expect(appFile?.changed_lines.length).toBeGreaterThanOrEqual(3);
  });

  it("drops lockfiles and build output, keeps real source", () => {
    const dir = featureRepo();
    writeFile(dir, "app.ts", "real code\n");
    writeFile(dir, "package-lock.json", '{"lockfileVersion": 3}\n');
    writeFile(dir, "web/dist/assets/index-AbC123.js", "console.log(1)\n");
    writeFile(dir, "src/build/out.js", "generated\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "code + noise", "--quiet");

    const r = fetchDiff({ ...BASE, cwd: dir, maxFiles: 100, maxDiffLines: 8000 });
    const droppedPaths = r.dropped_files.map((d) => d.path);
    expect(droppedPaths).toContain("package-lock.json");
    expect(r.dropped_files.find((d) => d.path === "web/dist/assets/index-AbC123.js")?.reason).toBe(
      "build-output",
    );
    expect(droppedPaths).toContain("src/build/out.js");
    expect(r.changed_files).toContain("app.ts");
    expect(r.changed_files).not.toContain("package-lock.json");
    // Lockfile content must never reach the diff sent to the model.
    expect(r.diff).not.toContain("lockfileVersion");
  });

  it("uses REVIEW_HEAD to diff a non-checked-out ref, not the working HEAD", () => {
    const dir = setupGitRepo();
    repos.push(dir);
    git(dir, "checkout", "-b", "feature", "--quiet");
    writeFile(dir, "review-only.ts", "export const reviewed = true\n");
    git(dir, "add", "review-only.ts");
    git(dir, "commit", "-m", "feature change", "--quiet");
    const featureSha = git(dir, "rev-parse", "HEAD").trim();
    git(dir, "checkout", "main", "--quiet");

    // HEAD vs main is empty; REVIEW_HEAD points at the fetched feature ref.
    expect(git(dir, "diff", "--name-only", "main", "HEAD").trim()).toBe("");

    const r = fetchDiff({
      ...BASE,
      cwd: dir,
      maxFiles: 100,
      maxDiffLines: 8000,
      reviewHead: featureSha,
    });
    expect(r.total_files).toBe(1);
    expect(r.changed_files).toContain("review-only.ts");
    expect(r.diff).toMatch(/^L[0-9]+: \+export const reviewed = true$/m);
  });

  it("keeps real paths for a rename (no arrow) and shows the move AS a rename", () => {
    // Classification runs --no-renames (both real sides listed, never an "old =>
    // new" arrow), while the REVIEW diff runs -M so a pure move carries rename
    // headers instead of re-adding the whole file as `+` lines.
    const dir = setupGitRepo();
    repos.push(dir);
    writeFile(dir, "src/old-name.ts", "export const renamed = true\nexport const stable = 1\n");
    git(dir, "add", "src/old-name.ts");
    git(dir, "commit", "-m", "add old-name", "--quiet");
    git(dir, "checkout", "-b", "feature", "--quiet");
    git(dir, "mv", "src/old-name.ts", "src/new-name.ts");
    git(dir, "commit", "-m", "rename old-name to new-name", "--quiet");

    const r = fetchDiff({ ...BASE, cwd: dir, maxFiles: 100, maxDiffLines: 8000 });

    // Both real paths show up verbatim — no "=>" arrow anywhere in changed_files.
    expect(r.changed_files).toContain("src/new-name.ts");
    expect(r.changed_files.some((p) => p.includes("=>"))).toBe(false);
    expect(r.changed_files).toContain("src/old-name.ts");
    // A pure move is a rename in the review diff — its content is NOT a wall of adds.
    expect(r.diff).toContain("rename from src/old-name.ts");
    expect(r.diff).toContain("rename to src/new-name.ts");
    expect(r.diff).not.toMatch(/^L[0-9]+: \+export const renamed = true$/m);
    expect(r.renames).toContainEqual({ from: "src/old-name.ts", to: "src/new-name.ts" });
  });

  it("returns total_files=0 for a repo with no changes", () => {
    const dir = setupGitRepo();
    repos.push(dir);
    const r = fetchDiff({ ...BASE, cwd: dir, maxFiles: 100, maxDiffLines: 8000 });
    expect(r.total_files).toBe(0);
    expect(r.diff).toBe("");
    expect(r.error).toBeUndefined();
  });

  it("recovers the merge-base from a shallow clone", () => {
    // Origin: main = A-B-C-D; feature branches at B and adds feat.ts.
    const origin = mkdtempSync(join(tmpdir(), "diff-origin-"));
    repos.push(origin);
    git(origin, "init", "--initial-branch=main", "--quiet");
    git(origin, "config", "user.email", "test@test.com");
    git(origin, "config", "user.name", "Test");
    writeFile(origin, "f.txt", "a\n");
    git(origin, "add", "f.txt");
    git(origin, "commit", "-m", "A", "--quiet");
    writeFile(origin, "f.txt", "a\nb\n");
    git(origin, "add", "f.txt");
    git(origin, "commit", "-m", "B", "--quiet");
    git(origin, "checkout", "-b", "feature", "--quiet");
    writeFile(origin, "feat.ts", "export const x = 1\n");
    git(origin, "add", "feat.ts");
    git(origin, "commit", "-m", "E", "--quiet");
    git(origin, "checkout", "main", "--quiet");
    writeFile(origin, "f.txt", "a\nb\nc\n");
    git(origin, "add", "f.txt");
    git(origin, "commit", "-m", "C", "--quiet");
    writeFile(origin, "f.txt", "a\nb\nc\nd\n");
    git(origin, "add", "f.txt");
    git(origin, "commit", "-m", "D", "--quiet");

    // Shallow clone (depth 1) of feature with all remote-tracking refs —
    // mirrors actions/checkout's default fetch-depth: 1, so merge-base is empty.
    const clone = makeTmpDir();
    repos.push(clone);
    git(
      clone,
      "clone",
      "--depth=1",
      "--no-single-branch",
      "--branch",
      "feature",
      `file://${origin}`,
      ".",
    );
    git(clone, "config", "user.email", "test@test.com");
    git(clone, "config", "user.name", "Test");

    expect(git(clone, "rev-parse", "--is-shallow-repository").trim()).toBe("true");
    // Empty before the deepen ladder runs.
    let preMergeBase = "";
    try {
      preMergeBase = git(clone, "merge-base", "HEAD", "origin/main").trim();
    } catch {
      preMergeBase = "";
    }
    expect(preMergeBase).toBe("");

    const r = fetchDiff({ ...BASE, cwd: clone, maxFiles: 100, maxDiffLines: 8000 });
    expect(r.changed_files).toContain("feat.ts");
  });
});

describe("fetchDiff — generated/vendored exclusion + renames", () => {
  it("drops cross-ecosystem generated/vendored/lock files from the reviewed diff", () => {
    const dir = featureRepo();
    writeFile(dir, "src/app.ts", "export const real = 1\n");
    writeFile(dir, "go.sum", "h1:abc=\n");
    writeFile(dir, "node_modules/x/y.js", "module.exports = {}\n");
    writeFile(dir, ".next/server/page.js", "export default 1\n");
    writeFile(dir, "api/svc.pb.go", "package api\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "mix", "--quiet");

    const r = fetchDiff({ ...BASE, cwd: dir, maxFiles: 0, maxDiffLines: 8000 });
    expect(r.changed_files).toEqual(["src/app.ts"]);
    const dropped = r.dropped_files.map((d) => d.path);
    for (const p of ["go.sum", "node_modules/x/y.js", ".next/server/page.js", "api/svc.pb.go"]) {
      expect(dropped).toContain(p);
    }
    expect(r.diff).not.toContain("go.sum");
    expect(r.diff).not.toContain("svc.pb.go");
  });

  it("drops a path marked linguist-generated in .gitattributes (no static match)", () => {
    const dir = featureRepo();
    writeFile(dir, ".gitattributes", "schema/api.yaml linguist-generated\n");
    writeFile(dir, "schema/api.yaml", "openapi: 3.0.0\n");
    writeFile(dir, "src/app.ts", "export const x = 1\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "gen", "--quiet");

    const r = fetchDiff({ ...BASE, cwd: dir, maxFiles: 0, maxDiffLines: 8000 });
    expect(r.changed_files).toContain("src/app.ts");
    expect(r.changed_files).not.toContain("schema/api.yaml");
    expect(r.dropped_files.find((d) => d.path === "schema/api.yaml")?.reason).toBe(
      "generated (.gitattributes)",
    );
  });

  it("drops every linguist-generated path when several are present (NUL -z parse)", () => {
    const dir = featureRepo();
    writeFile(
      dir,
      ".gitattributes",
      "schema/api.yaml linguist-generated\ndist/bundle.js linguist-generated\n",
    );
    writeFile(dir, "schema/api.yaml", "openapi: 3.0.0\n");
    writeFile(dir, "dist/bundle.js", "console.log(1)\n");
    writeFile(dir, "src/app.ts", "export const x = 1\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "gen", "--quiet");

    const r = fetchDiff({ ...BASE, cwd: dir, maxFiles: 0, maxDiffLines: 8000 });
    expect(r.changed_files).toContain("src/app.ts");
    expect(r.changed_files).not.toContain("schema/api.yaml");
    expect(r.changed_files).not.toContain("dist/bundle.js");
  });

  it("EXCLUDE_GLOBS drops matches; defaults keep migrations + snapshots", () => {
    const dir = featureRepo();
    writeFile(dir, "migrations/001.sql", "CREATE TABLE t (id int);\n");
    writeFile(dir, "src/a.snap", "snapshot\n");
    writeFile(dir, "src/app.ts", "export const x = 1\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "files", "--quiet");

    const def = fetchDiff({ ...BASE, cwd: dir, maxFiles: 0, maxDiffLines: 8000 });
    expect(def.changed_files).toContain("migrations/001.sql");
    expect(def.changed_files).toContain("src/a.snap");

    const ex = fetchDiff({
      ...BASE,
      cwd: dir,
      maxFiles: 0,
      maxDiffLines: 8000,
      excludeGlobs: ["migrations/**"],
    });
    expect(ex.changed_files).not.toContain("migrations/001.sql");
    expect(ex.changed_files).toContain("src/app.ts");
    expect(ex.dropped_files.find((d) => d.path === "migrations/001.sql")?.reason).toBe("excluded");
  });

  it("MAX_FILES gates the post-exclusion reviewed count", () => {
    const dir = featureRepo();
    writeFile(dir, "src/app.ts", "export const x = 1\n");
    for (let i = 0; i < 5; i++)
      writeFile(dir, `node_modules/p${i}/index.js`, "module.exports = 1\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "many", "--quiet");

    const r = fetchDiff({ ...BASE, cwd: dir, maxFiles: 2, maxDiffLines: 8000 });
    expect(r.error).toBeUndefined();
    expect(r.changed_files).toEqual(["src/app.ts"]);
  });

  it("detects renames (filtered to kept targets)", () => {
    const dir = setupGitRepo();
    repos.push(dir);
    writeFile(dir, "old.ts", "export const v = 1\n".repeat(8));
    git(dir, "add", "old.ts");
    git(dir, "commit", "-m", "add old", "--quiet");
    git(dir, "checkout", "-b", "feature", "--quiet");
    git(dir, "mv", "old.ts", "new.ts");
    git(dir, "commit", "-m", "rename old -> new", "--quiet");

    const r = fetchDiff({ ...BASE, cwd: dir, maxFiles: 0, maxDiffLines: 8000 });
    expect(r.renames).toContainEqual({ from: "old.ts", to: "new.ts" });
  });

  it("presents a move AS a rename in the review diff, not a delete + add", () => {
    const dir = setupGitRepo();
    repos.push(dir);
    const body = Array.from({ length: 12 }, (_, n) => `pub fn f${n}() {}`).join("\n");
    writeFile(dir, "tests/live/harness.rs", `${body}\n`);
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "add harness", "--quiet");
    git(dir, "checkout", "-b", "feature", "--quiet");
    // Move + one-line edit (rm + re-write, since `git mv` needs the target dir):
    // similarity stays high enough for -M to pair the two paths as a rename.
    git(dir, "rm", "--quiet", "tests/live/harness.rs");
    writeFile(dir, "tests/helpers/live_harness.rs", `${body}\npub fn extra() {}\n`);
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "move harness", "--quiet");

    const r = fetchDiff({ ...BASE, cwd: dir, maxFiles: 0, maxDiffLines: 8000 });
    expect(r.diff).toContain("rename from tests/live/harness.rs");
    expect(r.diff).toContain("rename to tests/helpers/live_harness.rs");
    // The moved body must NOT appear as a wall of additions — only the real edit does.
    const added = r.diff.split("\n").filter((l) => /^L\d+: \+/.test(l));
    expect(added.length).toBeLessThan(5);
    expect(r.renames).toContainEqual({
      from: "tests/live/harness.rs",
      to: "tests/helpers/live_harness.rs",
    });
  });

  it("classifies a DELETED file from the base commit, not HEAD (no fatal blob reads)", () => {
    const dir = setupGitRepo();
    repos.push(dir);
    // Content-classified noise: only detectable by READING the blob — which for a
    // deleted path exists at the merge-base, never at HEAD.
    writeFile(dir, "sdk/client.gen.txt", "// @generated by codegen\nbody\n");
    writeFile(dir, "src/app.ts", "export const x = 1\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "add generated", "--quiet");
    git(dir, "checkout", "-b", "feature", "--quiet");
    git(dir, "rm", "--quiet", "sdk/client.gen.txt");
    writeFile(dir, "src/app.ts", "export const x = 2\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "delete generated", "--quiet");

    const r = fetchDiff({ ...BASE, cwd: dir, maxFiles: 0, maxDiffLines: 8000 });
    // Read from HEAD the blob is missing → the marker is invisible → the deleted
    // generated file would pollute the reviewed diff. From the base it classifies.
    expect(r.dropped_files.find((d) => d.path === "sdk/client.gen.txt")?.reason).toBe("generated");
    expect(r.changed_files).toEqual(["src/app.ts"]);
  });
});
