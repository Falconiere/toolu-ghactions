// settleCheckCli.test.ts — the merge-gate/recompute action's CLI over a REAL completed
// review round (settleRound.ts): env in, GITHUB_OUTPUT file out, exactly as the runner
// hands them over. The recording GitHub store serves the round; `pulls.get` and the
// collaborators API are the two extra reads the CLI makes, answered at that boundary.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSettleCheckCli } from "@/gate/settleCheckCli.js";
import type { SettleCheckClient } from "@/gate/settleCheckCli.js";
import { DEFAULT_TRIGGER_PHRASE, parseMinTriggerPermission, parseTriggerPhrase } from "@/inputs.js";
import { cleanupRepos } from "@/__tests__/integration/harness.js";
import { dismiss, reviewedRound } from "@/__tests__/integration/settleRound.js";
import type { Round } from "@/__tests__/integration/settleRound.js";

const dirs: string[] = [];
afterEach(() => {
  cleanupRepos();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function outputFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "settle-out-"));
  dirs.push(dir);
  return join(dir, "github_output");
}

/** The round's store plus the pulls/collaborators reads, as GitHub would answer them. */
function client(round: Round, head: () => Promise<string>): SettleCheckClient {
  const { octokit } = round;
  return {
    graphql: (query, variables) => octokit.graphql(query, variables),
    rest: {
      ...octokit.rest,
      repos: {
        getCollaboratorPermissionLevel: async () => ({ data: { permission: "write" } }),
      },
      pulls: {
        ...octokit.rest.pulls,
        get: async () => ({ data: { head: { sha: await head() }, base: { ref: "main" } } }),
      },
    },
  };
}

function env(out: string, over: Record<string, string> = {}): Record<string, string> {
  return {
    INPUT_TOKEN: "ghs_test",
    INPUT_PR: "7",
    GITHUB_REPOSITORY: "test-org/test-repo",
    GITHUB_OUTPUT: out,
    ...over,
  };
}

describe("merge-gate recompute CLI (#123)", () => {
  it("AC-8: writes approve outputs for a round whose only finding was dismissed", async () => {
    const round = await reviewedRound(["medium"]);
    dismiss(round.threads[0]);
    const out = outputFile();
    const tokens: string[] = [];
    const result = await runSettleCheckCli(env(out), (token) => {
      tokens.push(token);
      return client(round, async () => round.headSha);
    });
    expect(result.outcome).toBe("approve");
    expect(tokens).toEqual(["ghs_test"]);
    expect(readFileSync(out, "utf8")).toBe(
      "outcome=approve\nreason=\nverdict=approved\nsettled=1\ntotal=1\n",
    );
  });

  it("AC-8: a 404 from pulls.get is written as unchanged no-head", async () => {
    const round = await reviewedRound(["medium"]);
    dismiss(round.threads[0]);
    const out = outputFile();
    const notFound = async (): Promise<string> => {
      throw new Error("Not Found (HTTP 404)");
    };
    await runSettleCheckCli(env(out), () => client(round, notFound));
    expect(readFileSync(out, "utf8")).toBe(
      "outcome=unchanged\nreason=no-head\nverdict=\nsettled=0\ntotal=0\n",
    );
  });

  it("AC-8: bad inputs never reach GitHub and are written as unchanged bad-input", async () => {
    const cases: Record<string, string>[] = [
      { INPUT_PR: "12; rm -rf /" },
      { INPUT_PR: "" },
      { INPUT_TOKEN: "" },
      { GITHUB_REPOSITORY: "test-org" },
      { GITHUB_REPOSITORY: "test-org/test-repo/extra" },
    ];
    for (const over of cases) {
      const out = outputFile();
      const result = await runSettleCheckCli(env(out, over), () => {
        throw new Error("must not build a client for bad input");
      });
      expect(result).toMatchObject({ outcome: "unchanged", reason: "bad-input" });
      expect(readFileSync(out, "utf8")).toContain("outcome=unchanged\nreason=bad-input\n");
    }
  });

  it("AC-8: MIN_TRIGGER_PERMISSION admin refuses a write-level dismisser", async () => {
    const round = await reviewedRound(["medium"]);
    dismiss(round.threads[0]);
    const out = outputFile();
    const result = await runSettleCheckCli(
      env(out, { INPUT_MIN_TRIGGER_PERMISSION: "ADMIN" }),
      () => client(round, async () => round.headSha),
    );
    expect(result).toMatchObject({ outcome: "unchanged", reason: "nothing-settled" });
  });
});

