#!/usr/bin/env bun
// evals/run.ts — the eval harness entry point (AC-16, spec §Eval harness). Run
// with `bun evals/run.ts --help` (or `bun run eval -- --help`) — exits 0 with
// no env/key/network. A live run calls the SAME `runReview()` (src/pipeline.ts)
// main.ts calls, so distill -> mapPr (cartographer) -> reviewChunked (packages,
// bisection included) -> clusterFindings (via reconcile) -> render all run for
// real, against a REAL scratch git repo (evals/scratch.ts) built from a real
// PR's diff (evals/fetch.ts, via `gh`), with the REAL configured model — but
// GitHub posting is replaced by the integration suite's recording Octokit fake
// (src/__tests__/integration/github.ts) so nothing is actually posted.
//
// FETCHING: `gh`'s own `.diff` endpoint (`gh pr diff --patch`) 406s past 300
// changed files, so evals/fetch.ts fetches the paginated per-file "list pull
// request files" API instead (no such cap) — see its module doc.
//
// NOT part of `bun run check`: evals/ sits outside tsconfig's `include` and is
// listed in .oxlintrc.json's `ignorePatterns`, and vitest's own `include` glob
// (src/**/__tests__/**) never reaches here either — see evals/__tests__/ for
// this file's own tests, run directly with `bun test evals/__tests__`.
//
// METRICS: `strata`/`patternGroups` are recomputed by calling `distill()`
// ourselves on the identical diff object handed to `runReview` (pure,
// deterministic, zero-token — an exact replay of what Layer 0 computed
// internally, not a guess). `findings.raw`/`.clustered` and `coverage` are read
// off the run's REAL output (the decoded state marker, the rendered comment's
// own `### Coverage` line). `packages`/`modelCalls` are the one approximation:
// a wrapped `fetch` classifies each outgoing call as cartographer or not by its
// system prompt, but cannot tell a top-level package call from a bisection
// retry from outside chunked.ts — see scorecard.ts's field doc.
import { writeFileSync } from "node:fs";
import { errorMessage } from "@/errors.js";
import { distill } from "@/git/distill.js";
import { fetchDiff } from "@/git/diff.js";
import { runReview } from "@/pipeline.js";
import type { ReviewDeps } from "@/pipeline.js";
import { decodeMarker } from "@/state.js";
import { fakeOctokit } from "../src/__tests__/integration/github.js";
import { lastBody } from "../src/__tests__/integration/harness.js";
import { parseArgs, usage, ArgError, type EvalArgs } from "./args.js";
import { buildInputs, buildContext } from "./context.js";
import { fetchPr } from "./fetch.js";
import { parseFiles, buildScratchRepo, removeRepo, type Scratch } from "./scratch.js";
import {
  BODY_SIZE_LIMIT,
  strataCounts,
  biggestPatternGroup,
  parseCoverageSummary,
  computeFindingCounts,
  renderTable,
  renderJson,
  type Scorecard,
} from "./scorecard.js";

/** Every outgoing model call this run made, classified request-side only (the
 *  response is never touched — see the module doc's METRICS note). */
