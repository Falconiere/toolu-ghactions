import { describe, it, expect, afterEach } from "vitest";
import { fetchDiff } from "@/git/diff.js";
import type { DiffData } from "@/git/diff.js";
import { reviewChunked } from "@/review/chunked.js";
import { splitDiffByFile } from "@/git/chunk.js";
import type { Brief } from "@/review/cartographer.js";
import type { CoverageEntry } from "@/review/ledger.js";
import type { ProviderResult } from "@/llm/reviewWithModel.js";
import type { MechanicalFinding } from "@/mechanical/sarif.js";
import type { Envelope } from "@/prompt.js";
import { git, setupGitRepo, writeFile, removeRepo } from "@/git/__tests__/helpers.js";

// REAL temp git repos → real DiffData. buildEnvelope/review are injected so we can
// observe chunking/partition without a network call (the model layer is covered
// elsewhere with recorded fixtures).

const repos: string[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) removeRepo(r);
});

const BASE = { baseBranch: "main", githubBaseRef: "main" } as const;
const APPROVED: ProviderResult = { verdict: "approved", findings: [] };
const STUB_ENVELOPE: Envelope = {
  system: "s",
  user: "u",
  max_tokens: 4096,
  enforce_json_schema: true,
};

/** Build a real DiffData from a feature branch adding the given files. */
function diffWithFiles(specs: Array<{ path: string; lines: number }>): DiffData {
  const dir = setupGitRepo();
  repos.push(dir);
  git(dir, "checkout", "-b", "feature", "--quiet");
  for (const { path, lines } of specs) {
    const slug = path.replace(/\W/g, "_");
    const body = Array.from({ length: lines }, (_, n) => `export const ${slug}_${n} = ${n}`).join(
      "\n",
    );
    writeFile(dir, path, `${body}\n`);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "c", "--quiet");
  return fetchDiff({ ...BASE, cwd: dir, maxFiles: 0, maxDiffLines: 0 });
}

/** A buildEnvelope that records the file paths + mechanical paths it was handed. */
function recordingEnvelope(calls: Array<{ paths: string[]; mech: string[] }>) {
  return (subDiff: DiffData, mechanical: MechanicalFinding[]): Envelope => {
    calls.push({ paths: subDiff.changed_files, mech: mechanical.map((m) => m.path) });
    return STUB_ENVELOPE;
  };
}