// This CLI used to hand-duplicate three input defaults that inputs.ts already parses
// (TRIGGER_PHRASE, MIN_TRIGGER_PERMISSION, APPROVE_BELOW). Nothing kept them in sync,
// and a drift means the merge-gate and the review run disagree about WHICH comment
// settles a finding — the gate would approve a PR the reviewer is still blocking, or
// the reverse. Both entry points now call the same pure parsers; these pin that the
// CLI really resolves through them, behaviourally, against the real round fixture.
describe("merge-gate recompute CLI — inputs resolve through inputs.ts's parsers", () => {
  it("an UNRECOGNIZED MIN_TRIGGER_PERMISSION falls back to write and accepts the dismisser", async () => {
    const round = await reviewedRound(["medium"]);
    dismiss(round.threads[0]);
    const out = outputFile();
    const result = await runSettleCheckCli(
      env(out, { INPUT_MIN_TRIGGER_PERMISSION: "maintain" }),
      () => client(round, async () => round.headSha),
    );
    // `maintain` is a typo, not a permission level: parseMinTriggerPermission warns and
    // falls back to "write", so the write-level dismisser IS honoured — the opposite of
    // the ADMIN case above, which refuses it. Same parser, same answer, both entry points.
    expect(parseMinTriggerPermission("maintain")).toBe("write");
    expect(result).toMatchObject({
      outcome: "approve",
      verdict: "approved",
      settled: 1,
      total: 1,
    });
  });

  it("TRIGGER_PHRASE really reaches the dismissal classifier", async () => {
    // The seeded reply says `@toolu dismiss`. Point the CLI at a different phrase and
    // the same reply stops being a dismissal — proving INPUT_TRIGGER_PHRASE is resolved
    // and passed on rather than silently defaulting.
    const round = await reviewedRound(["medium"]);
    dismiss(round.threads[0]);
    const out = outputFile();
    const result = await runSettleCheckCli(env(out, { INPUT_TRIGGER_PHRASE: "@other-bot" }), () =>
      client(round, async () => round.headSha),
    );
    expect(parseTriggerPhrase("@other-bot")).toBe("@other-bot");
    expect(result).toMatchObject({ outcome: "unchanged", reason: "nothing-settled" });
  });

  it("an unset TRIGGER_PHRASE keeps the default phrase working", async () => {
    const round = await reviewedRound(["medium"]);
    dismiss(round.threads[0]);
    const out = outputFile();
    const result = await runSettleCheckCli(env(out), () =>
      client(round, async () => round.headSha),
    );
    expect(parseTriggerPhrase("")).toBe(DEFAULT_TRIGGER_PHRASE);
    expect(result).toMatchObject({ outcome: "approve", settled: 1, total: 1 });
  });

  it("settleCheckCli.ts hand-rolls none of the three defaults (structural guard)", () => {
    // The behavioural cases above pass with EITHER implementation — a hand-rolled
    // ternary and the shared parser currently agree, which is precisely the problem:
    // nothing kept them that way. So pin the claim structurally, the same technique
    // state.compat.test.ts uses for its import guard: read the source and look for the
    // duplicated literals instead of trusting a runtime probe.
    const source = readFileSync(
      fileURLToPath(new URL("../settleCheckCli.ts", import.meta.url)),
      "utf8",
    );
    // All three resolved through inputs.ts / review/gate.ts, never re-spelled here.
    expect(source).toContain('from "@/inputs.js"');
    expect(source).toContain("parseTriggerPhrase(");
    expect(source).toContain("parseMinTriggerPermission(");
    expect(source).toContain("parseApproveBelow(");
    // The three defaults as they were duplicated before, and must not come back.
    expect(source).not.toContain('"@toolu"'); // TRIGGER_PHRASE fallback
    expect(source).not.toMatch(/===\s*"admin"/); // MIN_TRIGGER_PERMISSION ternary
    expect(source).not.toMatch(/\?\s*"admin"\s*:/); // …its other half
  });
});
