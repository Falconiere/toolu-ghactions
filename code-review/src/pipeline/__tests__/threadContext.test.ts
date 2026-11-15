// threadContext.test.ts — the prompt's prior-thread block presents a thread as settled
// ("do not re-raise") only when review/dismissal.ts classified it settled. A thread the
// bot resolved itself, or one the PR's opener resolved without write access, is still
// live: telling the model otherwise would hide a finding nobody with authority waived.
import { describe, expect, it } from "vitest";
import { buildThreadContexts } from "@/pipeline/threadContext.js";
import { BOT, thread } from "@/review/__tests__/reconcile-helpers.js";

describe("buildThreadContexts", () => {
  it("does not present a bot- or unauthorized-resolved thread as settled", () => {
    const [byBot, byAuthor] = buildThreadContexts([
      thread({ isResolved: true, resolvedBy: `${BOT}[bot]` }),
      thread({ isResolved: true, resolvedBy: "pr-author" }),
    ]);
    expect(byBot?.resolved).toBe(false);
    expect(byAuthor?.resolved).toBe(false);
    expect(byBot?.dismissal).toBeUndefined();
  });

  it("presents an authorized human resolution as resolved, and keeps reply dismissals", () => {
    const [resolved, explicit] = buildThreadContexts([
      thread({ isResolved: true, resolvedBy: "maintainer", dismissal: "resolved" }),
      thread({ dismissal: "explicit" }),
    ]);
    expect(resolved?.resolved).toBe(true);
    expect(resolved?.dismissal).toBeUndefined();
    expect(explicit?.dismissal).toBe("explicit");
  });
});
