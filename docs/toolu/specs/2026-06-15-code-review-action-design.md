# AI Code Review Action — Design

**Date:** 2026-06-15   **Status:** Approved   **Author:** Falconiere   **Topic:** Publishable Docker GitHub Action that runs AI code review on PRs via OpenRouter

## Problem

Today, toolu repos delegate CI code review to `Falconiere/workflows` — a private reusable workflow that is not discoverable, not versioned independently, and not usable by external projects. There is no standalone, marketplace-publishable GitHub Action that runs the toolu 7-dimension code review checklist (correctness, security, performance, test coverage, doc accuracy, tight assertions, migration WARNs) against a PR diff and posts a structured verdict comment that the `pr-babysit` / `parse-verdict.sh` ecosystem can consume. The user wants to replace the reusable workflow with a first-class action publishable to the GitHub Marketplace, making the toolu review methodology available to any repository.

## Non-Goals

1. **`claude-mention` action** — comment/issue/review-triggered AI responses. That is a separate action, not part of v1.
2. **Multi-provider support** — OpenRouter only for v1. Anthropic direct, Groq, Gemini etc. are follow-up work.
3. **In-action fix loops** — the action posts findings and stops. It does not apply fixes, push commits, or loop. `pr-babysit` handles the fix→push→re-review cycle client-side.
4. **Push-review gate integration** — the action runs in CI, not as a local pre-push hook. The local `code-review:review` skill handles pre-push.
5. **Streaming responses** — the action makes one synchronous API call per run. No streaming, no progressive comment updates (though the comment header flips from "In Progress" to "Code Review —").
6. **Private repository support** — the action works on public repos by default. Private repo usage requires the user to bring their own OpenRouter key; no special handling beyond that.
7. **Custom review dimensions via file** — the `review-prompt` input accepts a string, not a path to a file. File-based overrides can come later.
8. **Concurrent-run comment editing races** — if a user's workflow omits `concurrency: cancel-in-progress`, two action instances could race to edit the same bot comment. Not the action's responsibility to solve; users should configure concurrency in their workflow file.

## Architecture

**Docker action, single entrypoint script, OpenRouter API via curl.**

Trade-off: simplicity and existing-code reuse over cold-start latency.

The action runs in a Docker container (Alpine base + bash, git, jq, curl). **Prerequisite:** the user's workflow must include `actions/checkout@v4` before this action — the action operates on the checked-out repo in `$GITHUB_WORKSPACE` and does not clone the repo itself.

The entrypoint `main.sh` orchestrates four phases:

1. **Fetch** — resolve the PR diff (merge-base against `base-branch` input, default `main`), collect changed file list
2. **Prompt** — assemble the system prompt (7-dimension checklist) and user prompt (diff + optional codebase overview), truncate if over context limit
3. **Review** — POST to OpenRouter chat completions API, parse the structured response
4. **Verdict** — format the markdown verdict comment using the established template, find and edit the bot's existing comment (or create if none), post to the PR

The action reuses the verdict comment format already consumed by `parse-verdict.sh` (see `pr-babysit/scripts/parse-verdict.sh` in the toolu repo). The contract is:
- Header: `### Code Review — \`<branch-name>\`` (complete) or `### PR Review in Progress` (running)
- Checkbox checklist tracking progress
- Machine-readable verdict label: `` `agent-merge-approved` `` or `` `agent-merge-changes-requested` ``
- `### Findings` block with lines of form `` `path:line`: severity: text ``
- `### Other checks` and `### Top-N must-fix` sections

#### PR Context Resolution

`main.sh` extracts the following from the GitHub Actions event payload (`$GITHUB_EVENT_PATH` is a JSON file provided by the runner):

| Field | JSON path | Used for |
|---|---|---|
| PR number | `.pull_request.number` | Comment API endpoint, verdict header |
| Head ref | `.pull_request.head.ref` | Branch name in verdict header, `git diff` |
| Base ref | `.pull_request.base.ref` | Fallback when `base-branch` input is unset |
| Repo full name | `.repository.full_name` | Comment API endpoint, View job link |
| Clone URL | `.repository.clone_url` | *(not used; repo already checked out)* |

