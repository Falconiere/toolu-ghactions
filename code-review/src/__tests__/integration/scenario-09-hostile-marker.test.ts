// scenario-09-hostile-marker — AC-15 (9). The state marker rides in a PR comment,
// which anyone with write access can edit, and `StoredFindingSchema` is
// `.passthrough()` — so a marker's findings are ATTACKER-INFLUENCEABLE while every
// consumer downstream (`dropOutOfScope`'s integer `line`, `SEVERITY_RANK`, the
// comment builders) assumes a validated finding.
//
// Two hostile shapes, both of which must be non-events:
//  1. a marker whose findings are individually malformed (no line, an off-enum
//     severity, empty text) plus one carrying a huge bogus field — carry-forward's
//     strict re-injection (pipeline/carry.ts) drops them into the ledger's `carried`
//     bucket, keeps the one well-formed finding, and none of it reaches a comment;
//  2. a marker that inflates past the gzip-bomb guard — it decodes to empty state
//     and the round simply reviews everything from scratch.
import { afterEach, describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { runReview } from "@/pipeline.js";
import { writeFile } from "@/git/__tests__/helpers.js";
import { encodeMarker, type ReviewState } from "@/state.js";
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
import { changes, modelServer } from "./model.js";

afterEach(cleanupRepos);

const HUGE = "Z".repeat(20_000);
const LIVE_TEXT = "The retry loop has no upper bound.";

function twoFileRepo(): Scratch {
  return scratchRepo((dir) => {
    writeFile(dir, "src/a.ts", "export const a = 1;\n");
    writeFile(dir, "src/b.ts", "export const b = 2;\n");
  });
}

/** A prior marker an attacker edited: three findings that cannot be trusted into a
 *  validated path, and one well-formed one that must still carry. */
const TAMPERED: ReviewState = {
  schema: "toolu-review-state",
  version: 1,
  findings: [
    { path: "src/gone.ts", line: 5, severity: "high", text: "", fp: "aaa" },
    { path: "src/bad.ts", line: 5, severity: "CRITICAL!!!", text: "tampered severity", fp: "bbb" },
    { path: "src/noline.ts", severity: "high", text: "tampered missing line", fp: "ccc" },
    {
      path: "src/legit.ts",
      line: 1,
      severity: "high",
      text: "carried legit finding",
      fp: "ddd",
      bogus: HUGE,
    },
  ],
  history: [
    {
      sha: "1234567",
      ts: 1_600_000_000,
      verdict: "changes",
      counts: { new: 1, open: 0, resolved: 0, total: 1 },
    },
  ],
};

describe("scenario 9 — a hostile state marker (AC-15.9)", () => {
  it("filters malformed carried findings into the ledger, keeps the valid one, injects nothing", async () => {
    const { dir, headSha } = twoFileRepo();
    const { octokit, rec } = fakeOctokit({
      existing: [{ id: 555, body: `### Code Review — old\n\n${encodeMarker(TAMPERED)}` }],
    });
    const server = modelServer({
      reply: () =>
        changes([
          {
            path: "src/a.ts",
            line: 1,
            severity: "high",
            confidence: "high",
            category: "reliability",
            text: LIVE_TEXT,
          },
        ]),
    });

    // Must not throw: the tampered findings never reach a validated path.
    const result = await runReview({
      inputs: baseInputs(),
      octokit,
      context: prContext(headSha),
      fetch: server.fetch,
      cwd: dir,
      now: () => 1_700_000_000_000,
    });
    expect(result.verdict).toBe("changes");

    // The three malformed ones are ledgered `carried` WITHOUT a finding; the two
    // real changed files were reviewed.
    const body = lastBody(rec);
    expect(body).toContain("reviewed: 2 · carried: 3");

    // The valid prior finding still carries; the malformed ones are gone from the
    // marker entirely — and so is the huge bogus field zod stripped off it. (The
    // marker's fps are re-stamped by `attachFps`, so identity is read by path.)
    const state = markerState(rec);
    const stored = "findings" in state ? state.findings : [];
    const paths = stored.map((f) => f.path);
    expect(paths).toContain("src/legit.ts");
    expect(paths).not.toContain("src/gone.ts");
    expect(paths).not.toContain("src/bad.ts");
    expect(paths).not.toContain("src/noline.ts");
    expect(stored.find((f) => f.path === "src/legit.ts")?.["bogus"]).toBeUndefined();

    // Nothing attacker-written reached a comment — neither the sticky nor any
    // inline body carries the tampered text or the padding.
    const everything = [body, ...inlineComments(rec).map((c) => c.body)].join("\n");
    expect(everything).not.toContain("tampered severity");
    expect(everything).not.toContain("tampered missing line");
    expect(everything).not.toContain(HUGE);
    // …while this round's own finding posted normally.
    expect(everything).toContain(LIVE_TEXT);
  }, 60_000);

  it("a marker that inflates past the gzip-bomb guard decodes to nothing and the PR is fully re-reviewed", async () => {
    const { dir, headSha } = twoFileRepo();
    // A real gzip bomb: 6 MB of one byte, past state.ts's 5 MB decode cap.
    const bomb = gzipSync(Buffer.alloc(6_000_000, 0x41)).toString("base64");
    const { octokit, rec } = fakeOctokit({
      existing: [
        { id: 777, body: `### Code Review — old\n\n<!-- toolu-review-state:v1 ${bomb} -->` },
      ],
    });
    const server = modelServer({ reply: () => changes([]) });

    const result = await runReview({
      inputs: baseInputs(),
      octokit,
      context: prContext(headSha),
      fetch: server.fetch,
      cwd: dir,
      now: () => 1_700_000_000_000,
    });

    // Memory just starts fresh: both files are reviewed, and the round writes a
    // complete marker of its own.
    expect(result.verdict).toBe("changes");
    expect(lastBody(rec)).toContain("reviewed: 2");
    const state = markerState(rec);
    expect("history" in state && state.history.length).toBe(1);
    expect("reviewed_tree" in state && state.reviewed_tree).toBe(treeSha(dir));
  }, 60_000);
});
