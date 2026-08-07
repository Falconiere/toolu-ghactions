// scenario-07-cluster-lifecycle — AC-15 (7). One defect repeated across 67 files,
// followed across its whole life: collapsed to ONE thread, kept stable when the
// exemplar alone gets fixed (promotion, not 66 new comments), resolved only once
// every member is gone — and settled wholesale when a human dismisses the exemplar.
//
// The failure this guards against is the one PR-72 actually produced: 67 members
// matching one thread while 66 of them still land in `toCreate`, so every round
// re-posts the pattern under a new representative.
import { afterEach, describe, expect, it } from "vitest";
import { runReview } from "@/pipeline.js";
import { git, writeFile } from "@/git/__tests__/helpers.js";
import { extractFpMarker } from "@/review/fpmarker.js";
import { fingerprint } from "@/state.js";
import {
  baseInputs,
  cleanupRepos,
  commentContext,
  inlineComments,
  prContext,
  scratchRepo,
  type Scratch,
} from "./harness.js";
import { fakeOctokit, type SeedThread } from "./github.js";
import { APPROVED, changes, modelServer, type ScriptedFinding } from "./model.js";

afterEach(cleanupRepos);

const MEMBERS = 67;
const CATEGORY = "consistency";
const TEXT = "Use the shared logger instead of console.";
const path = (n: number): string => `src/repeat/r${String(n).padStart(2, "0")}.ts`;

/** 67 files with DISTINCT content (so Layer 0 sees no mechanical pattern) that the
 *  model flags with one and the same finding — a Layer 3 cluster, not a Layer 0 one. */
function repeatRepo(): Scratch {
  return scratchRepo((dir) => {
    for (let i = 0; i < MEMBERS; i++) writeFile(dir, path(i), `export const r${i} = ${i};\n`);
  });
}

/** The repeated finding on every path except those in `skip`. */
function repeated(skip: string[] = [], blockerOn?: string): ScriptedFinding[] {
  return Array.from({ length: MEMBERS }, (_, i) => path(i))
    .filter((p) => !skip.includes(p))
    .map((p) => ({
      path: p,
      line: 1,
      severity: p === blockerOn ? ("blocker" as const) : ("medium" as const),
      confidence: "high" as const,
      category: CATEGORY,
      text: TEXT,
    }));
}

/**
 * `path:line` of the representative round 2 must promote to, derived independently:
 * with the round-1 exemplar fixed, none of the surviving members carries the pinned
 * fp, so `clusterFindings` pins the LOWEST member fp (lexicographic). Computed from
 * the same real `fingerprint()` the pipeline stamps with — an assertion on identity,
 * not on the promotion sentence's wording.
 */
function promotedLocation(fixedPath: string): string {
  const byFp = new Map<string, string>();
  for (let i = 0; i < MEMBERS; i++) {
    const p = path(i);
    if (p === fixedPath) continue;
    byFp.set(fingerprint({ path: p, category: CATEGORY, text: TEXT }), p);
  }
  const lowest = [...byFp.keys()].sort()[0];
  const promotedPath = lowest === undefined ? undefined : byFp.get(lowest);
  if (promotedPath === undefined) throw new Error("fixture: no surviving member to promote");
  return `${promotedPath}:1`; // every scripted finding is on line 1
}

/** GitHub's view of the thread round 1 opened, built from the REAL posted comment. */
function seedFromPosted(body: string, path: string, line: number | undefined): SeedThread {
  return {
    threadId: "T_cluster",
    rootCommentId: 8001,
    fp: extractFpMarker(body) ?? "",
    path,
    line: line ?? null,
    rootBody: body,
    replies: [],
  };
}