describe("reviewChunked", () => {
  it("fast path: a within-budget diff is one review call", async () => {
    const diff = diffWithFiles([{ path: "src/a.ts", lines: 3 }]);
    let calls = 0;
    const result = await reviewChunked({
      diff,
      maxChunkLines: 1500,
      maxChunks: 20,
      mechanical: [],
      brief: null,
      onCoverage: () => {},
      buildEnvelope: () => STUB_ENVELOPE,
      review: async () => {
        calls++;
        return APPROVED;
      },
    });
    expect(calls).toBe(1);
    expect(result.verdict).toBe("approved");
  });

  it("chunking disabled (maxChunkLines=0) stays a single call on a big diff", async () => {
    const diff = diffWithFiles([{ path: "big.ts", lines: 200 }]);
    let calls = 0;
    await reviewChunked({
      diff,
      maxChunkLines: 0,
      maxChunks: 20,
      mechanical: [],
      brief: null,
      onCoverage: () => {},
      buildEnvelope: () => STUB_ENVELOPE,
      review: async () => {
        calls++;
        return APPROVED;
      },
    });
    expect(calls).toBe(1);
  });

  it("splits an over-budget diff into one call per chunk", async () => {
    const diff = diffWithFiles([
      { path: "alpha/big.ts", lines: 30 },
      { path: "omega/big.ts", lines: 30 },
    ]);
    let calls = 0;
    await reviewChunked({
      diff,
      maxChunkLines: 20,
      maxChunks: 20,
      mechanical: [],
      brief: null,
      onCoverage: () => {},
      buildEnvelope: () => STUB_ENVELOPE,
      review: async () => {
        calls++;
        return APPROVED;
      },
    });
    expect(calls).toBe(2);
  });

  it("partitions mechanical findings to their file's chunk; orphans ride chunk[0]", async () => {
    const diff = diffWithFiles([
      { path: "alpha/big.ts", lines: 30 },
      { path: "omega/big.ts", lines: 30 },
    ]);
    const mechanical: MechanicalFinding[] = [
      {
        tool: "opengrep",
        ruleId: "r1",
        path: "alpha/big.ts",
        line: 1,
        severity: "warning",
        message: "in alpha",
      },
      {
        tool: "opengrep",
        ruleId: "r2",
        path: "omega/big.ts",
        line: 1,
        severity: "warning",
        message: "in omega",
      },
      {
        tool: "gitleaks",
        ruleId: "r3",
        path: "ghost/orphan.ts",
        line: 1,
        severity: "error",
        message: "orphan",
      },
    ];
    const calls: Array<{ paths: string[]; mech: string[] }> = [];
    await reviewChunked({
      diff,
      maxChunkLines: 20,
      maxChunks: 20,
      mechanical,
      brief: null,
      onCoverage: () => {},
      buildEnvelope: recordingEnvelope(calls),
      review: async () => APPROVED,
    });
    const alpha = calls.find((c) => c.paths.includes("alpha/big.ts"));
    const omega = calls.find((c) => c.paths.includes("omega/big.ts"));
    // alpha sorts first → chunk[0] → also carries the orphan finding.
    expect(alpha?.mech.sort()).toEqual(["alpha/big.ts", "ghost/orphan.ts"]);
    expect(omega?.mech).toEqual(["omega/big.ts"]);
  });

  it("keeps a #[path] module parent and child in ONE chunk (never split apart)", async () => {
    // The real failure shape: parent declares the child via #[path]; packed into
    // different chunks, the child's reviewer reported the parent deleted.
    const dir = setupGitRepo();
    repos.push(dir);
    git(dir, "checkout", "-b", "feature", "--quiet");
    const filler = Array.from({ length: 30 }, (_, n) => `pub fn f${n}() {}`).join("\n");
    writeFile(
      dir,
      "tests/helpers/live_harness.rs",
      `#[path = "live_harness_api.rs"]\nmod api;\npub struct LiveHarness;\n${filler}\n`,
    );
    writeFile(dir, "tests/helpers/live_harness_api.rs", `use super::LiveHarness;\n${filler}\n`);
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "c", "--quiet");
    const diff = fetchDiff({ ...BASE, cwd: dir, maxFiles: 0, maxDiffLines: 0 });

    const calls: Array<{ paths: string[]; mech: string[] }> = [];
    await reviewChunked({
      diff,
      maxChunkLines: 40, // each file ~35 lines: ungrouped packing would split the pair.
      maxChunks: 20,
      mechanical: [],
      brief: null,
      onCoverage: () => {},
      buildEnvelope: recordingEnvelope(calls),
      review: async () => APPROVED,
    });
    const parentCall = calls.find((c) => c.paths.includes("tests/helpers/live_harness.rs"));
    expect(parentCall?.paths).toContain("tests/helpers/live_harness_api.rs");
  });

  it("attaches the FULL file content to an over-budget chunk (raw string never truncated)", async () => {
    const dir = setupGitRepo();
    repos.push(dir);
    git(dir, "checkout", "-b", "feature", "--quiet");
    const filler = (tag: string): string =>
      Array.from({ length: 20 }, (_, n) => `pub fn ${tag}${n}() {}`).join("\n");
    // A multi-line raw string whose closing delimiter sits far from its opener.
    const content = `${filler("a")}\nconst BODY: &str = r#"\n${filler("b")}\n"#;\n${filler("c")}\n`;
    writeFile(dir, "tests/live_e2e.rs", content);
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "c", "--quiet");
    const diff = fetchDiff({ ...BASE, cwd: dir, maxFiles: 0, maxDiffLines: 0 });

    const seen: DiffData[] = [];
    await reviewChunked({
      diff,
      maxChunkLines: 10, // far below the file's diff size → oversized chunk rides alone.
      maxChunks: 20,
      mechanical: [],
      brief: null,
      onCoverage: () => {},
      buildEnvelope: (subDiff) => {
        seen.push(subDiff);
        return STUB_ENVELOPE;
      },
      review: async () => APPROVED,
      readFile: (path) => (path === "tests/live_e2e.rs" ? content : null),
    });
    const attached = seen.find((d) => (d.context_files ?? []).length > 0);
    const ctx = attached?.context_files?.find((f) => f.path === "tests/live_e2e.rs");
    // The full content — including the raw string's CLOSING delimiter — is present.
    expect(ctx?.content).toContain('r#"');
    expect(ctx?.content).toContain('"#;');
    expect(ctx?.content).toBe(content);
  });

  it("skips unreadable files (readFile → null) when attaching full-file context", async () => {
    const diff = diffWithFiles([
      { path: "alpha/big.ts", lines: 30 },
      { path: "omega/big.ts", lines: 30 },
    ]);
    const seen: DiffData[] = [];
    await reviewChunked({
      diff,
      maxChunkLines: 10, // both chunks oversized → both try to attach context.
      maxChunks: 20,
      mechanical: [],
      brief: null,
      onCoverage: () => {},
      buildEnvelope: (subDiff) => {
        seen.push(subDiff);
        return STUB_ENVELOPE;
      },
      review: async () => APPROVED,
      readFile: (path) => (path === "alpha/big.ts" ? "alpha content" : null),
    });
    const alpha = seen.find((d) => d.changed_files.includes("alpha/big.ts"));
    const omega = seen.find((d) => d.changed_files.includes("omega/big.ts"));
    expect(alpha?.context_files).toEqual([{ path: "alpha/big.ts", content: "alpha content" }]);
    // The unreadable file attaches nothing — and does not crash the chunk.
    expect(omega?.context_files).toBeUndefined();
  });

  it("retries an abstained chunk once and merges the retry's success", async () => {
    const diff = diffWithFiles([
      { path: "alpha/big.ts", lines: 30 },
      { path: "omega/big.ts", lines: 30 },
    ]);
    let omegaCalls = 0;
    await reviewChunked({
      diff,
      maxChunkLines: 20,
      maxChunks: 20,
      mechanical: [],
      brief: null,
      onCoverage: () => {},
      buildEnvelope: (subDiff) => ({ ...STUB_ENVELOPE, user: subDiff.changed_files.join(",") }),
      review: async (env) => {
        if (!env.user.includes("omega")) return APPROVED;
        omegaCalls++;
        return omegaCalls === 1
          ? { verdict: "error", findings: [], error: "schema mismatch" }
          : APPROVED;
      },
    }).then((result) => {
      expect(result.verdict).toBe("approved");
      expect(result.error).toBeUndefined();
    });
    expect(omegaCalls).toBe(2);
  });

  it("marks the review inconclusive (error, partial) when a chunk fails even after retry", async () => {
    const diff = diffWithFiles([
      { path: "alpha/big.ts", lines: 30 },
      { path: "omega/big.ts", lines: 30 },
    ]);
    let omegaCalls = 0;
    const result = await reviewChunked({
      diff,
      maxChunkLines: 20,
      maxChunks: 20,
      mechanical: [],
      brief: null,
      onCoverage: () => {},
      buildEnvelope: (subDiff) => ({ ...STUB_ENVELOPE, user: subDiff.changed_files.join(",") }),
      review: async (env) => {
        if (!env.user.includes("omega")) return APPROVED;
        omegaCalls++;
        return { verdict: "error", findings: [], error: "schema mismatch" };
      },
    });
    expect(omegaCalls).toBe(2); // first pass + exactly one retry
    // All survivors approved, but a chunk went unreviewed — never a confident approval.
    expect(result.verdict).toBe("error");
    expect(result.partial).toBe(true);
    expect(result.error).toContain("1/2 chunks failed");
    expect(result.error).toContain("NOT reviewed");
  });

  it("notes files dropped by the chunk cap in other_checks", async () => {
    const diff = diffWithFiles([
      { path: "a/big.ts", lines: 30 },
      { path: "b/big.ts", lines: 30 },
      { path: "c/big.ts", lines: 30 },
    ]);
    const result = await reviewChunked({
      diff,
      maxChunkLines: 20,
      maxChunks: 2,
      mechanical: [],
      brief: null,
      onCoverage: () => {},
      buildEnvelope: () => STUB_ENVELOPE,
      review: async () => APPROVED,
    });
    expect(result.other_checks).toContain("not reviewed");
    expect(result.other_checks).toContain("c/big.ts");
  });
});