All fields are present for `pull_request` events (the only trigger the action supports).

#### Test Strategy

Tests are split into two tiers:

- **Unit tests (bats, hermetic):** Run offline in `__tests__/` against recorded fixtures (`sample-diff.txt`, `sample-openrouter-response.json`, `expected-verdict-comment.md`). Cover prompt assembly (`build-prompt.sh`), response parsing (`parse-response.sh`), verdict formatting (`format-verdict.sh`), and diff truncation. No API key, no network.
- **Integration tests (manual, requires API key):** Cover live OpenRouter calls (AC 5-7) and live PR comment posting (AC 10-11). Run manually during development or in a separate CI workflow with `OPENROUTER_API_KEY` and `GITHUB_TOKEN` secrets. These are acceptance criteria but are not part of the hermetic bats suite.

### Files and responsibilities

```
.
├── action.yml              # GitHub Action metadata (name, description, inputs, branding)
├── Dockerfile              # Alpine + bash, git, jq, curl
├── src/
│   ├── main.sh             # Entrypoint: orchestrate fetch→prompt→review→verdict
│   ├── fetch-diff.sh       # git merge-base → git diff, collect metadata
│   ├── build-prompt.sh     # Assemble system + user prompt from checklist + diff
│   ├── call-openrouter.sh  # POST to OpenRouter, handle errors, extract text
│   ├── parse-response.sh   # Extract findings[] + verdict label from LLM output
│   ├── format-verdict.sh   # Render the markdown verdict comment
│   └── post-comment.sh     # Find existing bot comment → update or create via curl + GitHub REST API
├── prompts/
│   └── review-checklist.txt # The 7-dimension review checklist (default system prompt)
├── scripts/
│   └── parse-verdict.sh    # Vendored test fixture for format validation (not shipped in image)
├── __tests__/
│   ├── fixtures/
│   │   ├── sample-diff.txt
│   │   ├── sample-openrouter-response.json
│   │   └── expected-verdict-comment.md
│   ├── parse-response.bats
│   ├── format-verdict.bats
│   └── helpers.bash
└── README.md               # Marketplace-facing: usage, inputs table, example workflow
```

## Interfaces / Schema

### `action.yml`

```yaml
name: 'AI Code Review'
description: |
  Automated AI code review for pull requests. Reviews every changed file
  against a 7-dimension checklist (correctness, security, performance, test
  coverage, doc accuracy, tight assertions, migration warnings) and posts a
  structured verdict with actionable findings.
author: 'Falconiere'
branding:
  icon: 'check-circle'
  color: 'green'

inputs:
  openrouter-api-key:
    description: 'OpenRouter API key'
    required: true
  model:
    description: 'OpenRouter model identifier'
    required: false
    default: 'anthropic/claude-sonnet-4'
  base-branch:
    description: 'Base branch for diff comparison'
    required: false
    default: 'main'
  review-prompt:
    description: 'Custom system prompt overriding the default 7-dimension checklist'
    required: false
  codebase-overview:
    description: 'High-level description of the codebase (framework, patterns, business context) to give the reviewer context'
    required: false
  max-files:
    description: 'Maximum number of changed files before the action skips (avoids massive PR cost/timeout)'
    required: false
    default: '100'
  max-diff-lines:
    description: 'Maximum diff lines before truncation (oldest hunks dropped)'
    required: false
    default: '8000'
  token:
    description: 'GitHub token for posting/editing comments. Use ${{ secrets.GITHUB_TOKEN }}'
    required: false
    default: '${{ github.token }}'

outputs:
  verdict:
    description: 'Review verdict: approved, changes, or error'
  findings-count:
    description: 'Number of findings reported'
  comment-url:
    description: 'URL of the posted verdict comment'

runs:
  using: 'docker'
  image: 'Dockerfile'
  env:
    OPENROUTER_API_KEY: ${{ inputs.openrouter-api-key }}
    GITHUB_TOKEN: ${{ inputs.token }}
```

### Verdict Comment Format (output contract)

