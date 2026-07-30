// dismissal.test.ts — author-side dismissal detection: the explicit
// `<TRIGGER_PHRASE> dismiss` command, the ARGUED-OUT stalemate, and the
// fail-closed permission gate that keeps a drive-by commenter from silencing
// the reviewer on a public PR.
import { describe, expect, it, vi } from "vitest";
import { argumentExhausted, classifyDismissals, explicitDismissReply } from "@/review/dismissal.js";
import type { DismissalOptions } from "@/review/dismissal.js";
import { BOT, authorReply, botReply, thread } from "@/review/__tests__/reconcile-helpers.js";

/** The author login every seeded reply uses (matches reconcile-helpers). */
const AUTHOR = "human-dev";

/** A reply from the PR author with an arbitrary body. */
function says(body: string, author = AUTHOR) {
  return { author, body };
}

/** Options with a permission lookup that grants `write` to everyone. */
function allowAll(over: Partial<DismissalOptions> = {}): DismissalOptions {
  return {
    triggerPhrase: "@toolu",
    minPermission: "write",
    lookupPermission: async () => "write",
    ...over,
  };
}

describe("explicitDismissReply", () => {
  it("finds the `<phrase> dismiss` command in an author reply", () => {
    const t = thread({ replies: [says("@toolu dismiss — intentional, see ADR-12")] });
    expect(explicitDismissReply(t, "@toolu")?.body).toContain("ADR-12");
  });

  it("is case-insensitive and tolerates extra whitespace", () => {
    const t = thread({ replies: [says("@TOOLU   Dismiss")] });
    expect(explicitDismissReply(t, "@toolu")).not.toBeNull();
  });

  it("takes the LAST command when the author argued first and dismissed later", () => {
    const t = thread({ replies: [says("no, this is fine"), says("@toolu dismiss final answer")] });
    expect(explicitDismissReply(t, "@toolu")?.body).toContain("final answer");
  });

  it("ignores `dismissive` and other words that merely start with dismiss", () => {
    const t = thread({ replies: [says("@toolu dismissive tone aside, here is why...")] });
    expect(explicitDismissReply(t, "@toolu")).toBeNull();
  });

  it("requires the whole word: digits or underscores after `dismiss` are not the command", () => {
    for (const body of ["@toolu dismiss3", "@toolu dismiss_it", "@toolu dismissAll"]) {
      expect(explicitDismissReply(thread({ replies: [says(body)] }), "@toolu")).toBeNull();
    }
  });

  it("ignores the command inside a markdown blockquote (a QUOTED dismissal)", () => {
    const t = thread({ replies: [says("> @toolu dismiss\n\nI would not do that — here is why.")] });
    expect(explicitDismissReply(t, "@toolu")).toBeNull();
  });

  it("ignores the command inside an inline code span (SHOWING the syntax, not using it)", () => {
    const t = thread({
      replies: [says("You could reply `@toolu dismiss`, but I think this is a real bug.")],
    });
    expect(explicitDismissReply(t, "@toolu")).toBeNull();
  });

  it("ignores the command inside a fenced code block", () => {
    const t = thread({
      replies: [says("Docs snippet:\n\n```\n@toolu dismiss\n```\n\nNot doing it.")],
    });
    expect(explicitDismissReply(t, "@toolu")).toBeNull();
  });

  it("ignores the command after an UNTERMINATED fence (everything after renders as code)", () => {
    const t = thread({ replies: [says("Example:\n\n```\n@toolu dismiss")] });
    expect(explicitDismissReply(t, "@toolu")).toBeNull();
  });

  it("ignores the command in a tilde fence, an info-string fence, or a longer-closer fence", () => {
    const quoted = [
      "~~~\n@toolu dismiss\n~~~\n\nNot doing it.",
      "```js\n@toolu dismiss\n```\n\nNot doing it.",
      "````\n@toolu dismiss\n`````\n\nNot doing it.", // CommonMark: closer may be longer
      "~~~\n```\n@toolu dismiss\n~~~\n\nNot doing it.", // backtick line cannot close a tilde fence
    ];
    for (const body of quoted) {
      expect(explicitDismissReply(thread({ replies: [says(body)] }), "@toolu")).toBeNull();
    }
  });

  it("fires on a real command AFTER a closed fence (the fence must not swallow the rest)", () => {
    const t = thread({ replies: [says("```\nsome code\n```\n\n@toolu dismiss — by design.")] });
    expect(explicitDismissReply(t, "@toolu")?.body).toContain("by design");
  });

  it("still fires on a real command in the same reply as a quoted one", () => {
    const t = thread({
      replies: [says("The syntax is `@toolu dismiss` — and yes:\n\n@toolu dismiss, by design.")],
    });
    expect(explicitDismissReply(t, "@toolu")?.body).toContain("by design");
  });

  it("never accepts the command from the bot's own reply", () => {
    const t = thread({ replies: [{ author: BOT, body: "you could reply `@toolu dismiss`" }] });
    expect(explicitDismissReply(t, "@toolu")).toBeNull();
  });

  it("ignores an unattributable (empty-login) reply", () => {
    const t = thread({ replies: [says("@toolu dismiss", "")] });
    expect(explicitDismissReply(t, "@toolu")).toBeNull();
  });

  it("honours a custom trigger phrase and escapes its regex metacharacters", () => {
    const t = thread({ replies: [says("[bot.v2] dismiss")] });
    expect(explicitDismissReply(t, "[bot.v2]")).not.toBeNull();
    // The escaped phrase must not match a regex-wildcard variant of itself.
    expect(explicitDismissReply(thread({ replies: [says("[botXv2] dismiss")] }), "[bot.v2]")).toBe(
      null,
    );
  });

  it("returns null for an empty trigger phrase (no command to match)", () => {
    const t = thread({ replies: [says("dismiss")] });
    expect(explicitDismissReply(t, "  ")).toBeNull();
  });
});

