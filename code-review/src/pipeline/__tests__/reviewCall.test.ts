// reviewCall.test.ts — proves the four layers are actually WIRED, against real
// data: a real temp git repo supplies the diff (no fixtures, no hand-built
// DiffData), and every model call goes through an injected `fetch` that records
// the OUTGOING request and answers it. Nothing in this file mocks our own modules;
// loose provider payloads are narrowed via typed JSON.parse (house pattern).
//
// What each block pins:
//  - Layer 0: the pattern group is collapsed BEFORE chunking, so the reviewer's
//    diff carries the exemplar only while the ledger still names every member;
//  - Layer 1: the brief reaches every package envelope, and its call runs WITHOUT
//    the Verdict schema (the enforced schema would truncate the brief away — the
//    raw-JSON override in llm/reviewWithModel.ts);
//  - package assignment: the brief's `path_prefixes` beat path order when packing,
//    and a null brief falls back to today's grouping exactly.
import { describe, it, expect, afterEach } from "vitest";
import { reviewAndValidate } from "@/pipeline/reviewCall.js";
import { fetchDiff } from "@/git/diff.js";
import type { DiffData } from "@/git/diff.js";
import { splitDiffByFile } from "@/git/chunk.js";
import type { ActionInputs } from "@/inputs.js";
import type { EventResolution } from "@/github/event.js";
import type { BlockableVerdict } from "@/review/gate.js";
import { git, setupGitRepo, writeFile, removeRepo } from "@/git/__tests__/helpers.js";

/** One recorded outgoing model request. */
interface CapturedCall {
  system: string;
  user: string;
}

/** The OpenRouter chat-completions request body, loosely typed for narrowing. */
interface RequestBody {
  messages?: { role: string; content: string }[];
}

/** A chat-completions response carrying `value` as the JSON message content. */
function chatResponse(value: unknown): Response {
  return new Response(
    JSON.stringify({
      id: "gen-review-call-test",
      object: "chat.completion",
      created: 1_781_827_528,
      model: "deepseek/deepseek-v4-flash",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: JSON.stringify(value) },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** The cartographer's system prompt is unmistakable — the discriminator between
 *  the Layer 1 call and the Layer 2 package calls. */
function isCartographer(call: CapturedCall): boolean {
  return call.system.includes("You are the cartographer");
}

/** A recording fetch: captures every request's system+user prompt, answers the
 *  cartographer with `brief` (null → an unusable payload, exercising fail-open)
 *  and every package call with a clean approved verdict. */
function modelServer(
  calls: CapturedCall[],
  brief: unknown,
): { fetch: typeof fetch; calls: CapturedCall[] } {
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body: RequestBody = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    const messages = body.messages ?? [];
    const call: CapturedCall = {
      system: messages.find((m) => m.role === "system")?.content ?? "",
      user: messages.find((m) => m.role === "user")?.content ?? "",
    };
    calls.push(call);
    if (isCartographer(call)) return chatResponse(brief);
    return chatResponse({
      review_plan: "Reviewed the package.",
      verdict: "approved",
      findings: [],
      other_checks: "",
      top_must_fix: [],
    });
  };
  return { fetch: fetchImpl, calls };
}

const VALID_BRIEF = {
  intent: "Adds a tests module declaration across the crate and edits one helper.",
  global_facts: ["The insertion is mechanical in every module file."],
  package_hints: [
    { name: "edges", path_prefixes: ["src/a.ts", "src/z.ts"], risk: "normal" },
    { name: "middle", path_prefixes: ["src/m.ts"], risk: "low" },
  ],
};

function baseInputs(over: Partial<ActionInputs> = {}): ActionInputs {
  return {
    provider: "openrouter",
    model: "deepseek/deepseek-v4-flash",
    apiKey: "sk-test",
    maxTokens: 4096,
    minConfidence: "high",
    enforceJsonSchema: true,
    inlineComments: true,
    manageLabels: false,
    baseBranch: "main",
    reviewPromptFile: "",
    codebaseOverview: "",
    checkProjectRules: false,
    rulesGlob: "",
    rulesRef: "base",
    excludeGlobs: [],
    rulesMaxBytes: 32768,
    maxFiles: 0,
    maxRounds: 0,
    maxDiffLines: 0,
    maxChunkLines: 0,
    maxChunks: 0,
    maxWallMs: 0,
    requestTimeoutMs: 30000,
    token: "ghs_test",
    appId: "",
    appPrivateKey: "",
    triggerPhrase: "@toolu",
    minTriggerPermission: "write",
    botName: "Toolu — Code Review",
    botLogoUrl: "https://example.com/logo.png",
    reviewMemory: true,
    failOn: new Set<BlockableVerdict>(),
    verbosity: "compact",
    touluApiKey: "",
    touluApiUrl: "https://api.toolu.sh",
    ...over,
  };
}

const EVENT: EventResolution = {
  run: true,
  reason: "pull_request",
  review_head: "HEAD",
  base_ref: "main",
  full_review: true,
  pr_number: 7,
};

const repos: string[] = [];
afterEach(() => {
  for (const dir of repos.splice(0)) removeRepo(dir);
});

/** A feature branch whose diff is built with the real git binary. */
function repoWith(files: Record<string, string>, base: Record<string, string> = {}): string {
  const dir = setupGitRepo();
  repos.push(dir);
  for (const [path, content] of Object.entries(base)) writeFile(dir, path, content);
  if (Object.keys(base).length > 0) {
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "base", "--quiet");
  }
  git(dir, "checkout", "-b", "feature", "--quiet");
  for (const [path, content] of Object.entries(files)) writeFile(dir, path, content);
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "change", "--quiet");
  return dir;
}

