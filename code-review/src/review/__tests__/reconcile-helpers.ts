// reconcile-helpers.ts — shared builders for the reconcile test files (a finding,
// a bot-authored prior thread, and canned replies), so the strict-matching and
// loose-matching suites stay under the file-size budget without duplicating setup.
import type { ReconcileFinding } from "@/review/reconcile.js";
import type { PriorThread, ThreadComment } from "@/github/threads.js";

/** The bot login every seeded thread uses. */
export const BOT = "toolu-bot";

/** Build a ReconcileFinding with defaults; fp defaults to a path:line-derived stub. */
export function finding(over: Partial<ReconcileFinding> = {}): ReconcileFinding {
  return {
    path: "src/a.ts",
    line: 10,
    fp: "fp-default",
    text: "a finding",
    severity: "medium",
    category: "correctness",
    ...over,
  };
}

/** Build a bot-authored PriorThread with defaults (no replies, unresolved, current). */
export function thread(over: Partial<PriorThread> = {}): PriorThread {
  return {
    threadId: "T_1",
    rootCommentId: 100,
    fp: "fp-default",
    path: "src/a.ts",
    line: 10,
    isResolved: false,
    isOutdated: false,
    rootBody: "**medium**: a finding\n\n<!-- toolu-fp:fp-default -->",
    replies: [],
    botLogin: BOT,
    ...over,
  };
}

/** A human reply — the author pushing back on the bot's finding. */
export const authorReply: ThreadComment = {
  author: "human-dev",
  body: "I disagree, this is intentional.",
};

/** A bot reply — the bot already answered in the thread. */
export const botReply: ThreadComment = {
  author: BOT,
  body: "Still flagging after re-review. ...",
};