The comment is a single markdown issue comment on the PR. The action finds its own previous comment and edits it in place (or creates one if none exists).

**Comment discovery:** List all issue comments on the PR via `GET /repos/{owner}/{repo}/issues/{number}/comments`, filter by `user.login == "github-actions[bot]"`, then grep for the marker header (`### Code Review` or `### PR Review in Progress`). Take the last matching comment (sorted by `created_at`) — this is the comment to edit via `PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}`. If no match, create a new one via `POST /repos/{owner}/{repo}/issues/{number}/comments`.

All GitHub API calls use `Authorization: Bearer $GITHUB_TOKEN`.

**In-progress comment** (posted immediately, then edited in place when complete):
```markdown
**AI Code Review running** —— [View job]($GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID)

---
### PR Review in Progress

- [ ] Read repository context and PR diff
- [ ] Review changed files
- [ ] Analyze correctness, security, performance
- [ ] Post findings
```

**Complete comment** (the final state after review finishes):
```markdown
**AI Code Review finished in <duration>** —— [View job]($GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID)

---
### Code Review — `<branch-name>`

- [x] Read repository context and PR diff
- [x] Review changed files
- [x] Analyze correctness, security, performance
- [x] Post findings
- [x] Set verdict label (`agent-merge-approved`)

### Findings

`src/auth/login.ts:42`: high: User input is not sanitized before SQL query — SQL injection risk.
`src/utils/format.ts:17`: low: Comment says "temporary workaround" with no removal date or tracking issue.

### Other checks
- TypeScript compilation passes (`tsc --noEmit`)
- No new ESLint violations introduced

### Top-N must-fix
1. **`src/auth/login.ts:42`** — SQL injection: sanitize user input before constructing query.

`agent-merge-approved`
```

### OpenRouter API Call

**Endpoint:** `POST https://openrouter.ai/api/v1/chat/completions`

**Headers:**
```
Authorization: Bearer $OPENROUTER_API_KEY
Content-Type: application/json
```

**Request body:**
```json
{
  "model": "anthropic/claude-sonnet-4",
  "messages": [
    {
      "role": "system",
      "content": "<review-checklist.txt content, or $INPUT_REVIEW_PROMPT>"
    },
    {
      "role": "user",
      "content": "<assembled prompt with codebase overview, changed files list, and git diff>"
    }
  ],
  "temperature": 0.1,
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "code_review_verdict",
      "schema": {
        "type": "object",
        "required": ["verdict", "findings", "other_checks", "top_must_fix"],
        "properties": {
          "verdict": {
            "type": "string",
            "enum": ["approved", "changes"]
          },
          "findings": {
            "type": "array",
            "items": {
              "type": "object",
              "required": ["path", "severity", "text"],
              "properties": {
                "path": { "type": "string" },
                "line": { "type": "integer" },
                "severity": { "type": "string", "enum": ["blocker", "high", "medium", "low", "nit"] },
                "text": { "type": "string" }
              }
            }
          },
          "other_checks": { "type": "string" },
          "top_must_fix": {
            "type": "array",
            "items": { "type": "string" }
          }
        }
      }
    }
  }
}
```

### Default System Prompt (`prompts/review-checklist.txt`)

```
You are a meticulous code reviewer. For every changed file in the diff,
evaluate against these dimensions. Report every finding — do not suppress
low-severity issues. Be specific: cite exact paths and line numbers.

1. CORRECTNESS — logic errors, edge cases, error handling. Flag swallowed
   errors, @ts-ignore/eslint-disable/#[allow] that papers over real problems.

2. SECURITY — input validation, injection vectors, hardcoded secrets,
   unsafe file/symlink operations.

3. PERFORMANCE — hot-path work (per-render, per-hook, per-request),
   unnecessary subprocess spawns or allocations in loops.

4. TEST COVERAGE — every NEW code path must have a colocated real-data test.
   A new function/behavior without a test is a finding.

5. DOC/COMMENT ACCURACY — comments must match behavior. Flag "one-time" on
   blocks that run every invocation, stale paths after moves, outdated docs.

6. TIGHT ASSERTIONS — test assertions must verify full identity, not loose
   suffixes or partial matches. assert on `*/statusline/statusline.sh`, not
   `*/statusline.sh`.

7. MIGRATION WARNINGS — breaking changes (moved paths, removed symlinks,
   renamed APIs) must surface actionable in-session warnings, not silent
   failures.

Output your review as a JSON object with: verdict ("approved"|"changes"),
findings[] ({path, line, severity, text}), other_checks (markdown string
summarizing non-finding observations), top_must_fix[] (strings naming the
1-3 most critical items).
```