function diffOf(dir: string): DiffData {
  return fetchDiff({
    baseBranch: "main",
    githubBaseRef: "main",
    maxFiles: 0,
    maxDiffLines: 0,
    reviewHead: "HEAD",
    cwd: dir,
  });
}

/** The `## Diff` fenced block of a captured envelope — the ONLY place a reviewer
 *  reads code; the changed-files list above it names every path either way. */
function diffBlock(call: CapturedCall): string {
  return call.user.slice(call.user.indexOf("\n\n## Diff\n"));
}

describe("reviewAndValidate — Layer 0 (distill) runs before chunking", () => {
  it("collapses a pattern group to its exemplar in the reviewed diff and ledgers the members", async () => {
    // Four identical modules receive the identical one-line insertion (a pattern
    // group), plus one genuinely substantive edit.
    const base: Record<string, string> = { "src/util.ts": "export const n = 1;\n" };
    const files: Record<string, string> = { "src/util.ts": "export const n = 2;\n" };
    for (const name of ["a", "b", "c", "d"]) {
      base[`src/mod_${name}.ts`] = "export const shared = 0;\n";
      files[`src/mod_${name}.ts`] = "export const shared = 0;\nexport const tests = true;\n";
    }
    const dir = repoWith(files, base);
    const calls: CapturedCall[] = [];
    const server = modelServer(calls, VALID_BRIEF);

    const out = await reviewAndValidate({
      inputs: baseInputs(),
      diff: diffOf(dir),
      event: EVENT,
      priorThreads: [],
      reviewHead: "HEAD",
      cwd: dir,
      fetch: server.fetch,
      prTitle: "Add tests modules",
      prBody: "Mechanical insertion across modules.",
    });

    const review = calls.filter((c) => !isCartographer(c));
    expect(review.length).toBe(1);
    const diff = diffBlock(review[0] ?? { system: "", user: "" });
    // The exemplar (lowest path) is reviewed; its three members are NOT in the diff.
    expect(diff).toContain("src/mod_a.ts");
    for (const name of ["b", "c", "d"]) expect(diff).not.toContain(`src/mod_${name}.ts`);
    // …and the substantive file rides along.
    expect(diff).toContain("src/util.ts");

    // The ledger still accounts for all five paths, exactly once each (AC-8).
    expect(Object.keys(out.ledger.entries).sort()).toEqual([
      "src/mod_a.ts",
      "src/mod_b.ts",
      "src/mod_c.ts",
      "src/mod_d.ts",
      "src/util.ts",
    ]);
    expect(out.ledger.entries["src/mod_a.ts"]?.status).toBe("reviewed");
    expect(out.ledger.entries["src/mod_b.ts"]?.status).toBe("pattern");
    expect(out.ledger.entries["src/util.ts"]?.status).toBe("reviewed");
  });
});

