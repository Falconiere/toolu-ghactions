import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MAX_COMMENTS_PER_REVIEW, postInlineReview } from "@/github/review.js";
import type { ReviewClient, ReviewComment, ReviewTarget } from "@/github/review.js";
import { setVerdictLabel } from "@/github/label.js";
import type { LabelClient, LabelTarget } from "@/github/label.js";
import type { Finding } from "@/llm/schema.js";
import { extractFpMarker } from "@/review/fpmarker.js";
import { fingerprint } from "@/state.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** The real 422 body PR-72 run 31155450420 got back from the Reviews GraphQL
 *  mutation: it rejects `subjectType` and a null `position` outright — evidence
 *  that there never was a safe file-level fallback (AC-5). */
function pr72FixtureText(): string {
  return readFileSync(join(FIXTURES, "pr72-createreview-422.txt"), "utf8");
}

const REVIEW_TARGET: ReviewTarget = {
  owner: "test-org",
  repo: "test-repo",
  prNumber: 42,
  headSha: "abc1234def567890abc1234def567890abc12345",
};
const LABEL_TARGET: LabelTarget = { owner: "test-org", repo: "test-repo", prNumber: 42 };

/** A recording Reviews client capturing the createReview payload. */
function fakeReviewClient(): {
  client: ReviewClient;
  calls: { comments: ReviewComment[]; body: string; commit_id: string; event: "COMMENT" }[];
} {
  const calls: { comments: ReviewComment[]; body: string; commit_id: string; event: "COMMENT" }[] =
    [];
  const client: ReviewClient = {
    rest: {
      pulls: {
        createReview: async (p) => {
          calls.push({
            comments: p.comments,
            body: p.body,
            commit_id: p.commit_id,
            event: p.event,
          });
          return {
            data: { html_url: "https://github.com/test-org/test-repo/pull/42#pullrequestreview-1" },
          };
        },
      },
    },
  };
  return { client, calls };
}

