# Harden Code Review Action — Plan

**Date:** 2026-06-16   **Spec:** `docs/toolu/specs/2026-06-15-code-review-action-design.md`

## Context

Four targeted changes to the code-review action: switch default model, support markdown prompt files, add in-progress comment, and rename the API key input. All are surgical edits to existing files — no new architecture.

## Approach

Edit 5 files. Two new behaviors (prompt file, in-progress comment) with small additions to `build-prompt.sh` and `main.sh`. Two renames (model default, secret name) across `action.yml`, scripts, and README.

## Steps (machine-readable)

```json
[
  {
    "id": "rename-secret",
    "title": "Rename openrouter-api-key → OPENROUTER_API_KEY in action.yml, scripts, README, and test fixtures",
    "check": "! grep -rq 'openrouter-api-key' action.yml code-review/action.yml code-review/src/ README.md code-review/__tests__/ && grep -q 'OPENROUTER_API_KEY' code-review/action.yml"
  },
  {
    "id": "default-model",
    "title": "Change default model from anthropic/claude-sonnet-4 to qwen/qwen3.7-max in action.yml and build-prompt.sh",
    "check": "grep -q \"qwen/qwen3.7-max\" code-review/action.yml && grep -q \"qwen/qwen3.7-max\" code-review/src/build-prompt.sh"
  },
  {
    "id": "prompt-file-input",
    "title": "Replace review-prompt string input with review-prompt-file (path to markdown) in action.yml",
    "check": "grep -q 'review-prompt-file' code-review/action.yml && ! grep -q 'review-prompt' code-review/action.yml"
  },
  {
    "id": "prompt-file-read",
    "title": "Update build-prompt.sh to read review prompt from file path when INPUT_REVIEW_PROMPT_FILE is set",
    "check": "bash -n code-review/src/build-prompt.sh && bats code-review/__tests__/build-prompt.bats"
  },
  {
    "id": "in-progress-comment",
    "title": "Add in-progress comment posting to main.sh before OpenRouter call, with comment ID tracking for later edit",
    "check": "bash -n code-review/src/main.sh && grep -q 'PR Review in Progress' code-review/src/main.sh && grep -q 'in.progress' code-review/src/main.sh"
  },
  {
    "id": "in-progress-template",
    "title": "Add in-progress comment template to main.sh (checkboxes: read diff, review files, analyze, post findings)",
    "check": "grep -q '\\- \\[ \\]' code-review/src/main.sh"
  },
  {
    "id": "update-readme",
    "title": "Update README.md: new default model, OPENROUTER_API_KEY rename, review-prompt-file usage, in-progress comment description",
    "check": "grep -q 'qwen/qwen3.7-max' README.md && grep -q 'OPENROUTER_API_KEY' README.md && grep -q 'review-prompt-file' README.md"
  },
  {
    "id": "full-test-suite",
    "title": "Run full test suite (29 bats tests) — all must pass",
    "check": "bats code-review/__tests__/*.bats 2>&1 | grep -q '29 tests, 0 failures'"
  }
]
```

## Critical files

| File | Action | What changes |
|---|---|---|
| `code-review/action.yml` | Edit | Rename `openrouter-api-key` → `OPENROUTER_API_KEY`, default model → `qwen/qwen3.7-max`, replace `review-prompt` with `review-prompt-file` |
| `code-review/src/build-prompt.sh` | Edit | Default model, read prompt from file path when `INPUT_REVIEW_PROMPT_FILE` is set |
| `code-review/src/main.sh` | Edit | Post in-progress comment before API call, track comment ID, edit after review |
| `README.md` | Edit | All user-facing references updated |
| `code-review/__tests__/build-prompt.bats` | Edit | Add test for prompt file reading |

## Verification

```bash
# Full test suite
bats code-review/__tests__/*.bats

# Verify renames are complete
! grep -rq 'openrouter-api-key' code-review/ README.md
grep -q 'OPENROUTER_API_KEY' code-review/action.yml
grep -q 'qwen/qwen3.7-max' code-review/action.yml

# Verify in-progress comment flow
grep -q 'PR Review in Progress' code-review/src/main.sh

# Docker build still works
docker build -f code-review/Dockerfile -t code-review-action:test .
```