describe("argumentExhausted", () => {
  it("is null on the author's FIRST reply — the bot is owed one rebuttal", () => {
    expect(argumentExhausted(thread({ replies: [authorReply] }))).toBeNull();
  });

  it("fires when the author answers again after the bot's rebuttal", () => {
    const t = thread({ replies: [authorReply, botReply, says("still no — it is intentional")] });
    expect(argumentExhausted(t)?.body).toContain("intentional");
  });

  it("is null while the BOT has the last word (the author has not answered yet)", () => {
    expect(argumentExhausted(thread({ replies: [authorReply, botReply] }))).toBeNull();
  });

  it("is null on a thread with no replies at all", () => {
    expect(argumentExhausted(thread({ replies: [] }))).toBeNull();
  });

  it("is null when the last reply is unattributable (empty login)", () => {
    const t = thread({ replies: [authorReply, botReply, says("ghost", "")] });
    expect(argumentExhausted(t)).toBeNull();
  });

  it("is null when the bot login is unknown — its own replies are indistinguishable", () => {
    const t = thread({ botLogin: "", replies: [authorReply, botReply, says("again")] });
    expect(argumentExhausted(t)).toBeNull();
  });

  it("stays exhausted when the bot's closing note landed but the resolve mutation failed", () => {
    // publish.ts replies THEN resolves, both best-effort. A failed resolve leaves the
    // bot as the last speaker on a thread whose argument already ended; re-reading it
    // as live would un-suppress the finding next run — the very loop this closes.
    const t = thread({
      replies: [
        authorReply,
        botReply,
        says("Still intentional."),
        { author: BOT, body: "Re-reviewed and we still read this differently. Resolving." },
      ],
    });
    expect(argumentExhausted(t)?.body).toBe("Still intentional.");
  });

  it("is still null when trailing bot replies leave only the author's FIRST reply", () => {
    // Stripping trailing bot replies must not manufacture exhaustion: [author, bot]
    // is the bot's one owed rebuttal, not a stalemate.
    expect(argumentExhausted(thread({ replies: [authorReply, botReply] }))).toBeNull();
    expect(argumentExhausted(thread({ replies: [authorReply, botReply, botReply] }))).toBeNull();
  });

  it("is null when only the bot has ever replied", () => {
    expect(argumentExhausted(thread({ replies: [botReply] }))).toBeNull();
  });
});

