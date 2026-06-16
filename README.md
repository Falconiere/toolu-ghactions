# AI Code Review Action

[![tests](https://github.com/Falconiere/toolu-ghactions/actions/workflows/tests.yml/badge.svg)](https://github.com/Falconiere/toolu-ghactions/actions/workflows/tests.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Automated PR code review via OpenRouter. Plans a targeted review against a 7-dimension checklist — correctness, security, performance, test coverage, doc accuracy, tight assertions, migration warnings — then posts a structured verdict with actionable findings.

## Quick start

Add an OpenRouter API key to your repo secrets, then drop this into `.github/workflows/code-review.yml`:

```yaml
name: Code Review
on:
  pull_request:
    types: [opened, synchronize, ready_for_review, reopened]

permissions:
  contents: read
  pull-requests: write
  issues: write

concurrency:
  group: code-review-${{ github.ref }}
  cancel-in-progress: true

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # full history so the merge-base resolves without deepening
      - uses: falconiere/toolu-ghactions/code-review@v1
        with:
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
```

> `fetch-depth: 0` is recommended but optional — on a shallow checkout the action
> deepens the history itself to find the merge-base.

Use MODEL to switch models and REVIEW_PROMPT_FILE for a custom checklist:

```yaml
      - uses: falconiere/toolu-ghactions/code-review@v1
        with:
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
          MODEL: 'anthropic/claude-sonnet-4'
          REVIEW_PROMPT_FILE: '.github/review-prompt.md'
```

On every PR push, the action fetches the diff, sends it to the configured model via OpenRouter, and posts a verdict comment directly on the PR.

While the review runs, an in-progress comment appears on the PR with unchecked checkboxes tracking each phase. When the review completes, that same comment is edited in place with the full verdict — findings, severity breakdown, a review plan showing which dimensions were checked, and the machine-readable merge label.

## How it works

In the default `parallel` mode the action runs a fan-out → validate → coordinate pipeline:

**1 — Fetch & shape the diff.** Resolves the merge-base, strips noise (lockfiles, minified, generated, source maps), drops binaries, and line-primes every diff line with its real source line number so findings anchor to actual lines.

**2 — Parallel sub-reviewers.** One narrowly-scoped reviewer runs per dimension group — `correctness`, `security`, `performance+migration`, `tests+assertions+docs` — each with negative constraints ("no style, no general advice, only HIGH-confidence findings, cite the exact line"). Scoped reviewers produce far less noise than one catch-all prompt.

**3 — Deterministic validation.** Every finding is checked against the diff: a finding whose line isn't actually in the changes is dropped (no hallucinated locations), low-confidence findings are gated out, and a code suggestion is kept only when it's high-confidence and fully anchored.

**4 — Coordinator pass.** A final model call deduplicates across reviewers, filters for reasonableness, sets the verdict, and writes the review plan + top must-fix list.

**5 — Post.** A summary verdict comment (machine-readable label for `pr-babysit`), plus — when `INLINE_COMMENTS` is on — per-line review comments with committable ` ```suggestion ` blocks via the GitHub Reviews API (advisory `COMMENT` event; it never hard-blocks merge).

Set `REVIEW_MODE: single` for one combined call instead of the fan-out — cheaper, lower quality. The `parallel` default makes roughly `(number of dimension groups + 1)` API calls per review; budget accordingly.

### Inline comments & suggestions

With `INLINE_COMMENTS: true` (default), findings are posted as inline review comments anchored to the exact file and line. When the model has a concrete, high-confidence fix it attaches a ` ```suggestion ` block you can commit straight from the PR. Set `INLINE_COMMENTS: false` for a summary-comment-only review.

The verdict comment is compatible with [`parse-verdict.sh`](https://github.com/Falconiere/toolu/blob/main/plugins/pr-babysit/scripts/parse-verdict.sh) and the [`pr-babysit`](https://github.com/Falconiere/toolu/tree/main/plugins/pr-babysit) automation loop, so toolu users can drop this into CI and their existing babysit workflow consumes the verdict without changes.

## Example verdict

```markdown
**AI Code Review finished in 2m 15s** —— [View job](https://github.com/...)

### Code Review — `feat/add-login`

**Verdict:** ✅ Approved   🔵 2 low

### Review Plan
Reviewing 4 files: 1 correctness-critical (format.ts), 1 test-quality
(format.test.ts), 1 config (settings.json), 1 security-sensitive (login.ts).
Skipping PERFORMANCE — no hot-path changes.

### Findings (2)
`src/utils/format.ts:17`: low: Comment says 'Temporary workaround' with no
removal date or tracking issue.
`src/utils/__tests__/format.test.ts:6`: low: Test assertion uses loose suffix
match. Tighten to assert full identity.

### Top-N must-fix
**`src/utils/format.ts:17`** — Add a removal date or tracking issue.
**`src/utils/__tests__/format.test.ts:6`** — Tighten test assertion.

`agent-merge-approved`
```

The verdict label at the bottom is machine-readable: `` `agent-merge-approved` `` or `` `agent-request-changes` ``. `pr-babysit` parses it to decide whether the PR is ready to merge. Unless `MANAGE_LABELS` is `false`, the same verdict is also applied as a real PR **label chip** (the opposite one is removed), so PRs are filterable in the GitHub UI — this needs `issues: write` in the workflow's `permissions` block.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `OPENROUTER_API_KEY` | no* | — | OpenRouter API key. *Required — pass via `with:` or a step-level `env:` block. |
| `MODEL` | no | `minimax/minimax-m3` | OpenRouter model identifier |
| `FALLBACK_MODEL` | no | `anthropic/claude-sonnet-4-5` | Second model tried via the OpenRouter `models[]` fallback array when the primary errors or is unavailable |
| `MAX_TOKENS` | no | `4096` | Max completion tokens per request (always sent — omitting it makes OpenRouter reserve the model's full output capacity against your budget) |
| `REVIEW_MODE` | no | `parallel` | `parallel` = one scoped sub-reviewer per dimension group + a coordinator pass (higher quality, ~5× API cost); `single` = one combined call (cheapest) |
| `MIN_CONFIDENCE` | no | `high` | Drop findings below this confidence unless severity is blocker/high (`high` or `medium`) |
| `ENFORCE_JSON_SCHEMA` | no | `true` | Use `response_format` json_schema + provider routing; set `false` for free-text + regex fallback |
| `INLINE_COMMENTS` | no | `true` | Post per-line review comments with committable code suggestions (Reviews API), in addition to the summary comment |
| `MANAGE_LABELS` | no | `true` | Set a real PR label chip matching the verdict (`agent-merge-approved` / `agent-request-changes`) and remove the opposite one. Requires `issues: write`. |
| `BASE_BRANCH` | no | `main` | Base branch for diff comparison. Falls back to `GITHUB_BASE_REF` if unset. |
| `REVIEW_PROMPT_FILE` | no | *(7-dimension checklist)* | Path to a markdown file (relative to repo root) with a custom review prompt. Overrides the default checklist. |
| `CODEBASE_OVERVIEW` | no | — | High-level context about the codebase (framework, patterns, architecture) injected into the review prompt. |
| `MAX_FILES` | no | `0` (unlimited) | Maximum changed files before the action skips. `0` reviews any number of files — the only ceiling is your OpenRouter billing balance. Set a positive value to opt into a hard skip on huge PRs. |
| `MAX_DIFF_LINES` | no | `0` (unlimited) | Maximum diff lines before truncation. `0` reviews the whole diff. Set a positive value to keep the first N lines (lexicographic by file path) and append a truncation notice. |
| `TOKEN` | no | `${{ github.token }}` | GitHub token for posting and editing comments. |

## Outputs

| Output | Description |
|---|---|
| `verdict` | `approved`, `changes`, `error`, or `skip` |
| `findings-count` | Number of findings reported |
| `comment-url` | URL of the posted verdict comment |

Use outputs in downstream workflow steps:

```yaml
- uses: falconiere/toolu-ghactions/code-review@v1
  id: review
  with:
    OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
- if: steps.review.outputs.verdict == 'changes'
  run: echo "PR needs work — ${{ steps.review.outputs.findings-count }} findings"
```

## Repository structure

```
.
├── code-review/            # AI code review action (Toolu AI Code Review)
│   ├── action.yml
│   ├── Dockerfile
│   ├── src/                # fetch-diff → build-prompt → call-openrouter → ...
│   ├── prompts/            # Default review checklist
│   └── __tests__/          # Hermetic bats test suite
├── cloudflare-tunnel/      # Cloudflare Tunnel action (Toolu Cloudflare Tunnel)
│   ├── start/action.yml    # Boots a tunnel, emits URL/ID outputs
│   ├── stop/action.yml     # Tears down the tunnel
│   ├── wait/action.yml     # Polls tunnel URL until reachable
│   ├── Dockerfile
│   ├── src/                # start.sh / stop.sh / wait.sh / install-cloudflared.sh
│   └── __tests__/          # Hermetic bats test suite
├── scripts/
│   └── parse-verdict.sh    # Shared: verdict format validator
└── docs/                   # Design specs and plans
```

The monorepo is structured for future actions to share conventions and utilities.

## Actions

| Action | Description | Sub-actions |
|---|---|---|
| [`code-review`](./code-review/README.md) | AI PR review via OpenRouter (Toolu AI Code Review) | single root action |
| [`cloudflare-tunnel`](./cloudflare-tunnel/README.md) | Expose runner ports to the internet via Cloudflare Tunnel | `start`, `stop`, `wait` |

## Development

```bash
# Run all test suites (requires bats, jq, git)
bats code-review/__tests__/*.bats cloudflare-tunnel/__tests__/*.bats

# Build the Docker images
docker build -t code-review-action:test code-review/
docker build -t cloudflare-tunnel-action:test cloudflare-tunnel/

# Lint all shell scripts (style/info advisory; warnings+ block CI)
shellcheck --severity=warning code-review/src/*.sh cloudflare-tunnel/src/*.sh scripts/*.sh

# Validate action.yml against GitHub's schema
npx @action-validator/cli code-review/action.yml
```

Tests are hermetic — they use recorded fixtures for OpenRouter responses and mock `curl` for GitHub API calls. No API key needed for the unit test suite.

## Release Process

Releases are fully automated via [release-please](https://github.com/googleapis/release-please). A release is cut on every push to `main` when conventional-commit-triggered changes are detected.

### How it works

1. **Commit convention** — use [Conventional Commits](https://www.conventionalcommits.org/) in PR titles and merge commits:
   - `fix: ...` → patch bump
   - `feat: ...` → minor bump
   - `feat!: ...` or `fix!: ...` (breaking change, `!` after type) → major bump
   - `docs:`, `chore:`, `test:`, `ci:` → no version bump (but appear in changelog)
2. **release-please PR** — on push to `main`, release-please opens (or updates) a release PR with the version bump and changelog entry.
3. **Merge the release PR** — merging it triggers the `release.yml` workflow which:
   - Creates a Git tag (e.g. `v1.0.1`)
   - Creates a GitHub Release with the changelog
   - Force-moves the floating major alias (e.g. `v1` → latest `v1.x.y` tag)

### Versioning scheme

- `@v1` — floating major alias, tracks latest `v1.x.y`. **Recommended for callers.**
- `@v1.0.0` — pin to exact semver for maximum stability.

### Making a release

No manual steps. Push to `main` with conventional-commit messages and release-please handles the rest. To force a specific bump, include `Release-As: X.Y.Z` in the footer of a commit message.

## License

MIT
# Multi-provider: coming soon