### Input Environment Variables (inside container)

The `action.yml` maps inputs to environment variables in the Docker container (standard GitHub Actions behavior for Docker actions with `env:`):

| Variable | Source | Default |
|---|---|---|
| `OPENROUTER_API_KEY` | `inputs.openrouter-api-key` | *(required)* |
| `GITHUB_TOKEN` | `inputs.token` | `${{ github.token }}` |
| `INPUT_MODEL` | `inputs.model` | `anthropic/claude-sonnet-4` |
| `INPUT_BASE_BRANCH` | `inputs.base-branch` | `main` |
| `INPUT_REVIEW_PROMPT` | `inputs.review-prompt` | *(empty → use default checklist)* |
| `INPUT_CODEBASE_OVERVIEW` | `inputs.codebase-overview` | *(empty)* |
| `INPUT_MAX_FILES` | `inputs.max-files` | `100` |
| `INPUT_MAX_DIFF_LINES` | `inputs.max-diff-lines` | `8000` |

Standard GitHub Actions env vars also available: `GITHUB_REPOSITORY`, `GITHUB_REF`, `GITHUB_EVENT_PATH`, `GITHUB_SERVER_URL`, `GITHUB_API_URL`, `GITHUB_RUN_ID`.

**Naming convention note:** GitHub Actions auto-exposes every `inputs.*` as `INPUT_<NAME>` (uppercase, dashes → underscores) — e.g. `INPUT_MODEL`, `INPUT_BASE_BRANCH`. The `runs.env` block in `action.yml` additionally sets clean names (`OPENROUTER_API_KEY`, `GITHUB_TOKEN`) for the secrets. Scripts can use either; the table above lists the canonical name used in this codebase.

### `parse-verdict.sh` Contract (consumer-side, for backward compatibility)

The comment must satisfy these parse-verdict.sh expectations:
- **Marker:** comment contains one of: `### Code Review`, `### PR Review in Progress`, `[View job](...actions/runs/...)`, or `` `agent-merge-` `` (backtick-wrapped, machine-readable)
- **Completeness:** tracked via unchecked/checked `- [ ]`/`- [x]` checkboxes. All checked → `state: complete`.
- **Verdict label:** `` `agent-merge-approved` `` or `` `agent-merge-changes-requested` `` in the comment body (backtick-wrapped, authoritative)
- **Findings:** in `### Findings` section, each line matching `` `path:line`: severity: text ``

## Acceptance Criteria

