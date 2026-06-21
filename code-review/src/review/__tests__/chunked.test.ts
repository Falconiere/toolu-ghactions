import { describe, it, expect, afterEach } from "vitest";
import { fetchDiff } from "@/git/diff.js";
import type { DiffData } from "@/git/diff.js";
import { reviewChunked } from "@/review/chunked.js";
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
      buildEnvelope: recordingEnvelope(calls),
      review: async () => APPROVED,
    });
    const alpha = calls.find((c) => c.paths.includes("alpha/big.ts"));
    const omega = calls.find((c) => c.paths.includes("omega/big.ts"));
    // alpha sorts first → chunk[0] → also carries the orphan finding.
    expect(alpha?.mech.sort()).toEqual(["alpha/big.ts", "ghost/orphan.ts"]);
    expect(omega?.mech).toEqual(["omega/big.ts"]);
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
      buildEnvelope: () => STUB_ENVELOPE,
      review: async () => APPROVED,
    });
    expect(result.other_checks).toContain("not reviewed");
    expect(result.other_checks).toContain("c/big.ts");
  });
});
