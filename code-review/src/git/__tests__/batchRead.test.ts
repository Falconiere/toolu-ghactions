// batchRead against REAL scratch git repos (no mocks): the `git cat-file
// --batch-check` / `--batch` wire protocol as git actually speaks it. The cases
// here are the ones that break record framing if mishandled — a MISSING object
// (a gitlink, or a path absent at the ref) emits a one-line `<spec> missing`
// record with no content and no trailing LF, and a blob larger than the content
// bound still occupies its full `size + 1` bytes on the stream.
import { describe, it, expect, afterEach } from "vitest";
import { batchRead, groupByByteBudget, MAX_BLOB_READ_BYTES } from "@/git/batchRead.js";
import {
  git,
  setupGitRepo,
  writeFile,
  removeRepo,
  canCreateFile,
  installGitShim,
  readSpawnLog,
  resetSpawnLog,
} from "./helpers.js";

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

// A path may legally contain a REAL newline, and `src/git/path.ts` deliberately
// decodes git's `"evil\nx.ts"` spelling back into one — so such a path reaches
// `specKey`. The batch protocol's stdin is LINE-delimited, so one such spec
// arrives as two lines and git answers with two records: every later spec is
// then matched positionally to its NEIGHBOUR's size and content (a real source
// file inheriting another's >1MB size is dropped as large-file; inheriting
// another's `@generated` header is dropped as generated). Verified against git
// 2.54: 3 specs → 4 records.
describe("batchRead — a path containing a real newline", () => {
  it.skipIf(!canCreateFile("evil\nx.ts"))(
    "leaves the newline-named path unread yet keeps every other spec's own size and content",
    () => {
      const dir = repoWith({
        "README.md": "readme\n",
        "evil\nx.ts": "evil\n",
        LICENSE: "lic\n",
        "src/app.ts": "app\n",
      });
      // Git really did track the awkward name, so this is a genuine 4-spec batch.
      expect(git(dir, "ls-tree", "-r", "--name-only", "HEAD")).toContain("x.ts");

      const results = batchRead(
        [
          { ref: "HEAD", path: "README.md" },
          { ref: "HEAD", path: "evil\nx.ts" },
          { ref: "HEAD", path: "LICENSE" },
          { ref: "HEAD", path: "src/app.ts" },
        ],
        dir,
        { sizeCutoff: 1_000_000 },
      );

      // The offender is unreadable by construction and FAILS SAFE: with no size
      // and no content, noiseReason still applies every PATH rule and the file
      // is reviewed rather than silently dropped as large-file/generated.
      expect(results.get("evil\nx.ts")).toEqual({ size: null, content: null });
      // Framing held for the specs on BOTH sides of the offender — pre-fix,
      // LICENSE read as missing and src/app.ts inherited LICENSE's "lic\n".
      expect(results.get("README.md")).toEqual({ size: 7, content: "readme\n" });
      expect(results.get("LICENSE")).toEqual({ size: 4, content: "lic\n" });
      expect(results.get("src/app.ts")).toEqual({ size: 4, content: "app\n" });
    },
  );
});

// The per-blob cutoff bounds ONE blob; nothing bounded the TOTAL. One `--batch`
// over ~1500 files of ~700 KB each (CSV/JSON fixtures, a docs import — no noise
// rule matches, all under LARGE_FILE_BYTES) produces ~1 GB of stdout, so
// execFileSync threw `spawnSync git ENOBUFS` out of fetchDiff BEFORE the
// MAX_FILES gate could run. Grouping is tested on its own terms here — a real
// 1 GB fixture would be absurd — plus one small real repo forced into several
// groups by a tiny budget, proving the byte-walk stays correct across them.
describe("batchRead — byte-budget grouping", () => {
  it("packs consecutive specs into groups that each stay under the budget", () => {
    const groups = groupByByteBudget([6, 5, 6, 6, 4], (n) => n, 12);
    expect(groups).toEqual([[6, 5], [6, 6], [4]]);
  });

  it("keeps spec ORDER, so a group is always a contiguous slice of the input", () => {
    const groups = groupByByteBudget([1, 2, 3, 4], (n) => n, 4);
    expect(groups).toEqual([[1, 2], [3], [4]]);
    expect(groups.flat()).toEqual([1, 2, 3, 4]);
  });

  it("gives a spec larger than the whole budget its own group rather than dropping it", () => {
    // Dropping it would silently lose that blob's content; the caller's
    // maxBuffer (1 GiB) sits far above any single within-cutoff blob.
    expect(groupByByteBudget([5, 99, 5], (n) => n, 12)).toEqual([[5], [99], [5]]);
  });

  it("yields no groups for an empty input", () => {
    expect(groupByByteBudget<number>([], (n) => n, 12)).toEqual([]);
  });

  it("reads every path's own size and content across multiple real --batch groups", () => {
    const dir = repoWith({
      "a.txt": "alpha\n", // 6
      "b.txt": "beta\n", // 5 → group 1 at 11/12
      "c.txt": "gamma\n", // 6 → would be 17, opens group 2
      "d.txt": "delta\n", // 6 → group 2 at 12/12
      "e.txt": "eps\n", // 4 → opens group 3
      "src/over.txt": "z".repeat(400) + "\n", // 401 → over the SIZE cutoff, never grouped
    });

    const specs = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt", "src/over.txt"].map((path) => ({
      ref: "HEAD",
      path,
    }));

    const shim = installGitShim();
    let results: ReturnType<typeof batchRead>;
    let argvs: string[][];
    try {
      resetSpawnLog(shim);
      // A budget of 12 bytes forces three separate `git cat-file --batch` runs.
      results = batchRead(specs, dir, { sizeCutoff: 100, maxGroupBytes: 12 });
      // Read the log before uninstall deletes the directory it lives in.
      argvs = readSpawnLog(shim);
    } finally {
      shim.uninstall();
    }

    const batchRuns = argvs.filter((a) => a.includes("--batch"));
    expect(batchRuns).toHaveLength(3);
    expect(argvs.filter((a) => a.includes("--batch-check"))).toHaveLength(1);

    expect(results.get("a.txt")).toEqual({ size: 6, content: "alpha\n" });
    expect(results.get("b.txt")).toEqual({ size: 5, content: "beta\n" });
    expect(results.get("c.txt")).toEqual({ size: 6, content: "gamma\n" });
    expect(results.get("d.txt")).toEqual({ size: 6, content: "delta\n" });
    expect(results.get("e.txt")).toEqual({ size: 4, content: "eps\n" });
    // The size cutoff still wins: sized, but never content-read.
    expect(results.get("src/over.txt")).toEqual({ size: 401, content: null });
  });
});
