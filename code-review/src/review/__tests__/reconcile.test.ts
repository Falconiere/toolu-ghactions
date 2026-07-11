import { describe, expect, it } from "vitest";
import { dropResolved, reconcile } from "@/review/reconcile.js";
import type { ReconcileFinding } from "@/review/reconcile.js";
import type { PriorThread, ThreadComment } from "@/github/threads.js";

const BOT = "toolu-bot";

/** Build a ReconcileFinding with defaults; fp defaults to a path:line-derived stub. */
function finding(over: Partial<ReconcileFinding> = {}): ReconcileFinding {
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
function thread(over: Partial<PriorThread> = {}): PriorThread {
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

const authorReply: ThreadComment = {
  author: "human-dev",
  body: "I disagree, this is intentional.",
};
const botReply: ThreadComment = { author: BOT, body: "Still flagging after re-review. ..." };

describe("reconcile", () => {
  it("posts a brand-new finding (no matching prior thread) via toCreate", () => {
    const f = finding({ fp: "fp-new" });
    const plan = reconcile([f], []);
    expect(plan.toCreate).toEqual([f]);
    expect(plan.toReply).toEqual([]);
    expect(plan.toResolve).toEqual([]);
  });

  it("dedups a finding that matches a prior thread by fingerprint (not re-posted)", () => {
    const f = finding({ fp: "fp-shared" });
    const t = thread({ fp: "fp-shared", line: 999 }); // line differs; fp still matches
    const plan = reconcile([f], [t]);
    expect(plan.toCreate).toEqual([]);
  });

  it("dedups a reworded finding that matches a prior thread by exact path+line", () => {
    // The model reworded its text → different fp, but it is the same finding at the same spot.
    const f = finding({ fp: "fp-reworded", path: "src/x.ts", line: 42 });
    const t = thread({ fp: "fp-original", path: "src/x.ts", line: 42 });
    const plan = reconcile([f], [t]);
    expect(plan.toCreate).toEqual([]);
  });

  it("does NOT match by path+line when the thread line is null (detached)", () => {
    const f = finding({ fp: "fp-a", path: "src/x.ts", line: 42 });
    const t = thread({ fp: "fp-b", path: "src/x.ts", line: null });
    const plan = reconcile([f], [t]);
    // No fp match and the thread has no line → treated as a different, gone finding.
    expect(plan.toCreate).toEqual([f]);
    expect(plan.toResolve).toEqual([t]);
  });

  it("resolves an unresolved bot thread whose finding is gone this run (accepted rebuttal)", () => {
    const t = thread({ fp: "fp-dropped", replies: [authorReply] });
    const plan = reconcile([], [t]);
    expect(plan.toResolve).toEqual([t]);
    expect(plan.toReply).toEqual([]);
  });

  it("replies in place when a persisting finding's thread has the author's last word", () => {
    const f = finding({ fp: "fp-keep" });
    const t = thread({ fp: "fp-keep", replies: [authorReply] });
    const plan = reconcile([f], [t]);
    expect(plan.toReply).toHaveLength(1);
    expect(plan.toReply[0]?.thread).toBe(t);
    expect(plan.toReply[0]?.finding).toBe(f);
    expect(plan.toCreate).toEqual([]); // deduped
    expect(plan.toResolve).toEqual([]);
  });

  it("stays silent (no reply, no dup) when the bot already had the last word", () => {
    const f = finding({ fp: "fp-keep" });
    const t = thread({ fp: "fp-keep", replies: [authorReply, botReply] });
    const plan = reconcile([f], [t]);
    expect(plan.toReply).toEqual([]);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toResolve).toEqual([]);
  });

  it("stays silent when a persisting finding's thread has no replies at all", () => {
    const f = finding({ fp: "fp-keep" });
    const t = thread({ fp: "fp-keep", replies: [] });
    const plan = reconcile([f], [t]);
    expect(plan.toReply).toEqual([]);
    expect(plan.toCreate).toEqual([]);
  });

  it("never re-acts on a resolved thread but still covers its finding (no dup re-post)", () => {
    const f = finding({ fp: "fp-resolved" });
    const t = thread({ fp: "fp-resolved", isResolved: true, replies: [authorReply] });
    const plan = reconcile([f], [t]);
    expect(plan.toReply).toEqual([]); // respect the resolution
    expect(plan.toResolve).toEqual([]); // not re-resolved
    expect(plan.toCreate).toEqual([]); // but still deduped — don't reopen with a new comment
  });

  it("does not resolve a resolved thread whose finding is also gone", () => {
    const t = thread({ fp: "fp-x", isResolved: true });
    const plan = reconcile([], [t]);
    expect(plan.toResolve).toEqual([]);
  });

  it("resolves an OUTDATED unresolved thread whose finding is gone", () => {
    const t = thread({ fp: "fp-outdated", isOutdated: true });
    const plan = reconcile([], [t]);
    expect(plan.toResolve).toEqual([t]);
  });

  it("dedups duplicate open threads for one finding: keeps the first, resolves the extras", () => {
    // Two unresolved bot threads share a finding (e.g. left over from an earlier buggy run
    // that posted twice). The finding persists with the author's last word, so the FIRST
    // thread gets the reply and the duplicate is resolved — duplicates must not accumulate.
    const f = finding({ fp: "fp-dup" });
    const first = thread({ threadId: "T_first", fp: "fp-dup", replies: [authorReply] });
    const dup = thread({
      threadId: "T_dup",
      rootCommentId: 200,
      fp: "fp-dup",
      replies: [authorReply],
    });
    const plan = reconcile([f], [first, dup]);
    expect(plan.toReply.map((r) => r.thread.threadId)).toEqual(["T_first"]);
    expect(plan.toResolve.map((t) => t.threadId)).toEqual(["T_dup"]);
    expect(plan.toCreate).toEqual([]);
  });

  it("stays silent when the last reply has an unattributable (empty) author", () => {
    // A null GitHub author surfaces as "" — we can't tell it from the bot, so don't reply.
    const f = finding({ fp: "fp-keep" });
    const t = thread({ fp: "fp-keep", replies: [{ author: "", body: "ghost" }] });
    const plan = reconcile([f], [t]);
    expect(plan.toReply).toEqual([]);
    expect(plan.toCreate).toEqual([]);
  });

  it("stays silent when the bot login is unknown (empty), even with an author reply", () => {
    const f = finding({ fp: "fp-keep" });
    const t = thread({ fp: "fp-keep", botLogin: "", replies: [authorReply] });
    const plan = reconcile([f], [t]);
    expect(plan.toReply).toEqual([]);
    expect(plan.toCreate).toEqual([]); // still deduped (it is our thread via the fp marker)
  });

  it("handles a mixed run: create new, reply to one, resolve another", () => {
    const kept = finding({ fp: "fp-keep", path: "src/k.ts", line: 1 });
    const fresh = finding({ fp: "fp-fresh", path: "src/f.ts", line: 2 });
    const keptThread = thread({
      threadId: "T_keep",
      fp: "fp-keep",
      path: "src/k.ts",
      line: 1,
      replies: [authorReply],
    });
    const droppedThread = thread({ threadId: "T_drop", fp: "fp-drop", path: "src/d.ts", line: 3 });

    const plan = reconcile([kept, fresh], [keptThread, droppedThread]);
    expect(plan.toCreate).toEqual([fresh]);
    expect(plan.toReply.map((r) => r.thread.threadId)).toEqual(["T_keep"]);
    expect(plan.toResolve.map((t) => t.threadId)).toEqual(["T_drop"]);
  });
});

describe("dropResolved", () => {
  it("suppresses a finding whose resolved thread matches by fingerprint (line drifted)", () => {
    const f = finding({ fp: "fp-done", line: 42 });
    const t = thread({ fp: "fp-done", line: 10, isResolved: true });
    const { kept, suppressed } = dropResolved([f], [t]);
    expect(kept).toEqual([]);
    expect(suppressed).toEqual([f]);
  });

  it("suppresses a reworded finding whose resolved thread matches by exact path+line", () => {
    const f = finding({ fp: "fp-reworded", path: "src/a.ts", line: 10 });
    const t = thread({ fp: "fp-original", path: "src/a.ts", line: 10, isResolved: true });
    const { kept, suppressed } = dropResolved([f], [t]);
    expect(kept).toEqual([]);
    expect(suppressed).toEqual([f]);
  });

  it("keeps a finding whose matching thread is NOT resolved", () => {
    const f = finding({ fp: "fp-open" });
    const t = thread({ fp: "fp-open", isResolved: false });
    const { kept, suppressed } = dropResolved([f], [t]);
    expect(kept).toEqual([f]);
    expect(suppressed).toEqual([]);
  });

  it("keeps everything when there are no prior threads", () => {
    const f = finding({ fp: "fp-any" });
    const { kept, suppressed } = dropResolved([f], []);
    expect(kept).toEqual([f]);
    expect(suppressed).toEqual([]);
  });

  it("splits a mixed run: resolved-covered suppressed, the rest kept", () => {
    const done = finding({ fp: "fp-done", path: "src/d.ts", line: 3 });
    const live = finding({ fp: "fp-live", path: "src/l.ts", line: 4 });
    const resolvedThread = thread({ fp: "fp-done", path: "src/d.ts", line: 3, isResolved: true });
    const openThread = thread({ fp: "fp-live", path: "src/l.ts", line: 4, isResolved: false });
    const { kept, suppressed } = dropResolved([done, live], [resolvedThread, openThread]);
    expect(kept).toEqual([live]);
    expect(suppressed).toEqual([done]);
  });
});