describe("reviewAndValidate — Layer 1 (cartographer)", () => {
  it("threads the brief into every package envelope", async () => {
    const dir = repoWith({ "src/a.ts": "export const a = 1;\n" });
    const calls: CapturedCall[] = [];
    const server = modelServer(calls, VALID_BRIEF);

    const out = await reviewAndValidate({
      inputs: baseInputs(),
      diff: diffOf(dir),
      event: EVENT,
      priorThreads: [],
      reviewHead: "HEAD",
      cwd: dir,
      fetch: server.fetch,
      prTitle: "Add a",
      prBody: "",
    });

    expect(out.brief?.intent).toBe(VALID_BRIEF.intent);
    const review = calls.filter((c) => !isCartographer(c));
    expect(review.length).toBe(1);
    expect(review[0]?.user).toContain("## PR brief (UNTRUSTED");
    expect(review[0]?.user).toContain(VALID_BRIEF.intent);
    expect(review[0]?.user).toContain("edges [normal]: src/a.ts, src/z.ts");
  });

  it("runs the cartographer call WITHOUT the Verdict schema, and the package call WITH it", async () => {
    const dir = repoWith({ "src/a.ts": "export const a = 1;\n" });
    const calls: CapturedCall[] = [];
    const server = modelServer(calls, VALID_BRIEF);

    await reviewAndValidate({
      inputs: baseInputs(),
      diff: diffOf(dir),
      event: EVENT,
      priorThreads: [],
      reviewHead: "HEAD",
      cwd: dir,
      fetch: server.fetch,
      prTitle: "Add a",
      prBody: "",
    });

    // The AI SDK injects the enforced schema into the SYSTEM message ("JSON schema:
    // {…}") for a schema call, and only a generic "answer with JSON" line for a
    // raw-JSON one. That difference IS the schema override: a brief routed through
    // the Verdict schema would be truncated by its `other_checks` .max(600).
    const cartographer = calls.find(isCartographer);
    expect(cartographer).toBeDefined();
    expect(cartographer?.system).toContain("You MUST answer with JSON.");
    expect(cartographer?.system).not.toContain("JSON schema:");
    expect(cartographer?.system).not.toContain("top_must_fix");

    const review = calls.find((c) => !isCartographer(c));
    expect(review?.system).toContain("JSON schema:");
    expect(review?.system).toContain("top_must_fix");
  });

  it("fails open: an unusable brief payload leaves the review briefless and still reviewed", async () => {
    const dir = repoWith({ "src/a.ts": "export const a = 1;\n" });
    const calls: CapturedCall[] = [];
    const server = modelServer(calls, { not: "a brief" });

    const out = await reviewAndValidate({
      inputs: baseInputs(),
      diff: diffOf(dir),
      event: EVENT,
      priorThreads: [],
      reviewHead: "HEAD",
      cwd: dir,
      fetch: server.fetch,
      prTitle: "Add a",
      prBody: "",
    });

    expect(out.brief).toBeNull();
    const review = calls.filter((c) => !isCartographer(c));
    expect(review.length).toBe(1);
    expect(review[0]?.user).not.toContain("## PR brief (UNTRUSTED");
    expect(out.ledger.entries["src/a.ts"]?.status).toBe("reviewed");
  });
});

