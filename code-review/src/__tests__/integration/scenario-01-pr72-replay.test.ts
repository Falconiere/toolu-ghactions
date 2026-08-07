// scenario-01-pr72-replay — AC-15 (1). PR-72's real shape, replayed end to end
// through `runReview` on a REAL scratch repo: 140 files receiving one identical
// one-line insertion, 20 exact renames, 2 whitespace-only reformats, and 10
// genuinely substantive edits — 192 changed paths in all.
//
// This is the scenario every layer has to survive at once:
//   Layer 0 must collapse the 140 into one exemplar and drop the renames and the
//   reformats, so the model reads 11 files instead of 192; Layer 1's cartographer
//   must run WITHOUT the Verdict schema (which would truncate its brief away);
//   Layer 2 must warm the prompt cache with the first package alone before fanning
//   out; Layer 3 must collapse the repeated finding into ONE inline comment whose
//   body enumerates the files it stands for; and the ledger must still account for
//   all 192 paths, each exactly once, with the stratum that explains it.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { runReview } from "@/pipeline.js";
import { git, writeFile } from "@/git/__tests__/helpers.js";
import { extractFpMarker } from "@/review/fpmarker.js";
import { fingerprint } from "@/state.js";
import {
  baseInputs,
  cleanupRepos,
  inlineComments,
  lastBody,
  markerState,
  prContext,
  scratchRepo,
  treeSha,
  type Scratch,
} from "./harness.js";
import { fakeOctokit } from "./github.js";
import { changes, diffPaths, isCartographer, modelServer, packageCalls } from "./model.js";

afterEach(cleanupRepos);

const PATTERN_FILES = 140;
const RENAMES = 20;
const SUBSTANTIVE = 10;

/** The repeated finding the model raises on every substantive file — same
 *  category + text, so review/cluster.ts collapses all ten into one cluster. */
const REPEAT_CATEGORY = "maintainability";
const REPEAT_TEXT = "Prefer a named constant over this magic literal.";
/** The finding on the pattern group's exemplar — distinct, so it stays a singleton. */
const EXEMPLAR_TEXT = "Declaring the tests module unconditionally ships test code.";

function pad(n: number): string {
  return String(n).padStart(3, "0");
}
const modPath = (n: number): string => `crates/mod_${pad(n)}.rs`;
const substantivePath = (n: number): string => `src/s${pad(n)}.ts`;

/** PR-72's shape, built with the real git binary. */
function pr72Repo(): Scratch {
  const base: Record<string, string> = {};
  for (let i = 0; i < PATTERN_FILES; i++) base[modPath(i)] = "pub mod a;\n";
  for (let i = 0; i < RENAMES; i++)
    base[`legacy/m${pad(i)}.ts`] = `export const l${pad(i)} = ${i};\n`;
  // The two reformat fixtures need an INDENTED line to re-indent — see the
  // reformat step in the builder below for why it must be indentation only.
  for (let i = 0; i < 2; i++) base[`fmt/f${i}.ts`] = `export const f${i} = {\n  value: ${i},\n};\n`;
  for (let i = 0; i < SUBSTANTIVE; i++)
    base[substantivePath(i)] = `export const s${pad(i)} = ${i};\n`;

  return scratchRepo((dir) => {
    // 140 × the SAME insertion → one pattern group (identical normalized hunks).
    for (let i = 0; i < PATTERN_FILES; i++) writeFile(dir, modPath(i), "pub mod a;\nmod tests;\n");
    // 20 exact renames: content untouched, so each carries no hunk at all.
    mkdirSync(join(dir, "moved"), { recursive: true }); // git mv needs the dest dir
    for (let i = 0; i < RENAMES; i++) {
      git(dir, "mv", `legacy/m${pad(i)}.ts`, `moved/m${pad(i)}.ts`);
    }
    // 2 whitespace-only reformats: a 2-space → 4-space RE-INDENT, nothing else.
    //
    // These must stay LEADING-whitespace-only. Layer 0 classifies `formatting` by
    // comparing each removed line to its added counterpart after trimming the ENDS
    // only (git/patterns.ts `trimEnds`) — internal whitespace is real content, so a
    // change like `export   const f0   =   0;` is correctly substantive and would
    // put these two files back into the review diff, breaking the distill counts
    // and the ledger's `formatting: 2` below.
    for (let i = 0; i < 2; i++)
      writeFile(dir, `fmt/f${i}.ts`, `export const f${i} = {\n    value: ${i},\n};\n`);
    // 10 real edits — distinct hunks, so none of them collapses.
    for (let i = 0; i < SUBSTANTIVE; i++) {
      writeFile(dir, substantivePath(i), `export const s${pad(i)} = ${i + 100};\n`);
    }
  }, base);
}

/** The model's answer for a package: the repeated finding on every substantive
 *  file it was given, plus the one-off finding when it holds the exemplar. */
