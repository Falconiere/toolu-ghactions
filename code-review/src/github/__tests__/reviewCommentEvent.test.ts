import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveEvent } from "@/github/event.js";
import type { EventPayload } from "@/github/event.js";

// A `pull_request_review_comment` delivery in GitHub's webhook shape (a reply on one
// of the bot's inline threads). It resolves to the deterministic SETTLE pass — never
// to a model review — and only for a human reply that was just created.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "event");

function reply(): EventPayload {
  return JSON.parse(readFileSync(join(FIXTURES, "pull-request-review-comment.json"), "utf8"));
}

const resolve = (payload: EventPayload) =>
  resolveEvent({ eventName: "pull_request_review_comment", payload });

describe("resolveEvent — pull_request_review_comment (settle pass)", () => {
  it("resolves a created human reply to a settle decision on the PR", async () => {
    const r = await resolve(reply());
    expect(r).toMatchObject({
      run: true,
      reason: "review-comment-settle",
      settle: true,
      pr_number: 42,
      head_sha: "abc123def456",
      commenter: "human-dev",
      full_review: false,
    });
  });

  it("denies a bot-authored reply (the bot's own resolve notes must never loop)", async () => {
    const p = reply();
    const r = await resolve({
      ...p,
      comment: { ...p.comment, user: { login: "x[bot]", type: "Bot" } },
    });
    expect(r).toMatchObject({ run: false, reason: "bot-author" });
  });

  it("denies github-actions[bot] even when its type is not reported", async () => {
    const p = reply();
    const r = await resolve({
      ...p,
      comment: { ...p.comment, user: { login: "github-actions[bot]" } },
    });
    expect(r).toMatchObject({ run: false, reason: "bot-author" });
  });

  it("denies a top-level review comment — only a reply can settle a thread", async () => {
    const p = reply();
    const { in_reply_to_id: _dropped, ...topLevel } = p.comment ?? {};
    const r = await resolve({ ...p, comment: topLevel });
    expect(r).toMatchObject({ run: false, reason: "not-a-reply" });
  });

  it("denies an edited or deleted comment", async () => {
    for (const action of ["edited", "deleted"]) {
      const r = await resolve({ ...reply(), action });
      expect(r).toMatchObject({ run: false, reason: "unsupported-action" });
    }
  });

  it("denies a payload with no PR number", async () => {
    const p = reply();
    const r = await resolve({ ...p, pull_request: { ...p.pull_request, number: undefined } });
    expect(r).toMatchObject({ run: false, reason: "no-pr-number" });
  });
});