// ── Layer 2 (AC-3): bounded schema-only bisection, per-path coverage, wall clock,
// prompt-cache warm-up. The scripted review() keys on the envelope's file list, which
// buildEnvelope carries verbatim — so a call's identity IS the set of files it reviewed.

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

const PKG_2 = [
  "p1/a.ts",
  "p1/b.ts",
  "p1/c.ts",
  "p1/d.ts",
  "p2/a.ts",
  "p2/b.ts",
  "p2/c.ts",
  "p2/d.ts",
];
const PKG_3 = [...PKG_2, "p3/a.ts", "p3/b.ts", "p3/c.ts", "p3/d.ts"];

/** Equal-size files (identical path/content lengths ⇒ identical segment line counts)
 *  plus the budget that packs exactly `perPackage` of them per package. */
function packedDiff(
  paths: string[],
  perPackage: number,
): { diff: DiffData; maxChunkLines: number } {
  const diff = diffWithFiles(paths.map((path) => ({ path, lines: 10 })));
  const perFile = Math.max(...splitDiffByFile(diff.diff).map((s) => s.lines));
  return { diff, maxChunkLines: perFile * perPackage };
}

/** An envelope whose `user` is the chunk's file list — the scripted review's input. */
function pathsEnvelope(subDiff: DiffData): Envelope {
  return { ...STUB_ENVELOPE, user: subDiff.changed_files.join(",") };
}