describe("reviewAndValidate — package assignment from the brief's hints", () => {
  /** Three same-size files whose PATH ORDER (a, m, z) disagrees with the brief's
   *  packaging (a+z together). The budget fits exactly two of them. Their contents
   *  DIFFER so Layer 0 sees three substantive files, not one pattern group. */
  function threeFileRepo(): { dir: string; budget: number } {
    const body = (name: string): string =>
      `${Array.from({ length: 8 }, (_, i) => `export const ${name}${i} = ${i};`).join("\n")}\n`;
    const dir = repoWith({
      "src/a.ts": body("alpha"),
      "src/m.ts": body("mid"),
      "src/z.ts": body("zeta"),
    });
    const segments = splitDiffByFile(diffOf(dir).diff);
    const first = segments[0]?.lines ?? 0;
    const second = segments[1]?.lines ?? 0;
    return { dir, budget: first + second };
  }

  it("packs files sharing a hint together, overriding path order", async () => {
    const { dir, budget } = threeFileRepo();
    const calls: CapturedCall[] = [];
    const server = modelServer(calls, VALID_BRIEF);

    await reviewAndValidate({
      inputs: baseInputs({ maxChunkLines: budget }),
      diff: diffOf(dir),
      event: EVENT,
      priorThreads: [],
      reviewHead: "HEAD",
      cwd: dir,
      fetch: server.fetch,
      prTitle: "Three files",
      prBody: "",
    });

    const review = calls.filter((c) => !isCartographer(c)).map(diffBlock);
    expect(review.length).toBe(2);
    const withA = review.find((d) => d.includes("src/a.ts"));
    expect(withA).toBeDefined();
    // The `edges` hint names a.ts and z.ts: they share a package even though m.ts
    // sorts between them and would otherwise have been a.ts's chunk-mate.
    expect(withA).toContain("src/z.ts");
    expect(withA).not.toContain("src/m.ts");
  });

  it("falls back to path-ordered grouping when the brief is unavailable", async () => {
    const { dir, budget } = threeFileRepo();
    const calls: CapturedCall[] = [];
    const server = modelServer(calls, { not: "a brief" });

    await reviewAndValidate({
      inputs: baseInputs({ maxChunkLines: budget }),
      diff: diffOf(dir),
      event: EVENT,
      priorThreads: [],
      reviewHead: "HEAD",
      cwd: dir,
      fetch: server.fetch,
      prTitle: "Three files",
      prBody: "",
    });

    const review = calls.filter((c) => !isCartographer(c)).map(diffBlock);
    expect(review.length).toBe(2);
    const withA = review.find((d) => d.includes("src/a.ts"));
    expect(withA).toContain("src/m.ts");
    expect(withA).not.toContain("src/z.ts");
  });
});

describe("reviewAndValidate — wallDeadline pass-through (MAX_WALL_MS, s13)", () => {
  it("reaches ChunkedReviewOptions: an already-past deadline skips every package call and ledgers pending", async () => {
    const dir = repoWith({ "src/a.ts": "export const a = 1;\n" });
    const calls: CapturedCall[] = [];
    const server = modelServer(calls, VALID_BRIEF);

    const out = await reviewAndValidate({
      inputs: baseInputs(),
      diff: diffOf(dir),
      event: EVENT,
      priorThreads: [],
      reviewHead: "HEAD",
      cwd: dir,
      fetch: server.fetch,
      prTitle: "Add a",
      prBody: "",
      wallDeadline: Date.now() - 1,
    });

    // The deadline is checked BEFORE every package, including the warm-up one —
    // Layer 2 issues zero review calls (Layer 1's cartographer call is unaffected).
    const review = calls.filter((c) => !isCartographer(c));
    expect(review.length).toBe(0);
    expect(out.ledger.entries["src/a.ts"]?.status).toBe("pending");
    expect(out.result.verdict).toBe("error");
  });
});
