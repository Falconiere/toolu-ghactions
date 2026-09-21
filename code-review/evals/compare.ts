// Paired real-tree evaluation: one pinned base/head, identical baseline responses,
// no GitHub writes. Source/request bodies live in memory only, never in output.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runReview } from "@/pipeline.js";
import { decodeMarker } from "@/state.js";
import { fakeOctokit } from "../src/__tests__/integration/github.js";
import { lastBody } from "../src/__tests__/integration/harness.js";
import { buildInputs, buildContext } from "./context.js";
import { parseCoverageSummary } from "./scorecard.js";
import type { EvalArgs } from "./args.js";

const Metadata = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string(),
  baseRefName: z.string(),
  headRefName: z.string(),
  baseRefOid: z.string(),
  headRefOid: z.string(),
});
const Label = z.object({
  path: z.string(),
  text: z.string(),
  expected: z.enum(["defect", "false_positive"]),
});
const Labels = z.array(Label);
/** Deterministic match against explicitly labeled known cases; unmatched findings need review. */
export function quality(
  findings: { path: string; text: string }[],
  labels: z.infer<typeof Labels>,
) {
  const matches = (f: { path: string; text: string }, label: z.infer<typeof Label>) =>
    f.path === label.path && f.text.toLowerCase().includes(label.text.toLowerCase());
  return {
    detectedDefects: labels.filter(
      (l) => l.expected === "defect" && findings.some((f) => matches(f, l)),
    ).length,
    missedDefects: labels.filter(
      (l) => l.expected === "defect" && !findings.some((f) => matches(f, l)),
    ).length,
    knownFalsePositives: labels.filter(
      (l) => l.expected === "false_positive" && findings.some((f) => matches(f, l)),
    ).length,
    unclassified: findings.filter((f) => !labels.some((l) => matches(f, l))).length,
  };
}
interface Wire {
  body: string;
  status: number;
  headers: [string, string][];
  elapsedMs: number;
}
function urlOf(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}
const Usage = z
  .object({
    model: z.string().optional(),
    usage: z
      .object({
        cost: z.number().optional(),
        prompt_tokens: z.number().optional(),
        completion_tokens: z.number().optional(),
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
/** Extract only accounting fields from JSON or SSE; never retain source in reports. */
export function accounting(body: string) {
  let model: string | undefined;
  let usage: z.infer<typeof Usage>["usage"];
  const frames = body.startsWith("data:")
    ? body
        .split("\n")
        .filter((s) => s.startsWith("data:"))
        .map((s) => s.slice(5).trim())
        .filter((s) => s !== "[DONE]")
    : [body];
  for (const frame of frames) {
    try {
      const parsed = Usage.safeParse(JSON.parse(frame));
      if (parsed.success) {
        model = parsed.data.model ?? model;
        usage = parsed.data.usage ?? usage;
      }
    } catch {
      /* malformed frames provide no accounting */
    }
  }
  return { model, usage };
}
/** Run both variants on the exact same Git tree and replay baseline responses in variant two. */
export async function compareJev(args: EvalArgs, apiKey: string) {
  if (args.provider !== "openrouter") throw new Error("--compare-jev requires openrouter");
  const repository = `${args.owner}/${args.repo}`;
  const raw = execFileSync(
    "gh",
    [
      "pr",
      "view",
      String(args.prNumber),
      "--repo",
      repository,
      "--json",
      "number,title,body,baseRefName,headRefName,baseRefOid,headRefOid",
    ],
    { encoding: "utf8" },
  );
  const pr = Metadata.parse(JSON.parse(raw));
  const base = args.baseSha ?? pr.baseRefOid;
  const head = args.headSha ?? pr.headRefOid;
  const labels = args.expectations
    ? Labels.parse(JSON.parse(readFileSync(args.expectations, "utf8")))
    : [];
  const parent = mkdtempSync(join(tmpdir(), "toolu-jev-eval-"));
  const cwd = join(parent, "repo");
  const git = (...argv: string[]) =>
    execFileSync("git", argv, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  try {
    execFileSync(
      "gh",
      ["repo", "clone", repository, cwd, "--", "--filter=blob:none", "--no-checkout"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    git("fetch", "origin", base, head);
    git("branch", "__jev_eval_base", base);
    git("checkout", "--detach", head);
    const revision = {
      base: git("rev-parse", base),
      head: git("rev-parse", "HEAD"),
      tree: git("rev-parse", "HEAD^{tree}"),
    };
    const cache = new Map<string, Wire[]>();
    const runs = [];

    for (const enabled of [false, true]) {
      const baseline = runs[0];
      if (
        enabled &&
        baseline &&
        ((baseline.coverage.unreviewed ?? 0) > 0 || (baseline.coverage.pending ?? 0) > 0)
      )
        break;
      const { octokit, rec } = fakeOctokit({ patches: {} });
      const calls: {
        kind: string;
        replayed: boolean;
        elapsedMs: number;
        model?: string;
        usage?: z.infer<typeof Usage>["usage"];
      }[] = [];
      const reads: Promise<void>[] = [];
      const offsets = new Map<string, number>();
      const recording: typeof fetch = async (url, init) => {
        const key = urlOf(url) + String(init?.body ?? "");
        const offset = offsets.get(key) ?? 0;
        offsets.set(key, offset + 1);
        const saved = enabled ? cache.get(key)?.[offset] : undefined;
        if (saved) {
          await new Promise((resolve) => setTimeout(resolve, saved.elapsedMs));
          calls.push({ kind: "baseline", replayed: true, elapsedMs: 0, ...accounting(saved.body) });
          return new Response(saved.body, { status: saved.status, headers: saved.headers });
        }
        const started = Date.now();
        const response = await fetch(url, init);
        const clone = response.clone();
        reads.push(
          (async () => {
            try {
              const body = await clone.text();
              const kind = urlOf(url).endsWith("/systemone")
                ? "jev"
                : enabled
                  ? "enhancement"
                  : "baseline";
              calls.push({
                kind,
                replayed: false,
                elapsedMs: Date.now() - started,
                ...accounting(body),
              });
              if (!enabled) {
                const values = cache.get(key) ?? [];
                values[offset] = {
                  body,
                  status: response.status,
                  headers: [...response.headers.entries()],
                  elapsedMs: Date.now() - started,
                };
                cache.set(key, values);
              }
            } catch {
              calls.push({ kind: "unavailable", replayed: false, elapsedMs: Date.now() - started });
            }
          })(),
        );
        return response;
      };
      const inputs = {
        ...buildInputs(args, apiKey, "__jev_eval_base"),
        jevEnabled: enabled,
        inlineComments: false,
        maxWallMs: args.maxWallMs || 600000,
      };
      const start = Date.now();
      const result = await runReview({
        inputs,
        octokit,
        cwd,
        context: buildContext(
          { ...pr, baseRefName: "__jev_eval_base", files: [] },
          args.owner,
          args.repo,
          revision.head,
        ),
        fetch: recording,
      });
      await Promise.all(reads);

      const body = lastBody(rec);
      const state = decodeMarker(body);
      const findings =
        "findings" in state
          ? state.findings.flatMap((f) =>
              typeof f.path === "string" && typeof f.text === "string"
                ? [{ path: f.path, text: f.text }]
                : [],
            )
          : [];
      runs.push({
        enabled,
        result,
        coverage: parseCoverageSummary(body),
        findings,
        quality: quality(findings, labels),
        calls,
        cost: calls.reduce((sum, c) => sum + (c.usage?.cost ?? 0), 0),
        paidCost: calls
          .filter((c) => !c.replayed)
          .reduce((sum, c) => sum + (c.usage?.cost ?? 0), 0),
        wallMs: Date.now() - start,
        enhancement: body.match(/Jev: [^\n]+/)?.[0] ?? null,
      });
    }
    return {
      repository,
      pr: args.prNumber,
      revision,
      riskConfidenceThreshold: 0.8,
      notes: [
        "Baseline responses and per-request latency replayed for enhanced run; no second baseline API charge. Incomplete baseline coverage skips paired enhancement.",
        "Unclassified findings require human adjudication; counts alone do not measure quality.",
      ],
      runs,
    };
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}