/** A "changes" result carrying one finding, so a leaf's findings are traceable. */
function findingOn(path: string): ProviderResult {
  return {
    verdict: "changes",
    findings: [{ path, line: 1, severity: "low", text: `nit in ${path}` }],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("reviewChunked bisection and coverage", () => {
  it("bisects a schema-failing package to the poison file: only it is unreviewed", async () => {
    const { diff, maxChunkLines } = packedDiff(PKG_2, 4);
    const poison = "p2/c.ts";
    const seen: string[][] = [];
    const coverage = new Map<string, CoverageEntry>();

    const result = await reviewChunked({
      diff,
      maxChunkLines,
      maxChunks: 0,
      mechanical: [],
      brief: null,
      buildEnvelope: pathsEnvelope,
      review: async (env) => {
        const paths = env.user.split(",");
        seen.push(paths);
        return paths.includes(poison) ? SCHEMA_FAIL : findingOn(paths[0] ?? "");
      },
      onCoverage: (path, entry) => coverage.set(path, entry),
    });

    // Packing pinned: two packages of four (the call budget below assumes it).
    expect(seen[0]).toHaveLength(4);
    // The poison package cost 1 (whole) + 1 (its failing half) + 1 (its failing
    // quarter) = 3 calls — the BISECT_MAX_DEPTH=2 ceiling is 1 + 2 + 4 = 7.
    const poisonCalls = seen.filter((paths) => paths.includes(poison));
    expect(poisonCalls.length).toBe(3);
    expect(poisonCalls.length).toBeLessThanOrEqual(7);
    // Total calls for that package (halves + quarters incl. the clean ones) ≤ 7.
    const packageCalls = seen.filter((paths) => paths.some((p) => p.startsWith("p2/")));
    expect(packageCalls.length).toBeLessThanOrEqual(7);
    // It was bisected all the way down to a leaf holding the poison file ALONE.
    expect(seen).toContainEqual([poison]);

    // Every other path is reviewed; only the poison file is unreviewed.
    expect(coverage.get(poison)).toEqual({ status: "unreviewed" });
    for (const path of diff.changed_files.filter((p) => p !== poison)) {
      expect(coverage.get(path)).toEqual({ status: "reviewed" });
    }

    // The surviving leaves' findings reach the merged result — bisection salvages
    // the package instead of writing off all four files.
    expect(result.findings.map((f) => f.path)).toContain("p2/d.ts");
    // And exactly ONE of the two packages counts as failed (the leaf's, not the parent's).
    expect(result.error).toContain("1/2 chunks failed");
  });

  it("spends at most 7 calls on a package where EVERY leaf schema-fails", async () => {
    // The worst case BISECT_MAX_DEPTH=2 allows: nothing in either package is
    // recoverable, so both bisect to their depth-2 leaves and every leaf fails.
    const { diff, maxChunkLines } = packedDiff(PKG_2, 4);
    const seen: string[][] = [];
    const coverage = new Map<string, CoverageEntry>();

    const result = await reviewChunked({
      diff,
      maxChunkLines,
      maxChunks: 0,
      mechanical: [],
      brief: null,
      buildEnvelope: pathsEnvelope,
      review: async (env) => {
        seen.push(env.user.split(","));
        return SCHEMA_FAIL;
      },
      onCoverage: (path, entry) => coverage.set(path, entry),
    });

    // Per package: 1 (whole) + 2 (halves) + 4 (quarters) = 7, depth-first. The
    // quarters are leaves (depth limit) and get NO extra retry — that is exactly
    // what holds the ceiling at 7 rather than 11.
    const p1 = seen.filter((paths) => paths.every((p) => p.startsWith("p1/")));
    expect(p1.map((paths) => paths.length)).toEqual([4, 2, 1, 1, 2, 1, 1]);
    expect(p1.length).toBe(7);
    expect(seen.length).toBe(14); // both packages, nothing more
    for (const path of diff.changed_files) {
      expect(coverage.get(path)).toEqual({ status: "unreviewed" });
    }
    expect(result.verdict).toBe("error");
  });

  it("does not degrade the verdict for a package its bisection fully covered", async () => {
    const { diff, maxChunkLines } = packedDiff(PKG_2, 4);
    const coverage = new Map<string, CoverageEntry>();

    const result = await reviewChunked({
      diff,
      maxChunkLines,
      maxChunks: 0,
      mechanical: [],
      brief: null,
      buildEnvelope: pathsEnvelope,
      // Schema failure driven by envelope SIZE: a 4-file package always fails, both
      // of its 2-file halves always succeed → every package is covered by its leaves.
      review: async (env) => (env.user.split(",").length > 2 ? SCHEMA_FAIL : APPROVED),
      onCoverage: (path, entry) => coverage.set(path, entry),
    });

    expect(result.verdict).toBe("approved");
    expect(result.error).toBeUndefined();
    expect(result.partial).toBeUndefined();
    for (const path of diff.changed_files) {
      expect(coverage.get(path)).toEqual({ status: "reviewed" });
    }
  });

  it("never bisects a timeout failure — one retry, then the package is unreviewed", async () => {
    const { diff, maxChunkLines } = packedDiff(PKG_2, 4);
    const seen: string[][] = [];
    const coverage = new Map<string, CoverageEntry>();

    const result = await reviewChunked({
      diff,
      maxChunkLines,
      maxChunks: 0,
      mechanical: [],
      brief: null,
      buildEnvelope: pathsEnvelope,
      review: async (env) => {
        const paths = env.user.split(",");
        seen.push(paths);
        return paths.includes("p2/a.ts") ? TIMEOUT_FAIL : APPROVED;
      },
      onCoverage: (path, entry) => coverage.set(path, entry),
    });

    const failing = seen.filter((paths) => paths.includes("p2/a.ts"));
    expect(failing.length).toBe(2); // first pass + exactly one retry, as today
    // A transient stall must never multiply load: no envelope was ever split.
    expect(failing.every((paths) => paths.length === 4)).toBe(true);
    for (const path of diff.changed_files.filter((p) => p.startsWith("p2/"))) {
      expect(coverage.get(path)).toEqual({ status: "unreviewed" });
    }
    expect(result.verdict).toBe("error");
  });

  it("attempts nothing when the wall deadline is already past: zero calls, all pending", async () => {
    const { diff, maxChunkLines } = packedDiff(PKG_2, 4);
    const coverage = new Map<string, CoverageEntry>();
    let calls = 0;

    const result = await reviewChunked({
      diff,
      maxChunkLines,
      maxChunks: 0,
      mechanical: [],
      brief: null,
      buildEnvelope: pathsEnvelope,
      review: async () => {
        calls++;
        return APPROVED;
      },
      onCoverage: (path, entry) => coverage.set(path, entry),
      wallDeadline: Date.now() - 1,
    });

    // The deadline is checked BEFORE every package — including the warm-up one.
    expect(calls).toBe(0);
    for (const path of diff.changed_files) {
      expect(coverage.get(path)).toEqual({ status: "pending" });
    }
    expect(result.verdict).toBe("error");
  });

  it("keeps the packages completed before the deadline and marks the rest pending", async () => {
    const { diff, maxChunkLines } = packedDiff(PKG_2, 4);
    const coverage = new Map<string, CoverageEntry>();
    const seen: string[][] = [];

    const result = await reviewChunked({
      diff,
      maxChunkLines,
      maxChunks: 0,
      mechanical: [],
      brief: null,
      buildEnvelope: pathsEnvelope,
      review: async (env) => {
        seen.push(env.user.split(","));
        await sleep(150); // outlives the deadline set 50 ms out below
        return APPROVED;
      },
      onCoverage: (path, entry) => coverage.set(path, entry),
      wallDeadline: Date.now() + 50,
    });

    // Only the warm-up package was in flight when time ran out; the second is untouched.
    expect(seen).toHaveLength(1);
    for (const path of diff.changed_files.filter((p) => p.startsWith("p1/"))) {
      expect(coverage.get(path)).toEqual({ status: "reviewed" });
    }
    for (const path of diff.changed_files.filter((p) => p.startsWith("p2/"))) {
      expect(coverage.get(path)).toEqual({ status: "pending" });
    }
    // What completed is kept — a timed-out run still reports its reviewed package.
    expect(result.verdict).toBe("approved");
  });

  it("issues the FIRST package alone (prompt-cache warm-up) before the rest fan out", async () => {
    const { diff, maxChunkLines } = packedDiff(PKG_3, 4);
    const events: string[] = [];

    await reviewChunked({
      diff,
      maxChunkLines,
      maxChunks: 0,
      mechanical: [],
      brief: null,
      buildEnvelope: pathsEnvelope,
      review: async (env) => {
        const id = env.user.split(",")[0] ?? "";
        events.push(`start ${id}`);
        await sleep(30);
        events.push(`end ${id}`);
        return APPROVED;
      },
      onCoverage: () => {},
    });

    // Three packages → six events. The first call ENDS before any other begins…
    expect(events).toHaveLength(6);
    expect(events[0]).toBe("start p1/a.ts");
    expect(events[1]).toBe("end p1/a.ts");
    // …and only then do the remaining two run concurrently (CHUNK_CONCURRENCY ≥ 2).
    expect(events.slice(2, 4).sort()).toEqual(["start p2/a.ts", "start p3/a.ts"]);
  });

  it("ledgers files spilled by the MAX_CHUNKS cap as unreviewed, not just a footnote", async () => {
    const { diff, maxChunkLines } = packedDiff(PKG_2, 4);
    const coverage = new Map<string, CoverageEntry>();

    await reviewChunked({
      diff,
      maxChunkLines,
      maxChunks: 1, // the second package spills
      mechanical: [],
      brief: null,
      buildEnvelope: pathsEnvelope,
      review: async () => APPROVED,
      onCoverage: (path, entry) => coverage.set(path, entry),
    });

    for (const path of diff.changed_files.filter((p) => p.startsWith("p2/"))) {
      expect(coverage.get(path)).toEqual({ status: "unreviewed", reason: "chunk-limit" });
    }
  });

  it("passes the brief to every envelope build, bisected halves included", async () => {
    const { diff, maxChunkLines } = packedDiff(PKG_2, 4);
    const brief: Brief = {
      intent: "tighten the review loop",
      global_facts: ["monorepo"],
      package_hints: [{ name: "p2", path_prefixes: ["p2/"], risk: "high" }],
    };
    const briefs: Array<Brief | null> = [];

    await reviewChunked({
      diff,
      maxChunkLines,
      maxChunks: 0,
      mechanical: [],
      brief,
      buildEnvelope: (subDiff, _mechanical, seenBrief) => {
        briefs.push(seenBrief);
        return pathsEnvelope(subDiff);
      },
      // Force one package to bisect so the halves' envelope builds are observed too.
      review: async (env) => (env.user.split(",").length > 2 ? SCHEMA_FAIL : APPROVED),
      onCoverage: () => {},
    });

    expect(briefs.length).toBeGreaterThan(2);
    expect(briefs.every((b) => b === brief)).toBe(true);
  });
});
