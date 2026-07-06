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
      buildEnvelope: () => STUB_ENVELOPE,
      review: async () => APPROVED,
    });
    expect(result.other_checks).toContain("not reviewed");
    expect(result.other_checks).toContain("c/big.ts");
  });
});