describe("scenario 7 — cluster lifecycle (AC-15.7)", () => {
  it("one thread for 67 findings, promotion when the exemplar is fixed, resolution when all are", async () => {
    const { dir, headSha } = repeatRepo();
    const threads: SeedThread[] = [];
    const { octokit, rec } = fakeOctokit({ threads });
    const inputs = baseInputs();

    // ── Round 1: 67 findings, ONE inline comment.
    const r1 = await runReview({
      inputs,
      octokit,
      context: prContext(headSha),
      fetch: modelServer({ reply: () => changes(repeated()) }).fetch,
      cwd: dir,
      now: () => 1_700_000_000_000,
    });
    expect(r1.findingsCount).toBe(MEMBERS);
    const comments = inlineComments(rec);
    expect(comments.length).toBe(1);
    const exemplarPath = comments[0]?.path ?? "";
    expect(comments[0]?.body).toContain(`Same finding in ${MEMBERS} files:`);
    threads.push(seedFromPosted(comments[0]?.body ?? "", exemplarPath, comments[0]?.line));

    // A re-trigger comment re-reviews the whole PR (the tree is unchanged, so a
    // push event would review nothing — see scenario 5).
    git(dir, "fetch", dir, "HEAD"); // real fetch writes FETCH_HEAD (update-ref refuses pseudorefs on newer git)
    const reReview = commentContext(headSha, "@toolu review");

    // ── Round 2: the exemplar's own file is clean now; 66 members remain.
    const r2 = await runReview({
      inputs,
      octokit,
      context: reReview,
      fetch: modelServer({ reply: () => changes(repeated([exemplarPath])) }).fetch,
      cwd: dir,
      now: () => 1_700_000_100_000,
      lookupPermission: async () => "write",
    });

    expect(r2.findingsCount).toBe(MEMBERS - 1);
    // The thread is NOT resolved (the pattern lives) and did NOT explode into 66
    // fresh comments: it is replied to, against the promoted representative.
    expect(rec.resolved).toEqual([]);
    expect(inlineComments(rec).length).toBe(1);
    const promotion = rec.replies.at(-1)?.body ?? "";
    expect(promotion).toContain(`**Exemplar fixed; ${MEMBERS - 1} member(s) remain.**`);
    // WHICH finding was promoted, by path:line identity — not just that the wording
    // appeared. The round-1 exemplar is gone and no prior pin survives among the
    // members, so review/cluster.ts falls to the lowest member fp; that rule is
    // re-derived here from the real `fingerprint()` rather than read back out of
    // the product, so a silent change of representative fails this test.
    expect(promotion).toContain(
      `representative promoted to \`${promotedLocation(exemplarPath)}\`.`,
    );
    // GitHub would now show that reply on the thread; so does the next round.
    threads[0]?.replies?.push({ author: "toolu-bot", body: promotion });

    // ── Round 3: every member is fixed → the thread finally resolves.
    const r3 = await runReview({
      inputs,
      octokit,
      context: reReview,
      fetch: modelServer({ reply: () => ({ ok: APPROVED }) }).fetch,
      cwd: dir,
      now: () => 1_700_000_200_000,
      lookupPermission: async () => "write",
    });

    expect(r3.findingsCount).toBe(0);
    expect(r3.verdict).toBe("approved");
    expect(rec.resolved).toEqual(["T_cluster"]);
    expect(rec.replies.at(-1)?.body).toContain("no longer applies");
  }, 120_000);

  it("a human resolving the exemplar's thread settles the whole pattern, blockers included", async () => {
    const { dir, headSha } = repeatRepo();
    const threads: SeedThread[] = [];
    const { octokit, rec } = fakeOctokit({ threads });
    const inputs = baseInputs();
    const blocker = path(MEMBERS - 1);

    await runReview({
      inputs,
      octokit,
      context: prContext(headSha),
      fetch: modelServer({ reply: () => changes(repeated([], blocker)) }).fetch,
      cwd: dir,
      now: () => 1_700_000_000_000,
    });
    const posted = inlineComments(rec)[0];
    expect(posted).toBeDefined();

    // The author reads the body — which says dismissing this thread dismisses the
    // whole pattern — and resolves it on GitHub.
    const seed = seedFromPosted(posted?.body ?? "", posted?.path ?? "", posted?.line);
    threads.push({ ...seed, isResolved: true });
    git(dir, "fetch", dir, "HEAD"); // real fetch writes FETCH_HEAD (update-ref refuses pseudorefs on newer git)

    const after = await runReview({
      inputs,
      octokit,
      context: commentContext(headSha, "@toolu review"),
      fetch: modelServer({ reply: () => changes(repeated([], blocker)) }).fetch,
      cwd: dir,
      now: () => 1_700_000_100_000,
      lookupPermission: async () => "write",
    });

    // Every member is suppressed — the blocker one too: dismissing the exemplar
    // dismisses the pattern (spec §Layer 3). Nothing is re-posted or re-resolved.
    expect(after.findingsCount).toBe(0);
    expect(after.verdict).toBe("approved");
    expect(inlineComments(rec).length).toBe(1); // still just round 1's comment
    expect(rec.resolved).toEqual([]);
  }, 120_000);
});
