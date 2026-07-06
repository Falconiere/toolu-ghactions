import { describe, it, expect } from "vitest";
import { postInlineReview } from "@/github/review.js";
import type { ReviewClient, ReviewComment, ReviewTarget } from "@/github/review.js";
import { setVerdictLabel } from "@/github/label.js";
import type { LabelClient, LabelTarget } from "@/github/label.js";
import type { Finding } from "@/llm/schema.js";

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
  calls: { comments: ReviewComment[]; body: string; commit_id: string }[];
} {
  const calls: { comments: ReviewComment[]; body: string; commit_id: string }[] = [];
  const client: ReviewClient = {
    rest: {
      pulls: {
        createReview: async (p) => {
          calls.push({ comments: p.comments, body: p.body, commit_id: p.commit_id });
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
  it("degrades an unmappable line to a file-level comment; the rest still post", async () => {
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
    expect(r.count).toBe(2);
    expect(r.degraded).toBe(1);
    expect(calls).toHaveLength(1);
    const [anchored, fileLevel] = calls[0]!.comments;
    expect(anchored).toMatchObject({ path: "src/a.ts", line: 10, side: "RIGHT" });
    expect(fileLevel).toMatchObject({ path: "src/a.ts", subject_type: "file" });
    expect(fileLevel?.line).toBeUndefined();
    // A suggestion cannot commit without a line anchor — stripped on degrade.
    expect(fileLevel?.body).not.toContain("```suggestion");
    expect(fileLevel?.body).toContain("line off the diff");
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

  it("retries ONCE with everything file-level when the batch still 422s", async () => {
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
    expect(r.degraded).toBe(2);
    expect(calls).toHaveLength(1); // the throwing attempt recorded nothing
    for (const c of calls[0]!.comments) {
      expect(c.subject_type).toBe("file");
      expect(c.line).toBeUndefined();
    }
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
