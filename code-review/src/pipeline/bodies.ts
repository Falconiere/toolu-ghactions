// pipeline/bodies.ts — the static sticky-comment body templates the pipeline
// posts for the in-progress, skip, and no-op (no changes) states, plus two small
// pure helpers (checklist-path resolution, duration formatting). Split out of
// pipeline.ts so that file stays under the 300-LOC budget. Byte-parity with the
// IN_PROGRESS_BODY / SKIP_BODY / NOOP_BODY heredocs in main.sh.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { GithubContext } from "./types.js";

/** Raw GitHub URL for the loading animation shown in the in-progress comment. */
const LOADING_GIF_URL =
  "https://raw.githubusercontent.com/falconiere/toolu-ghactions/main/code-review/assets/loading.gif";

/**
 * Locate the shipped review-checklist.txt, mirroring build-prompt.sh's prompt_path.
 * In node24 the action's CWD is the CONSUMER repo, so its own files live at
 * $GITHUB_ACTION_PATH — the FIRST candidate. Fallbacks: /action/prompts (old Docker
 * path), the package-root-relative paths (dev/test/CI), and a __dirname-relative
 * path for the bundle (esbuild defines __dirname in CJS). Returns the first that
 * exists, else the Docker path so buildPrompt raises its own clear PromptError. No
 * import.meta, so the CJS bundle resolves identically to ESM.
 */
export function resolveChecklistPath(): string {
  const fallback = "/action/prompts/review-checklist.txt";
  // `typeof` guard: the CJS bundle defines __dirname; the ESM dev/test runtime,
  // where a bare reference throws, does not.
  const here = typeof __dirname !== "undefined" ? __dirname : "";
  const candidates = [
    join(process.env["GITHUB_ACTION_PATH"] ?? "", "prompts/review-checklist.txt"),
    fallback,
    "prompts/review-checklist.txt",
    "code-review/prompts/review-checklist.txt",
    join(here, "../prompts/review-checklist.txt"),
  ];
  return candidates.find((p) => existsSync(p)) ?? fallback;
}

/** Format a finished-in duration ("Xm Ys" / "Ys") from elapsed milliseconds. */
export function formatDuration(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(secs / 60);
  return m > 0 ? `${m}m ${secs % 60}s` : `${secs}s`;
}

/** The "View job" URL, matching main.sh's GITHUB_SERVER_URL/REPO/RUN_ID link. */
export function jobUrl(ctx: GithubContext): string {
  return `${ctx.serverUrl}/${ctx.repo.owner}/${ctx.repo.repo}/actions/runs/${ctx.runId}`;
}

/** The MAX_FILES / fetch-skip comment body (parity with main.sh's SKIP_BODY). */
export function skipBody(ctx: GithubContext, reason: string): string {
  return `**AI Code Review skipped** —— [View job](${jobUrl(ctx)})

---
### Code Review — skipped

**Skipped:** ${reason}
`;
}

/** The no-file-changes comment body (parity with main.sh's NOOP_BODY). */
export function noopBody(ctx: GithubContext): string {
  return `**AI Code Review finished** —— [View job](${jobUrl(ctx)})

---
### Code Review — \`${ctx.repo.repo}\`

**No file changes to review.** 🎉

\`merge-approved\`
`;
}

/** The in-progress comment body (parity with main.sh's IN_PROGRESS_BODY). */
export function inProgressBody(ctx: GithubContext): string {
  return `**AI Code Review running** —— [View job](${jobUrl(ctx)})

<p align="center"><img src="${LOADING_GIF_URL}" width="240" alt="Review in progress"></p>

---
### PR Review in Progress

- [ ] Read repository context and PR diff
- [ ] Review changed files
- [ ] Analyze correctness, security, performance
- [ ] Post findings
- [ ] Set verdict label

<p align="left"><img src="${LOADING_GIF_URL}" width="100" alt="Review in progress"></p>
`;
}