describe("postInlineReview", () => {
  // Validated findings: two anchored (a single line + a multi-line span with a
  // suggestion). A finding without a `line` is not anchorable and must be dropped.
  const findings: Finding[] = [
    { path: "src/a.ts", line: 10, severity: "high", category: "correctness", text: "off-by-one" },
    {
      path: "src/a.ts",
      line: 12,
      end_line: 14,
      severity: "blocker",
      text: "fix the loop",
      suggestion: "for (let i = 0; i < n; i++) {",
    },
  ];

  it("posts inline comments only for anchored findings, with span + suggestion shape", async () => {
    const { client, calls } = fakeReviewClient();
    const r = await postInlineReview(client, findings, REVIEW_TARGET);

    expect(r.posted).toBe(true);
    expect(r.count).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.commit_id).toBe(REVIEW_TARGET.headSha);

    const [single, span] = calls[0]!.comments;
    // Single-line comment: line set, no start_line.
    expect(single).toMatchObject({ path: "src/a.ts", line: 10, side: "RIGHT" });
    expect(single?.start_line).toBeUndefined();
    expect(single?.body).toContain("**high** _(correctness)_: off-by-one");
    // The hidden fingerprint marker is appended so a later run can recognise this thread.
    expect(single?.body).toMatch(/<!-- toolu-fp:[0-9a-f]{40} -->$/);

    // Multi-line span: start_line..line, plus a committable suggestion fence.
    expect(span).toMatchObject({
      path: "src/a.ts",
      start_line: 12,
      line: 14,
      side: "RIGHT",
      start_side: "RIGHT",
    });
    expect(span?.body).toContain("```suggestion\nfor (let i = 0; i < n; i++) {\n```");
  });

  // AC-4: a cluster exemplar's body is DECORATED before posting (the members it
  // stands for are appended — pipeline/reduce.ts's decorateExemplars). The posted
  // marker must still carry the fp the pipeline STAMPED from the raw finding: a fp
  // recomputed from the decorated text would differ, and the thread's identity
  // would rotate on every round — no dedup, no reply-in-place, no resolve.
  it("stamps the marker from the finding's own fp, so decorating the body cannot rotate it", async () => {
    const raw: Finding = {
      path: "src/a.ts",
      line: 10,
      severity: "high",
      category: "correctness",
      text: "off-by-one",
    };
    const stamped = { ...raw, fp: fingerprint(raw) };
    const decorated = {
      ...stamped,
      text: `${raw.text}\n\nSame finding in 3 files: \`src/a.ts\`, \`src/b.ts\`, \`src/c.ts\``,
    };

    const plain = fakeReviewClient();
    await postInlineReview(plain.client, [stamped], REVIEW_TARGET);
    const decor = fakeReviewClient();
    await postInlineReview(decor.client, [decorated], REVIEW_TARGET);

    const plainFp = extractFpMarker(plain.calls[0]?.comments[0]?.body ?? "");
    const decoratedBody = decor.calls[0]?.comments[0]?.body ?? "";
    // The stamped fp is what reaches the wire…
    expect(plainFp).toBe(stamped.fp);
    // …the decoration really did change the body…
    expect(decoratedBody).toContain("Same finding in 3 files");
    // …and the marker is byte-identical regardless.
    expect(extractFpMarker(decoratedBody)).toBe(stamped.fp);
    // Proving the point: a fp recomputed from the decorated text would be different.
    expect(fingerprint(decorated)).not.toBe(stamped.fp);
  });

  it("skips (no review posted) when there are no anchored findings", async () => {
    const { client, calls } = fakeReviewClient();
    // A finding with no `line` is unanchorable — it exercises the runtime guard.
    // The LLM emits findings as JSON, so a parsed payload missing `line` is the
    // real shape the guard defends against (no compile-time `line` to assert away).
    const unanchored: Finding[] = JSON.parse('[{"path":"x.ts","severity":"low","text":"no line"}]');
    const r = await postInlineReview(client, unanchored, REVIEW_TARGET);
    expect(r.posted).toBe(false);
    expect(r.count).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("is non-fatal: a Reviews-API throw is caught and reported, not raised", async () => {
    const client: ReviewClient = {
      rest: {
        pulls: {
          createReview: async () => {
            throw new Error("422 Unprocessable Entity (unanchorable line)");
          },
        },
      },
    };
    const r = await postInlineReview(client, findings, REVIEW_TARGET);
    expect(r.posted).toBe(false);
    expect(r.reason).toContain("422");
  });
});

/** A recording client WITH listFiles — exercises GitHub-side anchor validation.
 *  `failFirst` makes createReview 422 once (the unanchorable-line failure mode). */
function fakeValidatingClient(
  files: { filename: string; patch?: string }[],
  opts: { failFirst?: boolean } = {},
): {
  client: ReviewClient;
  calls: { comments: ReviewComment[] }[];
} {
  const calls: { comments: ReviewComment[] }[] = [];
  let failures = opts.failFirst ? 1 : 0;
  const client: ReviewClient = {
    rest: {
      pulls: {
        createReview: async (p) => {
          if (failures > 0) {
            failures--;
            throw new Error("422 Unprocessable Entity: Line could not be resolved");
          }
          calls.push({ comments: p.comments });
          return {
            data: { html_url: "https://github.com/test-org/test-repo/pull/42#pullrequestreview-2" },
          };
        },
        listFiles: async () => ({ data: files }),
      },
    },
  };
  return { client, calls };
}

// GitHub's patch for src/a.ts showing new-side lines 10..14 (context + additions).
const PATCH_10_TO_14 = "@@ -8,3 +10,5 @@\n line-a\n+line-b\n+line-c\n+line-d\n line-e";

describe("postInlineReview — anchor validation against GitHub's diff", () => {
  it("reports an unmappable line as unanchored (never file-level); the rest still post", async () => {
    const { client, calls } = fakeValidatingClient([
      { filename: "src/a.ts", patch: PATCH_10_TO_14 },
    ]);
    const findings: Finding[] = [
      { path: "src/a.ts", line: 10, severity: "high", text: "anchored fine" },
      {
        path: "src/a.ts",
        line: 99, // NOT in GitHub's diff — would 422 the whole batch unvalidated.
        severity: "blocker",
        text: "line off the diff",
        suggestion: "let x = 1;",
      },
    ];
    const r = await postInlineReview(client, findings, REVIEW_TARGET);

    expect(r.posted).toBe(true);
    expect(r.count).toBe(1);
    expect(r.batches).toBe(1);
    expect(r.unanchored).toHaveLength(1);
    expect(r.unanchored[0]?.text).toBe("line off the diff");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.comments).toHaveLength(1);
    const [anchored] = calls[0]!.comments;
    expect(anchored).toMatchObject({ path: "src/a.ts", line: 10, side: "RIGHT" });
  });

  it("drops findings on paths GitHub's diff does not show; the rest still post", async () => {
    const { client, calls } = fakeValidatingClient([
      { filename: "src/a.ts", patch: PATCH_10_TO_14 },
    ]);
    const findings: Finding[] = [
      { path: "src/a.ts", line: 11, severity: "high", text: "kept" },
      { path: "ghost.ts", line: 1, severity: "high", text: "path not in the PR" },
    ];
    const r = await postInlineReview(client, findings, REVIEW_TARGET);
    expect(r.posted).toBe(true);
    expect(r.count).toBe(1);
    expect(calls[0]?.comments.map((c) => c.path)).toEqual(["src/a.ts"]);
    // A path GitHub's diff doesn't show at all is "no patch" too — unanchored,
    // not silently dropped: the sticky comment still carries it.
    expect(r.unanchored.map((f) => f.path)).toEqual(["ghost.ts"]);
  });

  it("collapses a span whose start is off the diff to its valid end line", async () => {
    const { client, calls } = fakeValidatingClient([
      // Only lines 13..14 exist on GitHub's side.
      { filename: "src/a.ts", patch: "@@ -12,1 +13,2 @@\n line-x\n+line-y" },
    ]);
    const findings: Finding[] = [
      { path: "src/a.ts", line: 11, end_line: 14, severity: "high", text: "span" },
    ];
    const r = await postInlineReview(client, findings, REVIEW_TARGET);
    expect(r.posted).toBe(true);
    const only = calls[0]?.comments[0];
    expect(only).toMatchObject({ path: "src/a.ts", line: 14 });
    expect(only?.start_line).toBeUndefined();
  });

  it("collapses a span whose END is off the diff to its valid start line", async () => {
    const { client, calls } = fakeValidatingClient([
      // Only lines 10..11 exist on GitHub's side; the finding spans 10..14.
      { filename: "src/a.ts", patch: "@@ -9,1 +10,2 @@\n line-x\n+line-y" },
    ]);
    const findings: Finding[] = [
      { path: "src/a.ts", line: 10, end_line: 14, severity: "high", text: "span" },
    ];
    const r = await postInlineReview(client, findings, REVIEW_TARGET);
    expect(r.posted).toBe(true);
    const only = calls[0]?.comments[0];
    expect(only).toMatchObject({ path: "src/a.ts", line: 10 });
    expect(only?.start_line).toBeUndefined();
  });

  // MEDIUM coverage gap: the two collapse tests above only check `line` — this
  // pins the FULL posted shape for a collapsed span, proving `start_line` AND
  // `start_side` are BOTH stripped (validateAnchor's destructure drops both;
  // a payload carrying `start_side` with no `start_line` would be exactly the
  // kind of half-valid span shape the Reviews API's 422 (pr72 fixture) rejects).
  it("collapsing a span drops BOTH start_line and start_side — no half-valid span field reaches the payload", async () => {
    const { client, calls } = fakeValidatingClient([
      // Only lines 13..14 exist on GitHub's side; the finding spans 11..14 — the
      // START is off the diff, only the END anchors, so validateAnchor collapses.
      { filename: "src/a.ts", patch: "@@ -12,1 +13,2 @@\n line-x\n+line-y" },
    ]);
    const findings: Finding[] = [
      { path: "src/a.ts", line: 11, end_line: 14, severity: "high", text: "collapsed span" },
    ];

    const r = await postInlineReview(client, findings, REVIEW_TARGET);

    expect(r.posted).toBe(true);
    expect(r.count).toBe(1);
    const only = calls[0]?.comments[0];
    expect(only).toBeDefined();
    // The collapsed comment posts on its anchored END line, RIGHT side...
    expect(only?.path).toBe("src/a.ts");
    expect(only?.line).toBe(14);
    expect(only?.side).toBe("RIGHT");
    // ...with NEITHER start field left dangling from the rejected span half.
    expect(only).not.toHaveProperty("start_line");
    expect(only).not.toHaveProperty("start_side");
    // Scan the literal payload GitHub would receive — same rigor as the
    // subject_type/position scan below — proving no invalid span half survives.
    const serialized = JSON.stringify(calls[0]?.comments ?? []);
    expect(serialized).not.toContain("start_line");
    expect(serialized).not.toContain("start_side");
  });

  it("bisects the batch when the whole thing 422s once, posting both halves individually", async () => {
    const { client, calls } = fakeValidatingClient(
      [{ filename: "src/a.ts", patch: PATCH_10_TO_14 }],
      { failFirst: true },
    );
    const findings: Finding[] = [
      { path: "src/a.ts", line: 10, severity: "high", text: "first" },
      { path: "src/a.ts", line: 12, severity: "low", text: "second" },
    ];
    const r = await postInlineReview(client, findings, REVIEW_TARGET);
    expect(r.posted).toBe(true);
    expect(r.count).toBe(2);
    expect(r.dropped).toEqual([]);
    // The whole 2-comment batch 422d once, so it bisected into two single-comment
    // reviews — both of which succeed (the fake's single failure is spent).
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.comments).toHaveLength(1);
      expect(call.comments[0]?.line).toBeDefined();
    }
  });
});

