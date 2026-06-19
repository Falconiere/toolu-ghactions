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
    expect(single?.body).toBe("**high** _(correctness)_: off-by-one");

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
