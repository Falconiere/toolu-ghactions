// bisect.test.ts — review/bisect.ts's DISPATCH discipline: every model call it
// issues is gated on the same wall clock, and a run past MAX_WALL_MS never buys a
// fresh call. chunked.test.ts already covers the split/coverage arithmetic through
// reviewChunked; this drives `reviewPackage` directly so the exact number of calls
// on a single package is pinned, with the deadline manipulated between them.
//
// Real data: the segments come from a real temp git repo's real diff (splitDiffByFile
// over `fetchDiff`), not hand-written strings — the same shape reviewChunked packs.
import { afterEach, describe, expect, it } from "vitest";
import { reviewPackage, type PackageReviewContext } from "@/review/bisect.js";
import { splitDiffByFile, type FileSegment } from "@/git/chunk.js";
import { fetchDiff } from "@/git/diff.js";
import type { CoverageEntry } from "@/review/ledger.js";
import type { ProviderResult } from "@/llm/reviewWithModel.js";
import type { Envelope } from "@/prompt.js";
import { git, setupGitRepo, writeFile, removeRepo } from "@/git/__tests__/helpers.js";

const repos: string[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) removeRepo(r);
});

const APPROVED: ProviderResult = { verdict: "approved", findings: [] };
const SCHEMA_FAIL: ProviderResult = {
  verdict: "error",
  findings: [],
  error: "response did not match the schema",
  failure: "schema",
};
const TIMEOUT_FAIL: ProviderResult = {
  verdict: "error",
  findings: [],
  error: "the provider timed out",
  failure: "timeout",
};
const TRANSPORT_FAIL: ProviderResult = {
  verdict: "error",
  findings: [],
  error: "upstream refused",
  failure: "transport",
};

/** Real per-file segments from a real repo: one commit adding `paths`. */
function segmentsFor(paths: string[]): FileSegment[] {
  const dir = setupGitRepo();
  repos.push(dir);
  git(dir, "checkout", "-b", "feature", "--quiet");
  for (const path of paths) {
    const slug = path.replace(/\W/g, "_");
    const body = Array.from({ length: 10 }, (_, n) => `export const ${slug}_${n} = ${n}`).join(
      "\n",
    );
    writeFile(dir, path, `${body}\n`);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "c", "--quiet");
  const diff = fetchDiff({
    baseBranch: "main",
    githubBaseRef: "main",
    cwd: dir,
    maxFiles: 0,
    maxDiffLines: 0,
  });
  return splitDiffByFile(diff.diff);
}

/** What one exercise of `reviewPackage` recorded. */
interface Run {
  /** The file list of every envelope reviewed, in call order. */
  calls: string[][];
  coverage: Map<string, CoverageEntry>;
}

/**
 * Drive `reviewPackage` over `segments` with a scripted `review`. The envelope's
 * `user` is the chunk's path list, so a call's identity IS the files it reviewed.
 * `onCall` runs after each call is scripted — the seam a test uses to expire the
 * wall clock partway through.
 */
async function runPackage(
  segments: FileSegment[],
  script: (paths: string[], n: number) => ProviderResult,
  wallDeadline: () => number | undefined,
  onCall?: (n: number) => void,
): Promise<{ results: ProviderResult[]; run: Run }> {
  const run: Run = { calls: [], coverage: new Map() };
  const ctx: PackageReviewContext = {
    buildEnvelope: (segs): Envelope => ({
      system: "s",
      user: segs.map((s) => s.path).join(","),
      max_tokens: 4096,
      enforce_json_schema: true,
    }),
    review: async (env) => {
      const paths = env.user.split(",");
      const n = run.calls.length;
      run.calls.push(paths);
      const result = script(paths, n);
      onCall?.(n);
      return result;
    },
    onCoverage: (path, entry) => run.coverage.set(path, entry),
    get wallDeadline(): number | undefined {
      return wallDeadline();
    },
  };
  const results = await reviewPackage(ctx, segments, [], 0);
  return { results, run };
}

