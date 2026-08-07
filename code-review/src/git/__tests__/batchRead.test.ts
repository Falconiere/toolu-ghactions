// batchRead against REAL scratch git repos (no mocks): the `git cat-file
// --batch-check` / `--batch` wire protocol as git actually speaks it. The cases
// here are the ones that break record framing if mishandled — a MISSING object
// (a gitlink, or a path absent at the ref) emits a one-line `<spec> missing`
// record with no content and no trailing LF, and a blob larger than the content
// bound still occupies its full `size + 1` bytes on the stream.
import { describe, it, expect, afterEach } from "vitest";
import { batchRead, MAX_BLOB_READ_BYTES } from "@/git/batchRead.js";
import { git, setupGitRepo, writeFile, removeRepo } from "./helpers.js";

const repos: string[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) removeRepo(r);
});

/** A repo holding `files` committed on main; returns its dir. */
function repoWith(files: Record<string, string>): string {
  const dir = setupGitRepo();
  repos.push(dir);
  for (const [path, content] of Object.entries(files)) writeFile(dir, path, content);
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "files", "--quiet");
  return dir;
}

/** A commit sha no object in this repo has — a gitlink pointing outside the clone. */
const ABSENT_COMMIT = "0123456789abcdef0123456789abcdef01234567";

describe("batchRead — missing objects", () => {
  // A gitlink (mode 160000) records a COMMIT sha that lives in the submodule's
  // own object database, not this one. `HEAD:<gitlink>` therefore reports
  // `missing`, and the reader must answer null for it without throwing and
  // without losing framing for the specs on either side of it.
  it("returns a null entry for a gitlink and still reads its siblings", () => {
    const dir = repoWith({ "a.txt": "alpha\n", "b.txt": "beta\n" });
    git(dir, "update-index", "--add", "--cacheinfo", `160000,${ABSENT_COMMIT},sub`);
    git(dir, "commit", "-m", "add gitlink", "--quiet");
    // The gitlink is a real tree entry: the diff layer will hand its path to batchRead.
    expect(git(dir, "ls-tree", "HEAD")).toContain(`160000 commit ${ABSENT_COMMIT}\tsub`);

    const results = batchRead(
      [
        { ref: "HEAD", path: "a.txt" },
        { ref: "HEAD", path: "sub" },
        { ref: "HEAD", path: "b.txt" },
      ],
      dir,
      { sizeCutoff: 1_000_000 },
    );

    expect(results.get("sub")).toEqual({ size: null, content: null });
    // Framing held: the specs BEFORE and AFTER the missing record both decode.
    expect(results.get("a.txt")).toEqual({ size: 6, content: "alpha\n" });
    expect(results.get("b.txt")).toEqual({ size: 5, content: "beta\n" });
  });

  it("returns a null entry for a path absent at the ref and still reads its siblings", () => {
    const dir = repoWith({ "a.txt": "alpha\n", "b.txt": "beta\n" });
    const results = batchRead(
      [
        { ref: "HEAD", path: "a.txt" },
        { ref: "HEAD", path: "nope/gone.ts" },
        { ref: "HEAD", path: "b.txt" },
      ],
      dir,
      { sizeCutoff: 1_000_000 },
    );

    expect(results.get("nope/gone.ts")).toEqual({ size: null, content: null });
    expect(results.get("a.txt")?.content).toBe("alpha\n");
    expect(results.get("b.txt")?.content).toBe("beta\n");
  });

  it("reports every spec as missing when they all are, rather than throwing", () => {
    const dir = repoWith({ "a.txt": "alpha\n" });
    const results = batchRead([{ ref: "HEAD", path: "nope.ts" }], dir, { sizeCutoff: 1_000_000 });
    expect(results.get("nope.ts")).toEqual({ size: null, content: null });
  });
});

describe("batchRead — record framing past the content bound", () => {
  // A blob over the content bound is TRUNCATED in what we keep but fully consumed
  // off the stream; if it were not, every later record would decode from the
  // wrong offset and read as garbage.
  it("truncates an oversized blob's content yet keeps the next records in sync", () => {
    const big = "x".repeat(MAX_BLOB_READ_BYTES + 5000) + "\n";
    const dir = repoWith({ "big.txt": big, "after.txt": "after\n", "last.txt": "last\n" });

    const results = batchRead(
      [
        { ref: "HEAD", path: "big.txt" },
        { ref: "HEAD", path: "after.txt" },
        { ref: "HEAD", path: "last.txt" },
      ],
      dir,
      { sizeCutoff: 1_000_000 },
    );

    expect(results.get("big.txt")?.size).toBe(Buffer.byteLength(big, "utf8"));
    expect(results.get("big.txt")?.content).toHaveLength(MAX_BLOB_READ_BYTES);
    expect(results.get("after.txt")).toEqual({ size: 6, content: "after\n" });
    expect(results.get("last.txt")).toEqual({ size: 5, content: "last\n" });
  });

  it("records the size but no content for a blob over the size cutoff", () => {
    const dir = repoWith({ "big.txt": "x".repeat(2000) + "\n", "small.txt": "small\n" });
    const results = batchRead(
      [
        { ref: "HEAD", path: "big.txt" },
        { ref: "HEAD", path: "small.txt" },
      ],
      dir,
      { sizeCutoff: 100 },
    );

    expect(results.get("big.txt")).toEqual({ size: 2001, content: null });
    expect(results.get("small.txt")).toEqual({ size: 6, content: "small\n" });
  });
});
