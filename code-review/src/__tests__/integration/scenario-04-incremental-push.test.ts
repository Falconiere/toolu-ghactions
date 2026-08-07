// scenario-04-incremental-push — AC-15 (4). Round 1 reviews 101 files and reaches
// complete coverage, so the marker records the tree it covered. The author then
// pushes a commit touching THREE of them.
//
// Round 2 must re-read only those three (spec §True incremental) — and, far more
// importantly, must not mistake "not re-read" for "fixed": the finding on the
// untouched file stays in the marker, its GitHub thread stays open, and the
// toolu.sh report must NOT claim it fixed. That last one is the bug carry-forward
// exists for (pipeline/carry.ts): `reconcile` resolves any prior thread with no
// matching current finding, and `diffState` rebuilds the marker from current
// findings only, so a round that skipped a file would silently close its threads.
import { afterEach, describe, expect, it } from "vitest";
import { runReview } from "@/pipeline.js";
import { writeFile } from "@/git/__tests__/helpers.js";
import { extractFpMarker } from "@/review/fpmarker.js";
import {
  baseInputs,
  cleanupRepos,
  commitAll,
  inlineComments,
  lastBody,
  markerState,
  prContext,
  scratchRepo,
  type Scratch,
} from "./harness.js";
import { fakeOctokit, type SeedThread } from "./github.js";
import { APPROVED, changes, diffPaths, modelServer, packageCalls } from "./model.js";

afterEach(cleanupRepos);

const BUGGY = "src/util.ts";
const BUG_TEXT = "Function add performs subtraction.";
const TOUCHED = ["001", "002", "003"];

/** The wire shape report/payload.ts POSTs — narrowed from the recorded raw body. */
interface ReportBody {
  findings?: {
    new?: { path: string }[];
    open?: { path: string }[];
    fixed?: { path: string }[];
    dismissed?: { path: string }[];
  };
}

/** One real bug plus 100 padding files. */
function hundredFileRepo(): Scratch {
  return scratchRepo((dir) => {
    writeFile(
      dir,
      BUGGY,
      "export function add(a: number, b: number): number {\n  return a - b;\n}\n",
    );
    for (let i = 0; i < 100; i++) {
      writeFile(dir, `src/pad/f${String(i).padStart(3, "0")}.ts`, `export const pad = ${i};\n`);
    }
  });
}

describe("scenario 4 — an incremental push (AC-15.4)", () => {
  it("re-reviews only the pushed files, keeps the carried finding open, reports nothing fixed", async () => {
    const { dir, headSha } = hundredFileRepo();
    const threads: SeedThread[] = [];
    const { octokit, rec } = fakeOctokit({ threads });
    const inputs = baseInputs({ touluApiKey: "toolu_test_key" });
    const round1 = modelServer({
      reply: (call) =>
        diffPaths(call).includes(BUGGY)
          ? changes([
              {
                path: BUGGY,
                line: 2,
                severity: "high",
                confidence: "high",
                category: "correctness",
                text: BUG_TEXT,
              },
            ])
          : { ok: APPROVED },
    });

    const first = await runReview({
      inputs,
      octokit,
      context: prContext(headSha),
      fetch: round1.fetch,
      cwd: dir,
      now: () => 1_700_000_000_000,
    });

    expect(first.findingsCount).toBe(1);
    expect(lastBody(rec)).toContain("reviewed: 101");
    // GitHub now shows the thread that inline comment opened — seeded from the
    // REAL posted body (fp marker included), exactly as the next run would read it.
    const posted = inlineComments(rec)[0];
    expect(posted).toBeDefined();
    const bugFp = extractFpMarker(posted?.body ?? "");
    threads.push({
      threadId: "T_util",
      rootCommentId: 8001,
      fp: bugFp ?? "",
      path: posted?.path ?? "",
      line: posted?.line ?? null,
      rootBody: posted?.body ?? "",
    });

    // ── The push: three padding files, nothing else.
    for (const n of TOUCHED) writeFile(dir, `src/pad/f${n}.ts`, `export const pad = 99; // ${n}\n`);
    const head2 = commitAll(dir, "touch three");
    const round2 = modelServer({ reply: () => ({ ok: APPROVED }) });

    const second = await runReview({
      inputs,
      octokit,
      context: prContext(head2),
      fetch: round2.fetch,
      cwd: dir,
      now: () => 1_700_000_100_000,
    });

    // Only the three pushed files (and their package peers — there are none here)
    // reached a reviewer; the other 98 were never sent.
    const sent = new Set(packageCalls(round2.calls).flatMap(diffPaths));
    expect([...sent].sort()).toEqual(TOUCHED.map((n) => `src/pad/f${n}.ts`));
    expect(lastBody(rec)).toContain("reviewed: 3 · carried: 98");

    // The carried finding is still open everywhere it matters: it counts, it keeps
    // the verdict at changes, it survives into the marker, and its thread is
    // untouched — a round that never re-read `src/util.ts` cannot clear it.
    expect(second.verdict).toBe("changes");
    expect(second.findingsCount).toBe(1);
    expect(rec.resolved).toEqual([]);
    const state = markerState(rec);
    const carried = "findings" in state ? state.findings : [];
    expect(carried.map((f) => f.path)).toContain(BUGGY);
    expect(carried.map((f) => f.fp)).toContain(bugFp);

    // …and toolu.sh is told the same story: still open, nothing fixed.
    const report: ReportBody = JSON.parse(round2.reports.at(-1) ?? "{}");
    expect(report.findings?.fixed).toEqual([]);
    expect(report.findings?.open?.map((f) => f.path)).toContain(BUGGY);
    expect(report.findings?.new).toEqual([]);
  }, 120_000);
});
