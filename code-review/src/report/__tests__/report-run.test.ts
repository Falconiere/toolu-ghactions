// report-run.test.ts — proves reportRun() cannot reject regardless of caller
// correctness: a deliberately malformed input (whose destructuring would throw
// synchronously if it ran outside the guard) still resolves, emits at most one
// core.warning, and never reaches core.setFailed. `publish.ts` awaits reportRun()
// with no try/catch of its own, so a rejection here would propagate through
// runReview() to main.ts's outer catch and fail the job — exactly what "Failure
// is silent by design" forbids. Complements publish-report.test.ts's coverage of
// the well-typed gate paths (AC-23/24/26) with the should-fix this file exists
// to pin: the WHOLE body of reportRun() — including the destructuring and its
// two early-return gates — now lives inside one try/catch, mirroring post.ts.
import { describe, expect, it, vi } from "vitest";
import * as core from "@actions/core";
import { reportRun } from "@/report/report-run.js";
import type { ReportRunInput } from "@/report/report-run.js";

/**
 * A deliberately malformed `ReportRunInput` — `input` is entirely absent, so
 * `const { inputs, context } = input;` inside `reportRun()` throws a synchronous
 * `TypeError` unless that line runs inside the try/catch. Built via `JSON.parse`
 * (typed `any` by its own signature) rather than an `as` cast: this repo's
 * `consistent-type-assertions` lint rule is `assertionStyle: "never"`, banning
 * type assertions outright — this mirrors `github/event.ts`'s own
 * fixture-loading idiom (`JSON.parse(...)` narrowed only by a return-type
 * annotation) for the identical reason.
 */
function malformedInput(): ReportRunInput {
  return JSON.parse("{}");
}

describe("reportRun — defensive against a malformed input (should-fix)", () => {
  it("resolves rather than rejects, warns at most once, and never fails the job", async () => {
    const warn = vi.spyOn(core, "warning").mockImplementation(() => {});
    const failed = vi.spyOn(core, "setFailed").mockImplementation(() => {});

    await expect(reportRun(malformedInput())).resolves.toBeUndefined();

    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
    expect(failed).not.toHaveBeenCalled();
  });
});
