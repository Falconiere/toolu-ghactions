import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveEvent } from "@/github/event.js";
import type { EventPayload } from "@/github/event.js";

// REAL recorded event payloads from ./fixtures/event — pull_request and
// issue_comment shapes the action actually receives. The permission lookup is
// injected so the security paths (insufficient perm, fail-closed throw) run with
// no network.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "event");

/** Load a recorded event payload fixture. */
function payload(name: string): EventPayload {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
}

/** A permission lookup that always returns a fixed permission string. */
const perm = (p: string) => async () => p;

describe("resolveEvent — pull_request", () => {
  it("runs a FULL review of HEAD with the base ref from the payload", async () => {
    const r = await resolveEvent({ eventName: "pull_request", payload: payload("pull-request") });
    expect(r.run).toBe(true);
    expect(r.reason).toBe("pull_request");
    expect(r.review_head).toBe("HEAD");
    expect(r.full_review).toBe(true);
    expect(r.base_ref).toBe("main");
    expect(r.pr_number).toBe(42);
    // The PR HEAD sha rides along — the incremental series converges on it,
    // never on GITHUB_SHA (the ephemeral test-merge commit).
    expect(r.head_sha).toBe("abc123def456");
  });

  it("omits head_sha when the payload carries none", async () => {
    const noHead: EventPayload = {
      ...payload("pull-request"),
      pull_request: { number: 42, base: { ref: "main" } },
    };
    const r = await resolveEvent({ eventName: "pull_request", payload: noHead });
    expect(r.run).toBe(true);
    expect(r.head_sha).toBeUndefined();
  });
});

describe("resolveEvent — issue_comment security gate", () => {
  it("runs a SCOPED review for an @mention by a write user, capturing the instruction", async () => {
    const r = await resolveEvent(
      { eventName: "issue_comment", payload: payload("issue-comment-pr") },
      { lookupPermission: perm("write"), lookupBaseRef: async () => "main" },
    );
    expect(r.run).toBe(true);
    expect(r.reason).toBe("mention");
    expect(r.review_head).toBe("FETCH_HEAD");
    // An instruction is present → scoped, not full.
    expect(r.instruction).toBe("focus on auth");
    expect(r.full_review).toBe(false);
    expect(r.commenter).toBe("alice");
    expect(r.comment_id).toBe(5551234);
    expect(r.base_ref).toBe("main");
  });

  it("runs a FULL review for an @mention with NO instruction by an admin user", async () => {
    // "@toolu review please take a look" carries an instruction; use a bare trigger here.
    const bare: EventPayload = {
      ...payload("issue-comment-pr"),
      comment: { id: 42, body: "@toolu review", user: { login: "alice", type: "User" } },
    };
    const r = await resolveEvent(
      { eventName: "issue_comment", payload: bare },
      { lookupPermission: perm("admin") },
    );
    expect(r.run).toBe(true);
    expect(r.instruction).toBe("");
    expect(r.full_review).toBe(true);
  });

  it("DENIES an @mention by a read-only user", async () => {
    const r = await resolveEvent(
      { eventName: "issue_comment", payload: payload("issue-comment-readonly") },
      { lookupPermission: perm("read") },
    );
    expect(r.run).toBe(false);
    expect(r.reason).toBe("insufficient-permission");
    expect(r.commenter).toBe("bob");
  });

  it("FAILS CLOSED when the permission lookup THROWS", async () => {
    const r = await resolveEvent(
      { eventName: "issue_comment", payload: payload("issue-comment-pr") },
      {
        lookupPermission: async () => {
          throw new Error("403 from collaborators API");
        },
      },
    );
    expect(r.run).toBe(false);
    expect(r.reason).toBe("permission-check-failed");
  });

  it("FAILS CLOSED when the permission lookup returns no permission string", async () => {
    const r = await resolveEvent(
      { eventName: "issue_comment", payload: payload("issue-comment-pr") },
      { lookupPermission: perm("") },
    );
    expect(r.run).toBe(false);
    expect(r.reason).toBe("permission-check-failed");
  });

  it("MIN_TRIGGER_PERMISSION=admin REJECTS a write user", async () => {
    const r = await resolveEvent(
      { eventName: "issue_comment", payload: payload("issue-comment-pr") },
      { lookupPermission: perm("write"), minTriggerPermission: "admin" },
    );
    expect(r.run).toBe(false);
    expect(r.reason).toBe("insufficient-permission");
  });

  it("MIN_TRIGGER_PERMISSION=admin ACCEPTS an admin user", async () => {
    const r = await resolveEvent(
      { eventName: "issue_comment", payload: payload("issue-comment-pr") },
      { lookupPermission: perm("admin"), minTriggerPermission: "admin" },
    );
    expect(r.run).toBe(true);
  });
});

describe("resolveEvent — issue_comment cheap guards (no API call)", () => {
  it("ignores a bot-authored comment", async () => {
    let looked = false;
    const r = await resolveEvent(
      { eventName: "issue_comment", payload: payload("issue-comment-bot") },
      {
        lookupPermission: async () => {
          looked = true;
          return "admin";
        },
      },
    );
    expect(r.run).toBe(false);
    expect(r.reason).toBe("bot-author");
    // The permission API must never be hit for a bot author.
    expect(looked).toBe(false);
  });

  it("ignores a comment that is not on a pull request", async () => {
    const r = await resolveEvent(
      { eventName: "issue_comment", payload: payload("issue-comment-not-pr") },
      { lookupPermission: perm("admin") },
    );
    expect(r.run).toBe(false);
    expect(r.reason).toBe("not-a-pull-request");
  });

  it("ignores a comment lacking the trigger phrase", async () => {
    const r = await resolveEvent(
      { eventName: "issue_comment", payload: payload("issue-comment-nophrase") },
      { lookupPermission: perm("admin") },
    );
    expect(r.run).toBe(false);
    expect(r.reason).toBe("no-trigger");
  });
});

describe("resolveEvent — other", () => {
  it("denies a missing payload", async () => {
    const r = await resolveEvent({ eventName: "pull_request", payload: null });
    expect(r.run).toBe(false);
    expect(r.reason).toBe("no-event-payload");
  });

  it("denies an unsupported event", async () => {
    const r = await resolveEvent({ eventName: "push", payload: {} });
    expect(r.run).toBe(false);
    expect(r.reason).toBe("unsupported-event");
  });
});
