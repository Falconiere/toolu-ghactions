// selfNegating.test.ts — direct unit coverage for the no-defect sentence rule,
// on VERBATIM reviewer output. The end-to-end drops live in validate.test.ts;
// these pin the two edges reviews of this very PR surfaced: a finding concluding
// "no defect" (the pattern the original list missed — caught by the bot's own
// self-negating finding on this file), and the degenerate wrapper case.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { isSelfNegating } from "@/review/selfNegating.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PR175_EVIDENCE = z
  .object({
    comments: z.array(z.object({ id: z.number(), text: z.string() })),
  })
  .parse(JSON.parse(readFileSync(join(TEST_DIR, "fixtures", "pr175-evidence.json"), "utf8")));

function commentText(id: number): string {
  const comment = PR175_EVIDENCE.comments.find((entry) => entry.id === id);
  if (comment === undefined) throw new Error(`missing recorded PR 175 comment ${id}`);
  return comment.text;
}

describe("isSelfNegating — verbatim reviewer texts", () => {
  it("drops the bot's own self-negating finding on this module (ends 'no defect')", () => {
    // Verbatim from the PR #102 dogfood review of selfNegating.ts:90.
    expect(isSelfNegating("The logic is sound; no defect.")).toBe(false); // semicolon: one sentence, not a standalone conclusion
    expect(isSelfNegating("The logic is sound. No defect.")).toBe(true);
    expect(isSelfNegating("No defect.")).toBe(true);
    expect(isSelfNegating("No defects found.")).toBe(true);
  });

  it("keeps concede-then-accuse and does-not-work-as-intended findings", () => {
    expect(isSelfNegating("This is fine. The real bug is the missing await on line 12.")).toBe(
      false,
    );
    expect(isSelfNegating("The retry never fires, so the timeout does not work as intended.")).toBe(
      false,
    );
  });

  it("unwraps bold wrappers, including the degenerate empty body", () => {
    expect(isSelfNegating("**No issue.**")).toBe(true);
    expect(isSelfNegating("**X**")).toBe(false);
    expect(isSelfNegating("****")).toBe(false);
  });

  it("drops a recorded reviewer retraction even when it pivots to another claim", () => {
    // GitHub PR #175 comment 4058954936: the reviewer explicitly retracts the
    // inline claim, then tries to redirect this finding to a different location.
    expect(isSelfNegating(commentText(4058954936))).toBe(true);
  });
});
