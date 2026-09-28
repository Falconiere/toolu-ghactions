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
import { PR307_COMMENTS } from "./pr307-evidence.js";

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
  it("drops a theoretical finding that explicitly concludes it is not a practical concern", () => {
    expect(
      isSelfNegating(
        "The keys would collide. This is a theoretical edge case, not a practical concern.",
      ),
    ).toBe(true);
    expect(
      isSelfNegating(
        "This is a theoretical edge case, not a practical concern. The real defect is the missing await.",
      ),
    ).toBe(false);
  });
  it("drops the bot's own self-negating finding on this module (ends 'no defect')", () => {
    // Verbatim from the PR #102 dogfood review of selfNegating.ts:90.
    // The final sentence's last clause concludes no defect (PR #307 clause rule).
    expect(isSelfNegating("The logic is sound; no defect.")).toBe(true);
    expect(isSelfNegating("The logic is sound. No defect.")).toBe(true);
    expect(isSelfNegating("No defect.")).toBe(true);
    expect(isSelfNegating("No defects found.")).toBe(true);
  });

  it("drops the no-finding and praise-only conclusions posted on PR #125", () => {
    expect(
      isSelfNegating(
        "The `container` field is initialized to `None`. This is correct for jobs without containers. No findings.",
      ),
    ).toBe(true);
    expect(isSelfNegating("No findings. The missing await drops the error.")).toBe(false);
    expect(
      isSelfNegating(
        "The `workspace_gc` call is unchanged. It is still called after `prepare_job_dirs`, which is correct because the workspace must exist before garbage collection can be spawned.",
      ),
    ).toBe(true);
    expect(
      isSelfNegating(
        "The `start_local_services` call is unchanged. It is still called after context building, which is correct because the context must be available for service configuration.",
      ),
    ).toBe(true);
    expect(
      isSelfNegating(
        "The `GITHUB_EVENT_PATH` env var is still set after writing the event JSON. This is correct and matches the GitHub Actions documentation.",
      ),
    ).toBe(true);
    expect(
      isSelfNegating(
        "The `start_local_services` call is unchanged. It is still called after context building, which is correct because the context must be available for service configuration. But the returned error is ignored.",
      ),
    ).toBe(false);
    expect(
      isSelfNegating(
        "The startup error is silently ignored. The context is constructed before the call, which is correct because configuration needs the context.",
      ),
    ).toBe(false);
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

// Falconiere/comemory PR #307: every top-level code-review@v8 finding the PR
// collected (71). The 14 labelled `drop` reason inside `text` and only conclude
// "no defect" in their final sentence — "… is safe. No defect, abstain.", "… No
// deadlock risk.", "… a narrow simulation acceptable for testing the client-side
// refusal." The 57 labelled `keep` include concede-then-accuse bodies ("No defect,
// but the argument could be named `_guard` …") that must survive.
describe("isSelfNegating — PR #307 replay", () => {
  it.each(PR307_COMMENTS.map((c) => [c.id, c.expected, c] as const))(
    "comment %i → %s",
    (_id, expected, comment) => {
      expect(isSelfNegating(comment.text)).toBe(expected === "drop");
    },
  );

  it("labels exactly 14 of the 71 recorded comments as abstentions", () => {
    expect(PR307_COMMENTS).toHaveLength(71);
    expect(PR307_COMMENTS.filter((c) => c.expected === "drop")).toHaveLength(14);
  });

  it("keeps negated affirmations and contrastive conclusions", () => {
    expect(isSelfNegating("Clamping to 0 here is not acceptable for negative counts.")).toBe(false);
    expect(isSelfNegating("The retry is safe, but the error is dropped.")).toBe(false);
    expect(isSelfNegating("No defect, but `as` is a lossy cast.")).toBe(false);
    expect(isSelfNegating("No bounds check guards the index, so a short slice panics.")).toBe(
      false,
    );
  });
});
