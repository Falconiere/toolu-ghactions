// gate/settleCheckMain.ts — entry for the merge-gate/recompute nested action, bundled
// to merge-gate/recompute/index.cjs by build.mjs. All logic is in settleCheckCli.ts.
import * as github from "@actions/github";
import { runSettleCheckCli } from "./settleCheckCli.js";

void runSettleCheckCli(process.env, (token) => github.getOctokit(token));
