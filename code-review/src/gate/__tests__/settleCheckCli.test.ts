// settleCheckCli.test.ts — the merge-gate/recompute action's CLI over a REAL completed
// review round (settleRound.ts): env in, GITHUB_OUTPUT file out, exactly as the runner
// hands them over. The recording GitHub store serves the round; `pulls.get` and the
// collaborators API are the two extra reads the CLI makes, answered at that boundary.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSettleCheckCli } from "@/gate/settleCheckCli.js";
import type { SettleCheckClient } from "@/gate/settleCheckCli.js";
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