1. **PR diff resolution** — Given a PR with 5 changed files against `main`, `fetch-diff.sh` outputs a unified diff and changed-files list matching `git diff origin/main...HEAD`.
2. **Prompt assembly** — Given a 500-line diff and the default checklist, `build-prompt.sh` produces valid JSON for the OpenRouter request body with system + user messages.
3. **Diff truncation** — Given a PR with 12000 diff lines and `max-diff-lines: 5000`, the action truncates the diff to the first 5000 lines (lexicographic by file path), appends a notice `[Diff truncated at 5000 lines; N files omitted]` to the user prompt, and still runs the review.
4. **File count skip** — Given a PR with 150 changed files and `max-files: 100`, the action posts a skip comment ("PR exceeds file limit, review skipped") and exits successfully.
5. **OpenRouter call** — Given a valid `OPENROUTER_API_KEY` and a 200-line diff, `call-openrouter.sh` returns a JSON response with `choices[0].message.content` within 120 seconds.
6. **OpenRouter auth failure** — Given an invalid API key, the action posts an error comment on the PR ("Code review failed: authentication error") and exits with code 1.
7. **OpenRouter timeout** — If the API call exceeds 180 seconds, the action posts a timeout comment and exits with code 1.
8. **Structured JSON response** — Using `response_format: json_schema`, the LLM returns valid JSON matching the schema (verdict + findings[] + other_checks + top_must_fix[]). `parse-response.sh` validates the JSON with `jq` and extracts fields.
9. **Response fallback** — If the LLM response is not valid JSON (despite schema), `parse-response.sh` attempts to extract findings via regex from the raw text and falls back to an error comment if extraction fails.
10. **Verdict comment — first run** — On a PR with no existing bot comment, the action creates a new comment with "AI Code Review running" header, then edits it to the final "Code Review —" format with findings, other checks, and verdict label.
11. **Verdict comment — subsequent run** — On a PR where the bot already has a comment, the action edits the existing comment in place rather than creating a new one.
12. **Verdict comment — parse-verdict.sh compatible** — The final comment, when piped through `parse-verdict.sh`, returns `{is_review_comment: true, state: "complete", verdict: "approved"|"changes", findings: [<matching>]}`.
13. **Approved verdict** — Given a diff with no correctness/security findings, the action posts a comment with `` `agent-merge-approved` `` and `verdict: "approved"`.
14. **Changes-requested verdict** — Given a diff with at least one high-severity finding, the action posts a comment with `` `agent-merge-changes-requested` `` and `verdict: "changes"`.
15. **Custom prompt override** — Given `review-prompt: "Only check for SQL injection"`, the action uses that as the system prompt instead of the default checklist.
16. **Codebase overview injection** — Given `codebase-overview: "React + Express monorepo"`, the overview text appears in the user prompt before the diff.
17. **Empty diff** — On a PR with no file changes (e.g., only merge commits), the action posts a comment noting "No file changes to review" and exits successfully.
18. **Base branch resolution** — Given a PR targeting `develop` and `base-branch` unset (default `main`), the action falls back to the PR's actual base ref from `GITHUB_BASE_REF` rather than using the hardcoded default.
19. **Action outputs** — The action sets outputs: `verdict` (approved|changes|error|skip), `findings-count` (integer), and `comment-url` (full URL to the verdict comment).
20. **Marketplace readiness** — The repo's `action.yml` passes GitHub's metadata validation (all required fields present, name unique, branding icon valid).
21. **Binary file exclusion** — Given a PR that includes a `.png` or `.wasm` file, `fetch-diff.sh` lists binary files separately in the changed-files summary ("Binary: path/to/file.png") and excludes their content from the diff sent to the LLM.
22. **Downstream docs updated** — The toolu repo's `.github/workflows/code-review.yml` is updated to reference this action instead of `Falconiere/workflows`. The `code-review:review` `SKILL.md` mentions the new action name so users know what tool produces the CI verdict they see.

## Open Questions

1. **Comment identity** — The action runs as `github-actions[bot]` (the default identity for `GITHUB_TOKEN`). `parse-verdict.sh` looks for `claude[bot]` OR `github-actions[bot]`, so `github-actions[bot]` satisfies both the action's own comment discovery and `pr-babysit`'s parser. If a different bot identity is desired, the user must provide a `token` input from a GitHub App or personal access token — the action uses whatever identity the token belongs to. *Owner: Falconiere — start with `github-actions[bot]`; add a `bot-name` input later if needed.*
2. **OpenRouter JSON schema support** — Not all OpenRouter models support `response_format: json_schema`. Claude Sonnet 4 does via Anthropic's native structured outputs. If a user selects a model without schema support, fall back to `response_format: {type: "json_object"}` with a prompt instruction to output JSON. *Owner: Falconiere — test during implementation; add model capability detection.*
3. **Docker image registry** — GitHub Actions can reference `image: 'Dockerfile'` (built on each run) or a pre-built image from ghcr.io. Building on each run is simpler but adds 30-60s of build time before the review starts. Pre-building and pushing to `ghcr.io/falconiere/code-review-action:latest` removes build time but adds release workflow complexity. *Owner: Falconiere — start with Dockerfile-in-repo; optimize to pre-built image if build time becomes a pain point.*