describe("reviewPackage — the depth-0 retry obeys the wall clock", () => {
  // The control for the guard: same package, same failure, deadline in the future →
  // today's behavior (first pass + exactly one retry) is untouched.
  it("spends first-pass + one retry on a timeout failure when the deadline is in the future", async () => {
    const segments = segmentsFor(["p/a.ts", "p/b.ts"]);
    const future = Date.now() + 60_000;
    const { results, run } = await runPackage(
      segments,
      () => TIMEOUT_FAIL,
      () => future,
    );

    expect(run.calls).toHaveLength(2);
    expect(run.calls[0]).toEqual(run.calls[1]); // the identical envelope, re-issued
    expect(results).toHaveLength(1);
    expect(results[0]?.verdict).toBe("error");
    for (const seg of segments) {
      expect(run.coverage.get(seg.path)).toEqual({ status: "unreviewed" });
    }
  });

  it("does NOT retry a timeout failure once the wall deadline has passed (no fresh call)", async () => {
    const segments = segmentsFor(["p/a.ts", "p/b.ts"]);
    const expired = Date.now() - 1;
    const { results, run } = await runPackage(
      segments,
      () => TIMEOUT_FAIL,
      () => expired,
    );

    // The whole point: exactly ONE call. A run already past MAX_WALL_MS must not
    // buy another model call on a package that just failed.
    expect(run.calls).toHaveLength(1);
    expect(results).toEqual([TIMEOUT_FAIL]);
    // The package WAS attempted and failed, so its files are unreviewed (not
    // pending, which means never attempted) — both lists resume next round.
    for (const seg of segments) {
      expect(run.coverage.get(seg.path)).toEqual({ status: "unreviewed" });
    }
  });

  it("does NOT retry a transport failure once the deadline has passed either", async () => {
    const segments = segmentsFor(["p/a.ts", "p/b.ts"]);
    const { results, run } = await runPackage(
      segments,
      () => TRANSPORT_FAIL,
      () => Date.now() - 1,
    );
    expect(run.calls).toHaveLength(1);
    expect(results).toEqual([TRANSPORT_FAIL]);
  });

  it("does NOT retry when the deadline expires DURING the first call", async () => {
    // The realistic shape: the run had time when the package was dispatched and ran
    // out while the provider was stalling. The call in flight always finishes; the
    // retry it would have earned is not dispatched.
    const segments = segmentsFor(["p/a.ts", "p/b.ts"]);
    let deadline = Date.now() + 60_000;
    const { run } = await runPackage(
      segments,
      () => TIMEOUT_FAIL,
      () => deadline,
      () => {
        deadline = Date.now() - 1;
      },
    );
    expect(run.calls).toHaveLength(1);
  });

  it("still retries a single-segment schema failure while time remains (unbisectable, depth 0)", async () => {
    // A one-file package cannot split, so a schema failure falls through to the same
    // retry — the guard must not have swallowed that path.
    const segments = segmentsFor(["p/only.ts"]);
    const { run } = await runPackage(
      segments,
      (_paths, n) => (n === 0 ? SCHEMA_FAIL : APPROVED),
      () => Date.now() + 60_000,
    );
    expect(run.calls).toHaveLength(2);
    expect(run.coverage.get("p/only.ts")).toEqual({ status: "reviewed" });
  });
});

describe("reviewPackage — the mid-bisection deadline recheck", () => {
  it("ledgers the SECOND half pending when the deadline expires between halves, keeping the first's results", async () => {
    const segments = segmentsFor(["p/a.ts", "p/b.ts", "p/c.ts", "p/d.ts"]);
    let deadline = Date.now() + 60_000;

    const { results, run } = await runPackage(
      segments,
      (paths, n) => {
        // Call 0 is the whole package: schema-fail it so it bisects into two halves.
        if (n === 0) return SCHEMA_FAIL;
        return {
          verdict: "changes",
          findings: [{ path: paths[0] ?? "", line: 1, severity: "low", text: "nit" }],
        };
      },
      () => deadline,
      (n) => {
        // Time runs out while the FIRST half is in flight, so the second half is
        // never dispatched — the recheck happens between halves, not mid-call.
        if (n === 1) deadline = Date.now() - 1;
      },
    );

    // Whole package + first half only: the second half cost zero calls.
    expect(run.calls).toHaveLength(2);
    expect(run.calls[0]).toEqual(["p/a.ts", "p/b.ts", "p/c.ts", "p/d.ts"]);
    expect(run.calls[1]).toEqual(["p/a.ts", "p/b.ts"]);

    // The first half's work is KEPT — a timed-out bisection still reports what it read.
    expect(run.coverage.get("p/a.ts")).toEqual({ status: "reviewed" });
    expect(run.coverage.get("p/b.ts")).toEqual({ status: "reviewed" });
    expect(results.flatMap((r) => r.findings.map((f) => f.path))).toEqual(["p/a.ts"]);

    // The unattempted half is pending (resumable), never unreviewed.
    expect(run.coverage.get("p/c.ts")).toEqual({ status: "pending" });
    expect(run.coverage.get("p/d.ts")).toEqual({ status: "pending" });
  });

  it("attempts neither half when the deadline expires during the whole-package call", async () => {
    const segments = segmentsFor(["p/a.ts", "p/b.ts", "p/c.ts", "p/d.ts"]);
    let deadline = Date.now() + 60_000;

    const { run } = await runPackage(
      segments,
      () => SCHEMA_FAIL,
      () => deadline,
      () => {
        deadline = Date.now() - 1;
      },
    );

    // One call: the package failed on schema, bisected, and BOTH halves hit the
    // expired deadline. Nothing beyond the original dispatch was spent.
    expect(run.calls).toHaveLength(1);
    for (const seg of segments) {
      expect(run.coverage.get(seg.path)).toEqual({ status: "pending" });
    }
  });
});