describe("postInlineReview — batching + 422 bisection (AC-5)", () => {
  it("batches at MAX_COMMENTS_PER_REVIEW and reports no-patch files as unanchored — never subject_type", async () => {
    const anchorableFiles = Array.from({ length: 45 }, (_, i) => ({
      filename: `f${i}.ts`,
      patch: "@@ -1,1 +1,1 @@\n+x",
    }));
    // No `patch` key at all — GitHub omits it on binary/huge files.
    const unanchorableFiles = Array.from({ length: 5 }, (_, i) => ({ filename: `g${i}.ts` }));
    const { client, calls } = fakeValidatingClient([...anchorableFiles, ...unanchorableFiles]);

    const findings: Finding[] = [
      ...Array.from(
        { length: 45 },
        (_, i): Finding => ({
          path: `f${i}.ts`,
          line: 1,
          severity: "low",
          text: `anchorable ${i}`,
        }),
      ),
      ...Array.from(
        { length: 5 },
        (_, i): Finding => ({
          path: `g${i}.ts`,
          line: 1,
          severity: "low",
          text: `unanchorable ${i}`,
        }),
      ),
    ];

    const r = await postInlineReview(client, findings, REVIEW_TARGET);

    expect(r.posted).toBe(true);
    expect(r.count).toBe(45);
    expect(r.batches).toBe(2);
    expect(r.dropped).toEqual([]);
    expect(r.unanchored).toHaveLength(5);
    expect(r.unanchored.map((f) => f.path).sort()).toEqual(
      Array.from({ length: 5 }, (_, i) => `g${i}.ts`).sort(),
    );
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.comments.length).sort((a, b) => a - b)).toEqual([15, 30]);
    expect(calls[0]?.comments).toHaveLength(MAX_COMMENTS_PER_REVIEW);

    // The real 422 body rejects exactly `subjectType`/`position` — scan the
    // recorded request payloads directly to prove neither key is ever emitted.
    const serialized = JSON.stringify(calls.flatMap((c) => c.comments));
    expect(serialized).not.toContain("subject_type");
    expect(serialized).not.toContain("subjectType");
    expect(serialized).not.toContain('"position"');
  });

  it("bisects a batch containing one poison comment (real PR-72 422) so the rest still post", async () => {
    const fixtureText = pr72FixtureText();
    const poisonPath = "poison.ts";
    const calls: { comments: ReviewComment[] }[] = [];
    const client: ReviewClient = {
      rest: {
        pulls: {
          createReview: async (p) => {
            if (p.comments.some((c) => c.path === poisonPath)) {
              throw new Error(fixtureText);
            }
            calls.push({ comments: p.comments });
            return {
              data: {
                html_url: "https://github.com/test-org/test-repo/pull/42#pullrequestreview-poison",
              },
            };
          },
        },
      },
    };
    const findings: Finding[] = [
      { path: "a.ts", line: 1, severity: "low", text: "ok a" },
      { path: poisonPath, line: 1, severity: "low", text: "bad anchor" },
      { path: "b.ts", line: 1, severity: "low", text: "ok b" },
    ];

    const r = await postInlineReview(client, findings, REVIEW_TARGET);

    expect(r.posted).toBe(true);
    expect(r.count).toBe(2);
    expect(r.reason).toBeUndefined();
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]?.path).toBe(poisonPath);
    const postedPaths = calls.flatMap((c) => c.comments.map((cm) => cm.path)).sort();
    expect(postedPaths).toEqual(["a.ts", "b.ts"]);
  });

  // BLOCKER regression: a bisected batch's `left` half posts for real (a live
  // GitHub comment now exists) and its `right` half then hits a NON-422 error.
  // Before the fix, that non-422 was rethrown out of the recursive `postBatch`
  // call uncaught, unwinding straight past `left`'s already-resolved success —
  // `postComments` folded the whole batch into `posted:false`, so the caller
  // (and the next round) would believe NOTHING posted and repost `left`'s
  // findings as duplicates of the comments already sitting on GitHub.
  it("preserves a bisected LEFT half's real posted comments when the RIGHT half then throws a non-422", async () => {
    const okPath = "ok.ts";
    const failPath = "fail.ts";
    const calls: { comments: ReviewComment[] }[] = [];
    const client: ReviewClient = {
      rest: {
        pulls: {
          createReview: async (p) => {
            // The combined 2-comment batch 422s first, forcing bisection...
            if (p.comments.length > 1) {
              throw new Error("422 Unprocessable Entity: could not resolve one comment");
            }
            // ...then, isolated alone, the ok comment posts for real...
            if (p.comments.some((c) => c.path === okPath)) {
              calls.push({ comments: p.comments });
              return {
                data: {
                  html_url: "https://github.com/test-org/test-repo/pull/42#pullrequestreview-left",
                },
              };
            }
            // ...but the failing one hits a genuine, non-bisectable error (NOT a
            // 422 — permissions/network class), which must not erase the above.
            throw new Error("500 Internal Server Error");
          },
        },
      },
    };
    const findings: Finding[] = [
      { path: okPath, line: 1, severity: "low", text: "posts fine" },
      { path: failPath, line: 1, severity: "low", text: "hits a real error" },
    ];

    const r = await postInlineReview(client, findings, REVIEW_TARGET);

    // The left half's real, already-posted comment is NOT lost...
    expect(r.posted).toBe(true);
    expect(r.count).toBe(1);
    expect(r.url).toBe("https://github.com/test-org/test-repo/pull/42#pullrequestreview-left");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.comments.map((c) => c.path)).toEqual([okPath]);
    // ...and a failure/reason marker still surfaces the non-422 (it's neither
    // "posted" nor "dropped" — dropped means GitHub itself rejected it (422)).
    expect(r.reason).toContain("500");
    expect(r.dropped).toEqual([]);
  });

  // MEDIUM coverage gap this regression closes: a WHOLESALE non-422 on the very
  // FIRST `createReview` call (nothing has bisected, nothing has posted at all)
  // must keep the pre-existing posted:false/reason outcome, with an empty
  // `dropped` (this finding was never isolated as poison — the whole call just
  // failed for a reason unrelated to any one comment).
  it("wholesale non-422 on the very first createReview call: posted:false + reason, dropped stays empty", async () => {
    const client: ReviewClient = {
      rest: {
        pulls: {
          createReview: async () => {
            throw new Error("403 Forbidden: token lacks pull-requests:write");
          },
        },
      },
    };
    const findings: Finding[] = [
      { path: "a.ts", line: 1, severity: "low", text: "a" },
      { path: "b.ts", line: 1, severity: "low", text: "b" },
    ];

    const r = await postInlineReview(client, findings, REVIEW_TARGET);

    expect(r.posted).toBe(false);
    expect(r.count).toBe(0);
    expect(r.reason).toContain("403");
    expect(r.dropped).toEqual([]);
    expect(r.url).toBeUndefined();
  });

  it("batch 2+ posts a COMMENT-event review with the 'continued' body, never repeating the verdict pointer", async () => {
    const { client, calls } = fakeReviewClient();
    // 31 anchored findings on distinct paths → 30 in batch 1, 1 in batch 2.
    const findings: Finding[] = Array.from(
      { length: 31 },
      (_, i): Finding => ({ path: `f${i}.ts`, line: 1, severity: "low", text: `finding ${i}` }),
    );

    const r = await postInlineReview(client, findings, REVIEW_TARGET);

    expect(r.posted).toBe(true);
    expect(r.batches).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.comments).toHaveLength(MAX_COMMENTS_PER_REVIEW);
    expect(calls[1]?.comments).toHaveLength(1);

    // Every batch — including 2+ — is a COMMENT event (advisory, never blocking).
    expect(calls[0]?.event).toBe("COMMENT");
    expect(calls[1]?.event).toBe("COMMENT");

    // Batch 1 alone points at the summary comment for the verdict...
    expect(calls[0]?.body).toBe(
      "🤖 AI Code Review — 31 inline comment(s) across 2 reviews. See the summary comment for " +
        "the full verdict.",
    );
    // ...batch 2 is exactly the "continued" pointer, with no repeated verdict text.
    expect(calls[1]?.body).toBe("🤖 AI Code Review — continued (review 2/2, 1 more comment(s)).");
    expect(calls[1]?.body).not.toContain("summary comment for the full verdict");
    expect(calls[1]?.body).not.toContain("See the summary comment");
  });

  it("the builder emits line/side, never the fixture's rejected subjectType/position fields", async () => {
    const fixtureText = pr72FixtureText();
    // The real 422 rejects exactly these two GraphQL variable fields — the
    // evidence that a file-level (`subject_type`, no `line`) shape is unsafe.
    expect(fixtureText).toContain("subjectType");
    expect(fixtureText).toContain("position");

    const { client, calls } = fakeReviewClient();
    const findings: Finding[] = [{ path: "src/a.ts", line: 5, severity: "low", text: "x" }];
    await postInlineReview(client, findings, REVIEW_TARGET);

    const comment = calls[0]?.comments[0];
    expect(comment).toBeDefined();
    expect(comment?.line).toBe(5);
    expect(comment?.side).toBe("RIGHT");
    expect(comment).not.toHaveProperty("position");
    expect(comment).not.toHaveProperty("subjectType");
    expect(comment).not.toHaveProperty("subject_type");
  });
});

