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
      - uses: falconiere/toolu-ghactions/code-review@v1
        with:
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
```

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

The action runs in two phases:

**Phase 1 — Review plan.** The model analyzes which files changed, what kind of changes they are (feature, bugfix, refactor, config), and which review dimensions actually apply. A docs-only change doesn't get a security review. A CSS tweak doesn't get a performance audit. The plan is shown in the comment so you can see what was checked and what was skipped.

**Phase 2 — Targeted review.** The model reviews only against the dimensions it committed to in Phase 1. Every finding includes the exact file path, line number, severity, and a specific description — no "consider improving error handling" hand-waving.

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

The verdict label at the bottom is machine-readable: `` `agent-merge-approved` `` or `` `agent-request-changes` ``. `pr-babysit` parses it to decide whether the PR is ready to merge.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `OPENROUTER_API_KEY` | yes | — | OpenRouter API key |
| `MODEL` | no | `qwen/qwen3.7-max` | OpenRouter model identifier |
| `BASE_BRANCH` | no | `main` | Base branch for diff comparison. Falls back to `GITHUB_BASE_REF` if unset. |
| `REVIEW_PROMPT_FILE` | no | *(7-dimension checklist)* | Path to a markdown file (relative to repo root) with a custom review prompt. Overrides the default checklist. |
| `CODEBASE_OVERVIEW` | no | — | High-level context about the codebase (framework, patterns, architecture) injected into the review prompt. |
| `MAX_FILES` | no | `100` | Maximum changed files before the action skips. Prevents massive PRs from running up API costs. |
| `MAX_DIFF_LINES` | no | `8000` | Maximum diff lines before truncation. First N lines kept (lexicographic by file path); a truncation notice is appended. |
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
├── actions/
│   └── code-review/       # This action
│       ├── action.yml
│       ├── Dockerfile
│       ├── src/            # fetch-diff → build-prompt → call-openrouter → ...
│       └── prompts/        # Default review checklist
├── scripts/
│   └── parse-verdict.sh    # Shared: verdict format validator
└── docs/                   # Design specs and plans
```

The monorepo is structured for future actions (`claude-mention`, etc.) to share conventions and utilities.

## Development

```bash
# Run all tests (requires bats, jq, git)
bats actions/*/__tests__/*.bats

# Build the Docker image
docker build -f code-review/Dockerfile -t code-review-action:test .

# Lint all shell scripts
shellcheck actions/*/src/*.sh

# Validate action.yml against GitHub's schema
npx action-validator code-review/action.yml
```

Tests are hermetic — they use recorded fixtures for OpenRouter responses and mock `curl` for GitHub API calls. No API key needed for the unit test suite.

## License

MIT
