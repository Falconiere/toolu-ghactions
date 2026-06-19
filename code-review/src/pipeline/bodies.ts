// pipeline/bodies.ts — the static sticky-comment body templates the pipeline
// posts for the in-progress, skip, and no-op (no changes) states. Split out of
// pipeline.ts so that file stays under the 300-LOC budget. Byte-parity with the
// IN_PROGRESS_BODY / SKIP_BODY / NOOP_BODY heredocs in main.sh.
import type { GithubContext } from "./types.js";

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

\`agent-merge-approved\`
`;
}

/** The in-progress comment body (parity with main.sh's IN_PROGRESS_BODY). */
export function inProgressBody(ctx: GithubContext): string {
  return `**AI Code Review running** —— [View job](${jobUrl(ctx)})

---
### PR Review in Progress

- [ ] Read repository context and PR diff
- [ ] Review changed files
- [ ] Analyze correctness, security, performance
- [ ] Post findings
- [ ] Set verdict label
`;
}