/** A recording labels client capturing add/remove/create operations. */
function fakeLabelClient(opts: { failAdd?: boolean } = {}): {
  client: LabelClient;
  calls: { created: string[]; removed: string[]; added: string[][] };
} {
  const calls: { created: string[]; removed: string[]; added: string[][] } = {
    created: [],
    removed: [],
    added: [],
  };
  const client: LabelClient = {
    rest: {
      issues: {
        createLabel: async (p) => {
          calls.created.push(p.name);
          return {};
        },
        removeLabel: async (p) => {
          calls.removed.push(p.name);
          return {};
        },
        addLabels: async (p) => {
          if (opts.failAdd) throw new Error("403 labels API");
          calls.added.push(p.labels);
          return {};
        },
      },
    },
  };
  return { client, calls };
}

describe("setVerdictLabel", () => {
  it("adds merge-approved and removes request-changes on approved", async () => {
    const { client, calls } = fakeLabelClient();
    const r = await setVerdictLabel(client, "approved", LABEL_TARGET);
    expect(r.changed).toBe(true);
    expect(r.added).toBe("merge-approved");
    expect(calls.added).toEqual([["merge-approved"]]);
    expect(calls.removed).toEqual(["request-changes"]);
  });

  it("adds request-changes and removes merge-approved on changes", async () => {
    const { client, calls } = fakeLabelClient();
    const r = await setVerdictLabel(client, "changes", LABEL_TARGET);
    expect(r.added).toBe("request-changes");
    expect(calls.added).toEqual([["request-changes"]]);
    expect(calls.removed).toEqual(["merge-approved"]);
  });

  it("maps error to the request-changes label (a failed review must not auto-merge)", async () => {
    const { client, calls } = fakeLabelClient();
    const r = await setVerdictLabel(client, "error", LABEL_TARGET);
    expect(r.added).toBe("request-changes");
    expect(calls.removed).toEqual(["merge-approved"]);
  });

  it("MANAGE_LABELS=false → complete no-op", async () => {
    const { client, calls } = fakeLabelClient();
    const r = await setVerdictLabel(client, "approved", LABEL_TARGET, { manageLabels: false });
    expect(r.changed).toBe(false);
    expect(calls.created).toEqual([]);
    expect(calls.removed).toEqual([]);
    expect(calls.added).toEqual([]);
  });

  it("makes no change for an unknown verdict", async () => {
    const { client, calls } = fakeLabelClient();
    const r = await setVerdictLabel(client, "weird", LABEL_TARGET);
    expect(r.changed).toBe(false);
    expect(calls.added).toEqual([]);
  });

  it("is non-fatal: a failed add is caught and reported, not raised", async () => {
    const { client } = fakeLabelClient({ failAdd: true });
    const r = await setVerdictLabel(client, "approved", LABEL_TARGET);
    expect(r.changed).toBe(false);
    expect(r.reason).toContain("403");
  });
});