interface ModelCallTally {
  cartographer: number;
  other: number;
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Best-effort: the cartographer's system prompt is unmistakable
 *  (review/cartographer.ts's `CARTOGRAPHER_SYSTEM_PROMPT`). A body this cannot
 *  parse is simply not counted as cartographer — never thrown, this is
 *  instrumentation only and must never affect the live call it observes. */
function looksLikeCartographer(raw: string): boolean {
  try {
    const body: { messages?: { role?: string; content?: string }[] } = JSON.parse(raw);
    const system = body.messages?.find((m) => m.role === "system")?.content ?? "";
    return system.includes("You are the cartographer");
  } catch {
    return false;
  }
}

/** Wrap `real` to tally cartographer vs. package-layer calls, passing every
 *  request/response through untouched — the review itself must behave
 *  identically to a real, uninstrumented run. */
function makeRecordingFetch(real: typeof fetch, tally: ModelCallTally): typeof fetch {
  return async (input, init) => {
    const url = requestUrl(input);
    const body = typeof init?.body === "string" ? init.body : "";
    if (body !== "" && !url.includes("/machine/review-runs")) {
      if (looksLikeCartographer(body)) tally.cartographer += 1;
      else tally.other += 1;
    }
    return real(input, init);
  };
}

/** Caveats worth surfacing alongside the numbers, given what this run observed. */
function scorecardNotes(
  tally: ModelCallTally,
  coverage: Record<string, number>,
  body: string,
): string[] {
  const notes: string[] = [
    '"packages" and "model calls: package-layer" count every Layer-2 request ' +
      "including bisection retries — the harness cannot tell a top-level package " +
      "call from a bisected sub-call without instrumenting src/review/chunked.ts " +
      "(out of scope for evals/; see scorecard.ts).",
  ];
  if (tally.cartographer === 0) {
    notes.push(
      "No cartographer call observed — Layer 1 may have failed open (mapPr never throws), " +
        "or the run's diff was empty (Layer 0 skipped Layers 1/2 entirely).",
    );
  }
  if (Object.keys(coverage).length === 0) {
    notes.push(
      `Could not find a "### Coverage" line in the rendered comment (${body.length} bytes) — ` +
        "an empty-diff/no-op run, or review/render.ts's section format changed.",
    );
  }
  return notes;
}

async function runLive(args: EvalArgs, apiKey: string): Promise<Scorecard> {
  process.stdout.write(`Fetching ${args.owner}/${args.repo}#${args.prNumber} via gh...\n`);
  const pr = fetchPr(args.owner, args.repo, args.prNumber);

  process.stdout.write(
    `Replaying ${pr.files.length} changed file(s) into a scratch git repo (see evals/scratch.ts)...\n`,
  );
  const files = parseFiles(pr.files);
  const scratch: Scratch = buildScratchRepo(files, pr.baseRefName);

  try {
    const inputs = buildInputs(args, apiKey, pr.baseRefName);
    const context = buildContext(pr, args.owner, args.repo, scratch.headSha);
    const { octokit, rec } = fakeOctokit({ patches: scratch.patches });
    const tally: ModelCallTally = { cartographer: 0, other: 0 };
    const deps: ReviewDeps = {
      inputs,
      octokit,
      context,
      cwd: scratch.dir,
      fetch: makeRecordingFetch(fetch, tally),
    };

    const diff = fetchDiff({
      baseBranch: pr.baseRefName,
      githubBaseRef: pr.baseRefName,
      reviewHead: "HEAD",
      cwd: scratch.dir,
      maxFiles: 0,
      maxDiffLines: 0,
    });
    const distillation = distill(diff, { rulesPaths: [], cwd: scratch.dir });

    process.stdout.write(`Running the review (${diff.total_files} changed file(s))...\n`);
    const startMs = Date.now();
    const result = await runReview(deps);
    const wallMs = Date.now() - startMs;

    const body = lastBody(rec);
    const marker = decodeMarker(body);
    const coverage = parseCoverageSummary(body);
    const biggest = biggestPatternGroup(distillation.pattern_groups);

    return {
      pr: { owner: args.owner, repo: args.repo, number: args.prNumber },
      provider: args.provider,
      model: args.model,
      changedFiles: diff.total_files,
      strata: strataCounts(distillation.strata),
      patternGroups: {
        count: distillation.pattern_groups.length,
        biggestExemplar: biggest?.exemplar ?? null,
        biggestMembers: biggest?.members ?? 0,
      },
      packages: tally.other,
      modelCalls: {
        cartographer: tally.cartographer,
        packageLayer: tally.other,
        total: tally.cartographer + tally.other,
      },
      findings: computeFindingCounts(marker),
      coverage,
      markerBytes: { body: body.length, limit: BODY_SIZE_LIMIT },
      wallMs,
      verdict: result.verdict,
      notes: scorecardNotes(tally, coverage, body),
    };
  } finally {
    // A cleanup failure here (e.g. a permission error) must never REPLACE a
    // propagating error from the `try` above — caught and logged on its own,
    // not left to throw out of `finally` and mask whatever was already in flight.
    try {
      removeRepo(scratch.dir);
    } catch (cleanupErr) {
      process.stderr.write(
        `Warning: failed to remove scratch repo ${scratch.dir}: ${errorMessage(cleanupErr)}\n`,
      );
    }
  }
}

async function main(argv: readonly string[]): Promise<number> {
  let args: EvalArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof ArgError)) throw err;
    process.stderr.write(`${err.message}\n\n${usage()}`);
    return 1;
  }
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }

  const apiKey = process.env["API_KEY"] ?? "";
  if (apiKey === "") {
    process.stderr.write(
      "API_KEY is required for a live eval run (the same input the action reads).\n" +
        `Set it to your ${args.provider} API key and re-run, e.g.:\n` +
        `  API_KEY=sk-... bun run eval -- --pr ${args.owner}/${args.repo}#${args.prNumber}\n`,
    );
    return 1;
  }

  try {
    const scorecard = await runLive(args, apiKey);
    process.stdout.write(`\n${renderTable(scorecard)}`);
    if (args.out !== null) {
      writeFileSync(args.out, renderJson(scorecard));
      process.stdout.write(`\nWrote ${args.out}\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(`${errorMessage(err)}\n`);
    return 1;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

export { main };
