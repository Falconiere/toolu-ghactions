// gate/settleCheckCli.ts — the merge-gate/recompute nested node24 action's logic (the
// entry, gate/settleCheckMain.ts, only wires process.env and a real Octokit in).
// Node-type actions get no argv, so inputs ride as env — INPUT_TOKEN, INPUT_PR,
// INPUT_APPROVE_BELOW, INPUT_TRIGGER_PHRASE, INPUT_MIN_TRIGGER_PERMISSION (underscore
// names: the runner maps `with:` keys to INPUT_<NAME> without touching dashes) — plus
// the runner's GITHUB_REPOSITORY and GITHUB_OUTPUT.
//
// ALWAYS resolves (the step exits 0): a bad input or any failure is written as
// `outcome=unchanged` with a reason and a `::warning`, and the bash gate keeps its
// missing-label problem — fail closed without turning the recompute into its own error.
import { appendFileSync } from "node:fs";
import type { CommentClient } from "@/github/comment.js";
import type { ThreadClient } from "@/github/threads.js";
import { headShaLookup, permissionLookup } from "@/github/lookups.js";
import type { LookupClient } from "@/github/lookups.js";
import { parseApproveBelow } from "@/review/gate.js";
import { runSettleCheck } from "./settleCheck.js";
import type { SettleCheckOutputs } from "./settleCheck.js";

/** Every GitHub call the recompute makes — all reads. */
export type SettleCheckClient = CommentClient & ThreadClient & LookupClient;

type Env = Record<string, string | undefined>;

/** Run the recompute from `env`, write its outputs, and return them. Never throws. */
export async function runSettleCheckCli(
  env: Env,
  makeClient: (token: string) => SettleCheckClient,
): Promise<SettleCheckOutputs> {
  const token = env["INPUT_TOKEN"]?.trim() ?? "";
  const pr = env["INPUT_PR"]?.trim() ?? "";
  const [owner = "", repo = "", extra] = (env["GITHUB_REPOSITORY"] ?? "").split("/");
  let outputs: SettleCheckOutputs;
  if (token === "" || !/^[0-9]+$/.test(pr) || owner === "" || repo === "" || extra !== undefined) {
    warn("settle recompute: needs INPUT_TOKEN, a numeric INPUT_PR and GITHUB_REPOSITORY");
    outputs = { outcome: "unchanged", reason: "bad-input", verdict: "", settled: 0, total: 0 };
  } else {
    const client = makeClient(token);
    const coords = { owner, repo };
    outputs = await runSettleCheck({
      octokit: client,
      target: { ...coords, prNumber: Number(pr) },
      triggerPhrase: env["INPUT_TRIGGER_PHRASE"]?.trim() || "@toolu",
      minPermission:
        env["INPUT_MIN_TRIGGER_PERMISSION"]?.trim().toLowerCase() === "admin" ? "admin" : "write",
      approveBelow: parseApproveBelow(env["INPUT_APPROVE_BELOW"] ?? ""),
      lookupPermission: permissionLookup(client, coords),
      lookupHeadSha: headShaLookup(client, coords),
    });
  }
  process.stdout.write(
    `settle recompute: outcome=${outputs.outcome} reason=${outputs.reason || "-"} ` +
      `settled=${outputs.settled}/${outputs.total}\n`,
  );
  writeOutputs(env["GITHUB_OUTPUT"], outputs);
  return outputs;
}

/** Append `name=value` lines to the step's output file (every value is one line). */
function writeOutputs(file: string | undefined, outputs: SettleCheckOutputs): void {
  if (file === undefined || file === "") return;
  const lines = Object.entries(outputs).map(([k, v]) => `${k}=${String(v)}\n`);
  try {
    appendFileSync(file, lines.join(""));
  } catch (err) {
    warn(`settle recompute: could not write GITHUB_OUTPUT (${String(err)})`);
  }
}

function warn(text: string): void {
  process.stdout.write(`::warning::${text}\n`);
}