function replyFor(paths: string[]): ReturnType<typeof changes> {
  const findings = paths.flatMap((path) => {
    if (path === modPath(0)) {
      return [
        {
          path,
          line: 2,
          severity: "medium" as const,
          confidence: "high" as const,
          category: "testing",
          text: EXEMPLAR_TEXT,
        },
      ];
    }
    if (!path.startsWith("src/")) return [];
    return [
      {
        path,
        line: 1,
        severity: "medium" as const,
        confidence: "high" as const,
        category: REPEAT_CATEGORY,
        text: REPEAT_TEXT,
      },
    ];
  });
  return changes(findings);
}

describe("scenario 1 — PR-72 replay (AC-15.1)", () => {
  it("distills 192 paths to 11, warms up then fans out, clusters the repeats, ledgers everything", async () => {
    const { dir, headSha } = pr72Repo();
    const { octokit, rec } = fakeOctokit();
    const events: string[] = [];
    const server = modelServer({
      brief: {
        intent: "Adds a tests module across the crate and edits ten helpers.",
        global_facts: ["The module insertion is mechanical in every file."],
        package_hints: [],
      },
      events,
      reply: (call) => replyFor(diffPaths(call)),
    });

    const result = await runReview({
      inputs: baseInputs({ maxChunkLines: 21, verbosity: "full" }),
      octokit,
      context: prContext(headSha),
      fetch: server.fetch,
      cwd: dir,
      now: () => 1_700_000_000_000,
    });

    // ── Layer 1: the cartographer runs in RAW-JSON mode. The AI SDK injects the
    // enforced schema into the system message ("JSON schema: {…}") for a schema
    // call; its absence IS the override (a brief routed through the Verdict schema
    // would be truncated away by `other_checks`'s .max(600)).
    const cartographer = server.calls.find(isCartographer);
    expect(cartographer).toBeDefined();
    expect(cartographer?.system).toContain("You MUST answer with JSON.");
    expect(cartographer?.system).not.toContain("JSON schema:");
    // …and it maps the PR from the MANIFEST, never from diff text.
    expect(cartographer?.user).not.toContain("diff --git");

    // ── Layer 2: the first package is issued ALONE (prompt-cache warm-up), and
    // only then do the rest fan out.
    const packages = packageCalls(server.calls);
    expect(packages.length).toBeGreaterThanOrEqual(2);
    expect(events[0]?.startsWith("start ")).toBe(true);
    expect(events[1]).toBe(`end ${events[0]?.slice("start ".length) ?? ""}`);

    // ── Layer 0: only the exemplar + the ten substantive files were ever read.
    const reviewed = new Set(packages.flatMap(diffPaths));
    expect([...reviewed].sort()).toEqual([
      modPath(0),
      ...Array.from({ length: SUBSTANTIVE }, (_, i) => substantivePath(i)),
    ]);
    // Every per-call envelope is bounded by the distilled diff, and the whole
    // round's diff text shrank by ≥ 80% against the raw one git produced.
    const rawLines = git(dir, "diff", "main", "HEAD").split("\n").length;
    const sentLines = packages.reduce((n, c) => n + diffPaths(c).length, 0);
    expect(sentLines).toBe(reviewed.size);
    const sentDiffLines = packages.reduce(
      (n, c) => n + (c.user.slice(c.user.indexOf("\n\n## Diff\n")).split("\n").length - 1),
      0,
    );
    expect(sentDiffLines).toBeLessThan(rawLines * 0.2);

    // ── Layer 3: 11 findings, but only TWO inline comments — one per cluster.
    expect(result.verdict).toBe("changes");
    expect(result.findingsCount).toBe(SUBSTANTIVE + 1);
    const comments = inlineComments(rec);
    expect(comments.length).toBe(2);

    // AC-4 end to end: the cluster exemplar's INLINE body enumerates its members
    // and carries the dismissal warning…
    const exemplarComment = comments.find((c) => c.body.includes("Same finding in"));
    expect(exemplarComment?.body).toContain(`Same finding in ${SUBSTANTIVE} files:`);
    expect(exemplarComment?.body).toContain(
      `_Dismissing this thread dismisses the pattern (${SUBSTANTIVE} files)._`,
    );
    // …while its fp marker is still the one stamped from the RAW finding text, so
    // decorating the body cannot rotate the thread's identity across rounds.
    expect(extractFpMarker(exemplarComment?.body ?? "")).toBe(
      fingerprint({
        path: exemplarComment?.path ?? "",
        category: REPEAT_CATEGORY,
        text: REPEAT_TEXT,
      }),
    );

    // ── The ledger accounts for all 192 changed paths, exactly once each, with
    // the stratum that explains each one (139 collapsed members, 40 rename sides).
    expect(lastBody(rec)).toContain("reviewed: 11 · pattern: 139 · rename: 40 · formatting: 2");

    // ── The marker carries cluster identity and the tree this round covered.
    const state = markerState(rec);
    const clusters = "clusters" in state ? (state.clusters ?? {}) : {};
    expect(Object.keys(clusters).length).toBe(SUBSTANTIVE);
    expect(new Set(Object.values(clusters)).size).toBe(1);
    expect("reviewed_tree" in state && state.reviewed_tree).toBe(treeSha(dir));
  }, 120_000);
});
