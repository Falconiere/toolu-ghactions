// evals/fetch.ts — fetch a real PR's metadata and per-file patches via the `gh`
// CLI at runtime (execFileSync; no octokit, no token wrangling — `gh`'s own
// auth is reused). Every failure is turned into a clear, actionable message:
// `gh` missing from PATH, or not authenticated, are the two cases callers must
// be able to tell apart from a generic API error (AC-16).
//
// WHY THE FILES API, NOT `gh pr diff`: confirmed against the harness's own
// default PR (Falconiere/comemory#72, 553 changed files) — GitHub's `.diff`
// endpoint (what `gh pr diff --patch` fetches) 406s past 300 files ("Sorry,
// the diff exceeded the maximum number of files"). The paginated
// `.../pulls/{n}/files` REST endpoint has no such cap (up to 3000 files) and
// hands back each file's `status`/`previous_filename`/`patch` pre-split —
// which is also strictly MORE precise than parsing header lines out of a raw
// unified diff, so evals/scratch.ts builds directly off it.
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { errorMessage } from "@/errors.js";

/** What one `gh` invocation needs to fail loud and clear. */
interface NodeExecError extends Error {
  code?: string;
  stderr?: Buffer | string;
}

/** `execFileSync` on a missing/failed command always throws an `Error` (Node's
 *  child_process contract) — this narrows to the optional `code`/`stderr`
 *  fields such an error carries, without an `as` cast. */
function isNodeExecError(err: unknown): err is NodeExecError {
  return err instanceof Error;
}

/** Best-effort stderr text off a failed `execFileSync` call, or null. */
function stderrOf(err: NodeExecError): string | null {
  const raw = err.stderr;
  if (raw === undefined) return null;
  return typeof raw === "string" ? raw : raw.toString("utf8");
}

/** Turn a failed `gh` invocation into a clear, actionable message — `gh`
 *  missing from PATH and `gh` not authenticated are called out by name;
 *  anything else surfaces `gh`'s own stderr (already fairly clear). */
function ghErrorMessage(err: unknown, args: readonly string[]): string {
  if (!isNodeExecError(err)) return errorMessage(err);
  if (err.code === "ENOENT") {
    return "gh CLI not found on PATH. Install it from https://cli.github.com and retry.";
  }
  const stderr = stderrOf(err);
  if (stderr !== null && /gh auth login|not logged into|authentication/i.test(stderr)) {
    return `gh is not authenticated. Run "gh auth login" and retry.\n${stderr.trim()}`;
  }
  const detail = stderr !== null && stderr.trim() !== "" ? stderr.trim() : errorMessage(err);
  return `gh ${args.join(" ")} failed:\n${detail}`;
}

/** Run one `gh` invocation, throwing a clear Error (see {@link ghErrorMessage}) on failure.
 *  `stdio` is explicitly piped (not inherited): `gh`'s own stderr is captured into
 *  the thrown error's `.stderr`, not echoed to this process's stderr twice over. */
function runGh(args: readonly string[]): string {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new Error(ghErrorMessage(err, args));
  }
}

/** The subset of `gh pr view --json ...` this harness reads, validated (the
 *  process boundary is untrusted the same way any external command output is). */
const PrMetaSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string(),
  baseRefName: z.string(),
  headRefName: z.string(),
});

/** One entry of GitHub's "List pull request files" API — the same shape
 *  `octokit.rest.pulls.listFiles` returns, which is why it doubles as both the
 *  scratch-repo content source AND the recording octokit's `listFiles` patch. */
const PrFileSchema = z.object({
  filename: z.string(),
  status: z.enum(["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"]),
  previous_filename: z.string().optional(),
  /** Absent for a binary file, a file too large to diff, or a content-identical rename. */
  patch: z.string().optional(),
});
export type PrFile = z.infer<typeof PrFileSchema>;

/** A real PR's metadata plus its per-file changes, as `gh` reports them. The
 *  head commit sha is deliberately NOT read here: the pipeline reviews the
 *  SCRATCH repo's own head commit (evals/scratch.ts), whose sha differs from
 *  the real PR's — `headRefName` is enough context for the rendered comment. */
export interface FetchedPr {
  number: number;
  title: string;
  body: string;
  baseRefName: string;
  headRefName: string;
  files: PrFile[];
}

const PR_META_FIELDS = "number,title,body,baseRefName,headRefName";

/** Parse+validate `gh pr view --json ...`'s stdout; throws a clear Error on a
 *  shape `gh` itself never actually produces (a `gh` version mismatch, say). */
function parsePrMeta(json: string): z.infer<typeof PrMetaSchema> {
  const parsed: unknown = JSON.parse(json);
  const result = PrMetaSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`gh pr view returned an unexpected JSON shape: ${result.error.message}`);
  }
  return result.data;
}

/** Parse `gh api --paginate ... --jq '.[]'`'s stdout: one compact JSON object
 *  per line (jq's own array-flattening), each validated against {@link PrFileSchema}. */
function parsePrFiles(ndjson: string): PrFile[] {
  const files: PrFile[] = [];
  for (const line of ndjson.split("\n")) {
    if (line.trim() === "") continue;
    const parsed: unknown = JSON.parse(line);
    const result = PrFileSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `gh api .../files returned an unexpected JSON shape: ${result.error.message}`,
      );
    }
    files.push(result.data);
  }
  return files;
}

/**
 * Fetch one PR's metadata and every changed file's status/patch via `gh`. Two
 * `gh` invocations (view, api) — never git, never the GitHub REST/GraphQL API
 * directly, so this file carries no auth logic of its own. Throws a clear
 * Error (see {@link ghErrorMessage}) on any failure; never returns a partial result.
 */
export function fetchPr(owner: string, repo: string, prNumber: number): FetchedPr {
  const repoArg = `repos/${owner}/${repo}`;
  const metaJson = runGh([
    "pr",
    "view",
    String(prNumber),
    "--repo",
    `${owner}/${repo}`,
    "--json",
    PR_META_FIELDS,
  ]);
  const meta = parsePrMeta(metaJson);
  const filesNdjson = runGh([
    "api",
    "--paginate",
    "-X",
    "GET",
    `${repoArg}/pulls/${prNumber}/files`,
    "--jq",
    ".[]",
  ]);
  return { ...meta, files: parsePrFiles(filesNdjson) };
}