describe("classifyDismissals", () => {
  it("stamps `explicit` on a command from an authorized login", async () => {
    const t = thread({ replies: [says("@toolu dismiss")] });
    const [out] = await classifyDismissals([t], allowAll());
    expect(out?.dismissal).toBe("explicit");
  });

  it("stamps `exhausted` on a stalemate from an authorized login", async () => {
    const t = thread({ replies: [authorReply, botReply, says("no")] });
    const [out] = await classifyDismissals([t], allowAll());
    expect(out?.dismissal).toBe("exhausted");
  });

  it("prefers `explicit` over `exhausted` when both apply", async () => {
    const t = thread({ replies: [authorReply, botReply, says("@toolu dismiss")] });
    const [out] = await classifyDismissals([t], allowAll());
    expect(out?.dismissal).toBe("explicit");
  });

  it("leaves an already-resolved thread untouched (GitHub already settled it)", async () => {
    const t = thread({ isResolved: true, replies: [says("@toolu dismiss")] });
    const [out] = await classifyDismissals([t], allowAll());
    expect(out?.dismissal).toBeUndefined();
    expect(out).toBe(t); // returned verbatim, not copied
  });

  it("leaves a thread with neither channel undismissed", async () => {
    const [out] = await classifyDismissals([thread({ replies: [authorReply] })], allowAll());
    expect(out?.dismissal).toBeUndefined();
  });

  // --- FAIL-CLOSED permission gate ---

  it("refuses a dismissal from a login below the permission floor", async () => {
    const t = thread({ replies: [says("@toolu dismiss")] });
    const [out] = await classifyDismissals([t], allowAll({ lookupPermission: async () => "read" }));
    expect(out?.dismissal).toBeUndefined();
  });

  it("refuses an EXHAUSTED stalemate from a login below the permission floor", async () => {
    // The realistic case: a fork-PR author holds only `read` on the base repo, so the
    // auto-surrender channel must be gated exactly like the explicit command.
    const t = thread({ replies: [authorReply, botReply, says("no")] });
    const [out] = await classifyDismissals([t], allowAll({ lookupPermission: async () => "read" }));
    expect(out?.dismissal).toBeUndefined();
  });

  it("refuses an EXHAUSTED stalemate when no permission lookup is injected", async () => {
    const t = thread({ replies: [authorReply, botReply, says("no")] });
    const [out] = await classifyDismissals([t], allowAll({ lookupPermission: undefined }));
    expect(out?.dismissal).toBeUndefined();
  });

  it("refuses an EXHAUSTED stalemate when the permission lookup throws", async () => {
    const t = thread({ replies: [authorReply, botReply, says("no")] });
    const opts = allowAll({
      lookupPermission: async () => {
        throw new Error("500");
      },
    });
    const [out] = await classifyDismissals([t], opts);
    expect(out?.dismissal).toBeUndefined();
  });

  it("refuses a dismissal when the permission lookup throws", async () => {
    const t = thread({ replies: [says("@toolu dismiss")] });
    const opts = allowAll({
      lookupPermission: async () => {
        throw new Error("403");
      },
    });
    const [out] = await classifyDismissals([t], opts);
    expect(out?.dismissal).toBeUndefined();
  });

  it("refuses every dismissal when no permission lookup is injected", async () => {
    const t = thread({ replies: [says("@toolu dismiss")] });
    const [out] = await classifyDismissals([t], allowAll({ lookupPermission: undefined }));
    expect(out?.dismissal).toBeUndefined();
  });

  it("enforces MIN_TRIGGER_PERMISSION=admin (a write collaborator cannot dismiss)", async () => {
    const t = thread({ replies: [says("@toolu dismiss")] });
    const [out] = await classifyDismissals([t], allowAll({ minPermission: "admin" }));
    expect(out?.dismissal).toBeUndefined();
    const [admin] = await classifyDismissals(
      [t],
      allowAll({ minPermission: "admin", lookupPermission: async () => "admin" }),
    );
    expect(admin?.dismissal).toBe("explicit");
  });

  it("memoises the permission lookup per login across threads", async () => {
    const lookupPermission = vi.fn(async () => "write");
    const threads = [
      thread({ threadId: "T_1", replies: [says("@toolu dismiss")] }),
      thread({ threadId: "T_2", replies: [says("@toolu dismiss")] }),
      thread({ threadId: "T_3", replies: [says("@toolu dismiss")] }),
    ];
    const out = await classifyDismissals(threads, allowAll({ lookupPermission }));
    expect(out.map((t) => t.dismissal)).toEqual(["explicit", "explicit", "explicit"]);
    expect(lookupPermission).toHaveBeenCalledTimes(1);
    expect(lookupPermission).toHaveBeenCalledWith(AUTHOR);
  });
});
