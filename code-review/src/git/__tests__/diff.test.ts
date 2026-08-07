import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchDiff } from "@/git/diff.js";
import { splitDiffByFile } from "@/git/chunk.js";
import { readFileAt } from "@/pipeline/git.js";
import { git, setupGitRepo, writeFile, removeRepo, makeTmpDir, canCreateFile } from "./helpers.js";

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

describe("fetchDiff — batched blob classification (src/git/batchRead.ts)", () => {
  it("drops a >1MB blob as large-file end-to-end (batched cat-file --batch-check size)", () => {
    const dir = featureRepo();
    const big = Array.from({ length: 120_000 }, (_, i) => `const x${i} = ${i};`).join("\n") + "\n";
    expect(Buffer.byteLength(big, "utf8")).toBeGreaterThan(1_000_000);
    writeFile(dir, "data/generated-blob.ts", big);
    writeFile(dir, "src/app.ts", "export const x = 1\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "big blob + real code", "--quiet");

    const r = fetchDiff({ ...BASE, cwd: dir, maxFiles: 0, maxDiffLines: 8000 });
    expect(r.dropped_files.find((d) => d.path === "data/generated-blob.ts")?.reason).toBe(
      "large-file",
    );
    expect(r.changed_files).toEqual(["src/app.ts"]);
  });

  it("drops a hash-named minified file end-to-end (batched cat-file --batch bounded content)", () => {
    const dir = featureRepo();
    const longLine = "z".repeat(6000);
    // Not under a build-output/vendored dir, so only the content rule can catch it —
    // this exercises the real batchRead content read, not a path-only static rule.
    writeFile(dir, "web/assets/bundle-Qcc39ab.js", `${longLine}\n`);
    writeFile(dir, "src/app.ts", "export const x = 1\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "minified bundle + real code", "--quiet");

    const r = fetchDiff({ ...BASE, cwd: dir, maxFiles: 0, maxDiffLines: 8000 });
    expect(r.dropped_files.find((d) => d.path === "web/assets/bundle-Qcc39ab.js")?.reason).toBe(
      "minified",
    );
    expect(r.changed_files).toEqual(["src/app.ts"]);
  });

  it("end-to-end: a long line past the 64 KiB bound is NOT flagged minified (intentional parity break)", () => {
    const dir = featureRepo();
    const filler = Array.from({ length: 4000 }, (_, i) => `const x${i} = ${i};`).join("\n") + "\n";
    const longLine = "z".repeat(6000);
    const content = `${filler}${longLine}\n`;
    expect(Buffer.byteLength(content, "utf8")).toBeGreaterThan(65536);
    expect(Buffer.byteLength(content, "utf8")).toBeLessThan(1_000_000);
    // Hash-suffixed but NOT under a build-output dir, so only the content rule applies.
    writeFile(dir, "sdk/gen-Qcc39ab.js", content);
    writeFile(dir, "src/app.ts", "export const x = 1\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "long-line-past-bound + real code", "--quiet");

    const r = fetchDiff({ ...BASE, cwd: dir, maxFiles: 0, maxDiffLines: 8000 });
    expect(r.dropped_files.find((d) => d.path === "sdk/gen-Qcc39ab.js")).toBeUndefined();
    expect(r.changed_files).toContain("sdk/gen-Qcc39ab.js");
    expect(r.changed_files).toContain("src/app.ts");
  });

  // Mutation guard for the test above: SAME file size band (64 KiB – 1 MB), same
  // long line, moved BEFORE the 64 KiB bound. The verdict must flip to minified —
  // otherwise "not flagged" would pass for the wrong reason (e.g. content never
  // read at all in this band) and the bounded-content read would be untested.
  it("end-to-end: the same long line BEFORE the 64 KiB bound IS flagged minified", () => {
    const dir = featureRepo();
    const head = Array.from({ length: 1000 }, (_, i) => `const h${i} = ${i};`).join("\n") + "\n";
    const longLine = "z".repeat(6000);
    const tail = Array.from({ length: 4000 }, (_, i) => `const t${i} = ${i};`).join("\n") + "\n";
    const content = `${head}${longLine}\n${tail}`;
    // The long line starts well inside the first 64 KiB...
    expect(Buffer.byteLength(head, "utf8")).toBeLessThan(65536);
    // ...while the file as a whole sits in the same band as the case above.
    expect(Buffer.byteLength(content, "utf8")).toBeGreaterThan(65536);
    expect(Buffer.byteLength(content, "utf8")).toBeLessThan(1_000_000);
    writeFile(dir, "sdk/gen-Qcc39ab.js", content);
    writeFile(dir, "src/app.ts", "export const x = 1\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "long-line-before-bound + real code", "--quiet");

    const r = fetchDiff({ ...BASE, cwd: dir, maxFiles: 0, maxDiffLines: 8000 });
    expect(r.dropped_files.find((d) => d.path === "sdk/gen-Qcc39ab.js")?.reason).toBe("minified");
    expect(r.changed_files).toEqual(["src/app.ts"]);
  });
});

// Every path git prints is C-quoted when it holds a character git cannot print
// literally. Decoding at the boundary (git/path.ts) is what makes the path usable
// again as a pathspec (`git diff -- <path>`) and as a `git show <ref>:<path>`
// operand — without it these files reach the review with no diff text at all.
describe("fetchDiff — C-quoted paths decode to real paths", () => {
  /** Commit `files` on a feature branch and fetch the diff. */
  function diffOver(files: Record<string, string>): {
    dir: string;
    r: ReturnType<typeof fetchDiff>;
  } {
    const dir = featureRepo();
    for (const [path, content] of Object.entries(files)) writeFile(dir, path, content);
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "special-character paths", "--quiet");
    return { dir, r: fetchDiff({ ...BASE, cwd: dir, maxFiles: 0, maxDiffLines: 8000 }) };
  }

  it.skipIf(!canCreateFile('we"ird.ts'))(
    'reports we"ird.ts under its real name, with a real diff segment',
    () => {
      const { dir, r } = diffOver({
        'we"ird.ts': "export const q = 1\n",
        "src/app.ts": "export const x = 1\n",
      });

      // The raw name reaches changed_files — this is what the GitHub API, the
      // coverage ledger, and the state marker all key on.
      expect(r.changed_files.sort()).toEqual(['we"ird.ts', "src/app.ts"].sort());
      expect(r.changed_files.some((p) => p.startsWith('"'))).toBe(false);

      // A real segment exists: the pathspec matched, so the file was actually diffed.
      const segment = splitDiffByFile(r.diff).find((s) => s.path === 'we"ird.ts');
      expect(segment?.diff).toContain("L1: +export const q = 1");
      // shape.ts agrees with chunk.ts on the path, so line anchors resolve.
      expect(r.files.find((f) => f.path === 'we"ird.ts')?.changed_lines).toEqual([1]);
      // And the post-change content reader (oversized-chunk context) resolves it.
      expect(readFileAt("HEAD", dir)('we"ird.ts')).toBe("export const q = 1\n");
    },
  );

  it.skipIf(!canCreateFile("tab\there.ts"))(
    "reports a tab-containing name under its real name, with a real diff segment",
    () => {
      const { dir, r } = diffOver({
        "tab\there.ts": "export const t = 1\n",
        "src/app.ts": "export const x = 1\n",
      });

      expect(r.changed_files).toContain("tab\there.ts");
      const segment = splitDiffByFile(r.diff).find((s) => s.path === "tab\there.ts");
      expect(segment?.diff).toContain("L1: +export const t = 1");
      expect(readFileAt("HEAD", dir)("tab\there.ts")).toBe("export const t = 1\n");
    },
  );

  it.skipIf(!canCreateFile("back\\slash.ts"))(
    "reports a backslash-containing name under its real name",
    () => {
      const { dir, r } = diffOver({ "back\\slash.ts": "export const b = 1\n" });
      expect(r.changed_files).toEqual(["back\\slash.ts"]);
      expect(readFileAt("HEAD", dir)("back\\slash.ts")).toBe("export const b = 1\n");
    },
  );

  it.skipIf(!canCreateFile('mixed日本"x.ts'))(
    "reports a name mixing non-ASCII with a forced-quote character",
    () => {
      // Under core.quotepath=false git quotes this for the `"` while leaving 日本
      // as RAW UTF-8 inside the quotes — the case a per-char-code decoder mangles.
      const { r } = diffOver({ 'mixed日本"x.ts': "export const m = 1\n" });
      expect(r.changed_files).toEqual(['mixed日本"x.ts']);
    },
  );

  it("reports a non-ASCII name under its real name (raw under core.quotepath=false)", () => {
    const { dir, r } = diffOver({ "日本語.txt": "hello\n" });
    expect(r.changed_files).toEqual(["日本語.txt"]);
    expect(splitDiffByFile(r.diff).map((s) => s.path)).toEqual(["日本語.txt"]);
    expect(readFileAt("HEAD", dir)("日本語.txt")).toBe("hello\n");
  });

  it.skipIf(!canCreateFile('renamed"target.ts'))(
    "detects a rename into a quoted path under its real name",
    () => {
      // The original must exist on MAIN for the move to read as a rename against
      // the merge-base rather than an unrelated add.
      const dir = setupGitRepo();
      repos.push(dir);
      writeFile(dir, "src/original.ts", "export const value = 1\n".repeat(8));
      git(dir, "add", "-A");
      git(dir, "commit", "-m", "add original", "--quiet");
      git(dir, "checkout", "-b", "feature", "--quiet");
      git(dir, "mv", "src/original.ts", 'renamed"target.ts');
      git(dir, "commit", "-m", "rename into a quoted path", "--quiet");

      const r = fetchDiff({ ...BASE, cwd: dir, maxFiles: 0, maxDiffLines: 8000 });
      expect(r.changed_files).toContain('renamed"target.ts');
      expect(r.renames).toEqual([{ from: "src/original.ts", to: 'renamed"target.ts' }]);
    },
  );
});
