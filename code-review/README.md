<div align="center">

# 🔍 code-review

### Multi-vendor AI code review for every pull request

Audits the diff against a 7-dimension checklist — correctness, security, performance, test coverage, doc accuracy, tight assertions, migration warnings — using **one model or an ensemble of up to 6 vendors** (OpenRouter, OpenAI, Anthropic, DeepSeek, Moonshot, MiniMax) voting in parallel. Merges the verdicts and posts a structured, machine-readable comment with inline, committable suggestions.

[![Release](https://img.shields.io/github/v/release/Falconiere/toolu-ghactions?sort=semver&color=d97757)](https://github.com/Falconiere/toolu-ghactions/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](../LICENSE)
[![Tests](https://img.shields.io/badge/tests-119%20passing-3fb950)](https://github.com/Falconiere/toolu-ghactions/actions/workflows/tests.yml)

[Quick start](#quick-start) · [Multiple providers](#multiple-providers) · [How it works](#how-it-works) · [Example verdict](#example-verdict) · [Inputs](#inputs) · [Outputs](#outputs)

</div>

> Part of the [**toolu-ghactions**](../README.md) monorepo.

---

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
      - uses: falconiere/toolu-ghactions/code-review@v2
        with:
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
```

> `fetch-depth: 0` is recommended but optional — on a shallow checkout the action
> deepens the history itself to find the merge-base.

Use `MODEL` to switch models and `REVIEW_PROMPT_FILE` for a custom checklist:

```yaml
      - uses: falconiere/toolu-ghactions/code-review@v2
        with:
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
          MODEL: 'anthropic/claude-sonnet-4'
          REVIEW_PROMPT_FILE: '.github/review-prompt.md'
```

On every PR push, the action fetches the diff, sends it to the configured model(s), and posts a verdict comment directly on the PR.

## Multiple providers

Use the `PROVIDERS` input to run multiple AI vendors in parallel — an ensemble
review that merges N independent verdicts into one. Each provider gets its own
model + API key:

```yaml
- uses: falconiere/toolu-ghactions/code-review@v2
  with:
    PROVIDERS: |
      [
        {"provider": "openrouter", "model": "minimax/minimax-m3", "api_key": "${{ secrets.OPENROUTER_API_KEY }}"},
        {"provider": "anthropic",  "model": "claude-sonnet-4-5", "api_key": "${{ secrets.ANTHROPIC_API_KEY }}"},
        {"provider": "openai",     "model": "gpt-4o",             "api_key": "${{ secrets.OPENAI_API_KEY }}"}
      ]
    MERGE_STRATEGY: conservative
```

`providers` is a JSON array. Each entry:
- `provider` (required): `openrouter | openai | anthropic | deepseek | moonshot | minimax`
- `model` (required): vendor model id
- `api_key` (required): API key (use `${{ secrets.X }}` — masked in CI logs)
- `enforce_json_schema` (optional, default `true`): request strict JSON output
- `max_tokens` (optional, default `4096`): per-provider response budget

### Merge strategies

`merge_strategy` controls how N verdicts become one:

| Strategy | Rule |
|---|---|
| `conservative` (default) | Any provider says `changes` → overall `changes`. Safest for CI. |
| `majority` | `ceil(N/2)+1` must say `changes` for overall `changes`. Errors abstain. |
| `all_approve` | All providers must say `approved`. Errors count as `changes`. |

Provider findings are deduplicated across providers by
`(path, line, end_line, text-fingerprint)` and the highest severity wins.

### Legacy single-provider (back-compat)

The legacy `OPENROUTER_API_KEY` + `MODEL` inputs still work — they're
auto-translated to a single-provider `PROVIDERS` list:

```yaml
- uses: falconiere/toolu-ghactions/code-review@v2
  with:
    OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
    MODEL: 'minimax/minimax-m3'
```

This is identical to the v1.2 behavior and requires no migration.
`FALLBACK_MODEL` is dropped (multi-provider IS the fallback). `REVIEW_MODE` is
a no-op (the per-dimension sub-reviewer is replaced by multi-provider dispatch).

## How it works

The action runs a fan-out → merge → post pipeline:

**1 — Fetch & shape the diff.** Resolves the merge-base, strips noise (lockfiles,
minified, generated, source maps), drops binaries, and line-primes every diff
line with its real source line number so findings anchor to actual lines.

**2 — Parallel provider reviews.** One review runs per provider in the `providers`
list. Each provider gets the full 7-dimension checklist. Findings are validated
against the diff per-provider (hallucinated line numbers and low-confidence
findings are dropped before the cross-provider merge).

**3 — Multi-provider merge.** A deterministic merger combines N verdicts using
`merge_strategy`. No LLM call — the merger deduplicates findings by
`(path, line, end_line, text-fingerprint)` and sets the final verdict per the
configured strategy.

**4 — Post.** A summary verdict comment (machine-readable label for `pr-babysit`),
plus — when `INLINE_COMMENTS` is on — per-line review comments derived from the
merged findings, with committable ` ```suggestion ` blocks via the GitHub Reviews
API (advisory `COMMENT` event; it never hard-blocks merge).

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
| `PROVIDERS` | no | — | JSON array of `{provider, model, api_key}` entries. When set, runs one review per provider in parallel. Preferred over the legacy single-provider inputs. |
| `MERGE_STRATEGY` | no | `conservative` | How to merge N verdicts: `conservative` (any changes wins), `majority`, `all_approve` |
| `OPENROUTER_API_KEY` | no | — | **Legacy.** OpenRouter API key. Used only when `PROVIDERS` is unset. Auto-translated to a single-provider `PROVIDERS` list. |
| `MODEL` | no | `minimax/minimax-m3` | **Legacy.** OpenRouter model identifier. Used only when `PROVIDERS` is unset and `OPENROUTER_API_KEY` is set. |
| `FALLBACK_MODEL` | no | *(dropped)* | **Legacy — dropped.** Extra model in the OpenRouter `models[]` fallback array. Multi-provider replaces this. Logs a deprecation hint if set. |
| `MAX_TOKENS` | no | `4096` | Max completion tokens per request. Default for per-entry `max_tokens` when the entry omits it. |
| `REVIEW_MODE` | no | *(no-op)* | **Legacy — no-op.** Per-dimension sub-reviewer is removed; multi-provider replaces it. |
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
- uses: falconiere/toolu-ghactions/code-review@v2
  id: review
  with:
    OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
- if: steps.review.outputs.verdict == 'changes'
  run: echo "PR needs work — ${{ steps.review.outputs.findings-count }} findings"
```

## License

MIT — see [LICENSE](../LICENSE).
