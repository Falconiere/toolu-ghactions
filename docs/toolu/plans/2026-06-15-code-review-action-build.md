# Build AI Code Review Action — Plan

**Date:** 2026-06-15   **Spec:** `docs/toolu/specs/2026-06-15-code-review-action-design.md`

## Context

Build a Docker-based GitHub Action that runs AI code review on PRs via OpenRouter. The action fetches the PR diff, sends it to Claude with the toolu 7-dimension checklist, parses the structured JSON response, and posts/edits a verdict comment on the PR in the format `parse-verdict.sh` / `pr-babysit` already consume. Publishable to GitHub Marketplace.

## Approach

Docker action (Alpine + bash, git, jq, curl). Seven single-responsibility scripts orchestrated by `main.sh`. All GitHub API calls via `curl` + REST API (no `gh` CLI dependency). OpenRouter API call with `response_format: json_schema` for structured output. Comment format follows the established `parse-verdict.sh` contract.

Reused: verdict comment format from `pr-babysit/scripts/parse-verdict.sh`, review dimensions from `code-review/skills/review/SKILL.md`.

## Steps (machine-readable)

```json
[
  {
    "id": "scaffold-repo",
    "title": "Scaffold repo structure and action.yml",
    "check": "test -f action.yml && test -f Dockerfile && test -d src/ && test -d prompts/ && test -d __tests__/fixtures/"
  },
  {
    "id": "dockerfile",
    "title": "Write Dockerfile (Alpine + bash, git, jq, curl)",
    "check": "docker build -t code-review-action:test . 2>&1 | grep -q 'Successfully tagged'"
  },
  {
    "id": "vendor-parse-verdict",
    "title": "Vendor scripts/parse-verdict.sh from toolu repo (pr-babysit/scripts/parse-verdict.sh)",
    "check": "test -f scripts/parse-verdict.sh && grep -q 'is_review_comment' scripts/parse-verdict.sh && grep -q 'agent-merge' scripts/parse-verdict.sh"
  },
  {
    "id": "checklist-prompt",
    "title": "Write prompts/review-checklist.txt (7-dimension default system prompt)",
    "check": "test -f prompts/review-checklist.txt && grep -q 'CORRECTNESS' prompts/review-checklist.txt && grep -q 'SECURITY' prompts/review-checklist.txt && grep -q 'PERFORMANCE' prompts/review-checklist.txt && grep -q 'TEST COVERAGE' prompts/review-checklist.txt && grep -q 'DOC/COMMENT ACCURACY' prompts/review-checklist.txt && grep -q 'TIGHT ASSERTIONS' prompts/review-checklist.txt && grep -q 'MIGRATION WARNINGS' prompts/review-checklist.txt"
  },
  {
    "id": "fetch-diff",
    "title": "Write src/fetch-diff.sh — resolve merge-base, compute diff, count files/lines, flag binaries",
    "check": "bash -n src/fetch-diff.sh && bats __tests__/fetch-diff.bats"
  },
  {
    "id": "build-prompt",
    "title": "Write src/build-prompt.sh — assemble system + user prompt JSON for OpenRouter",
    "check": "bash -n src/build-prompt.sh && bats __tests__/build-prompt.bats"
  },
  {
    "id": "call-openrouter",
    "title": "Write src/call-openrouter.sh — POST to OpenRouter, timeout handling, error mapping",
    "check": "bash -n src/call-openrouter.sh && bats __tests__/call-openrouter.bats"
  },
  {
    "id": "parse-response",
    "title": "Write src/parse-response.sh — validate JSON, extract verdict + findings, fallback regex",
    "check": "bash -n src/parse-response.sh && bats __tests__/parse-response.bats"
  },
  {
    "id": "format-verdict",
    "title": "Write src/format-verdict.sh — render markdown verdict comment from parsed response",
    "check": "bash -n src/format-verdict.sh && bats __tests__/format-verdict.bats"
  },
  {
    "id": "post-comment",
    "title": "Write src/post-comment.sh — find/edit/create PR comment via GitHub REST API (curl)",
    "check": "bash -n src/post-comment.sh && bats __tests__/post-comment.bats"
  },
  {
    "id": "main-entrypoint",
    "title": "Write src/main.sh — orchestrate with error handling (catch non-zero exits → post error comment), set action outputs",
    "check": "bash -n src/main.sh && bats __tests__/main.bats"
  },
  {
    "id": "test-fixtures",
    "title": "Verify all test fixtures exist (individual script steps create the fixtures they need; this is the aggregate gate)",
    "check": "test -f __tests__/fixtures/sample-diff.txt && test -f __tests__/fixtures/sample-diff-truncated.txt && test -f __tests__/fixtures/sample-openrouter-response-approved.json && test -f __tests__/fixtures/sample-openrouter-response-changes.json && test -f __tests__/fixtures/sample-openrouter-response-malformed.txt && test -f __tests__/fixtures/expected-verdict-comment.md && test -f __tests__/fixtures/parse-verdict-output.json"
  },
  {
    "id": "parse-verdict-compat",
    "title": "Vendor parse-verdict.sh as test fixture and validate comment format round-trip",
    "check": "cat __tests__/fixtures/expected-verdict-comment.md | bash scripts/parse-verdict.sh | jq -e '.is_review_comment == true and .state == \"complete\" and .findings | length > 0'"
  },
  {
    "id": "readme",
    "title": "Write README.md — marketplace listing with usage, inputs table, example workflow, outputs",
    "check": "test -f README.md && grep -q 'uses: falconiere/code-review-action@v1' README.md && grep -q 'openrouter-api-key' README.md"
  },
  {
    "id": "action-outputs",
    "title": "Ensure main.sh writes GitHub Actions outputs (verdict, findings-count, comment-url) via GITHUB_OUTPUT",
    "check": "grep -q 'GITHUB_OUTPUT' src/main.sh && grep -q 'echo.*verdict=' src/main.sh && grep -q 'echo.*findings-count=' src/main.sh && grep -q 'echo.*comment-url=' src/main.sh"
  },
  {
    "id": "docker-smoke",
    "title": "Smoke test the Docker image builds and main.sh runs end-to-end with mock env vars",
    "check": "docker build -t code-review-action:test . && docker run --rm -e INPUT_MODEL=test -e INPUT_MAX_FILES=1 -e GITHUB_EVENT_PATH=/dev/null -v $(pwd)/__tests__/fixtures/sample-diff.txt:/tmp/diff.txt code-review-action:test; exit_code=$?; [ $exit_code -le 1 ] && echo 'smoke test OK (exit <= 1 is acceptable for no-API-key run)'"
  }
]
```

## Critical files

| File | Action | Purpose |
|---|---|---|
| `action.yml` | Create | GitHub Action metadata: inputs, outputs, runs.docker |
| `Dockerfile` | Create | Alpine image: bash, git, jq, curl, copies src/ + prompts/ |
| `prompts/review-checklist.txt` | Create | Default system prompt (7 dimensions) |
| `src/main.sh` | Create | Entrypoint: parse inputs → orchestrate → set outputs |
| `src/fetch-diff.sh` | Create | `git merge-base` → `git diff`, truncation, binary detection |
| `src/build-prompt.sh` | Create | Assemble OpenRouter request JSON |
| `src/call-openrouter.sh` | Create | `curl` POST to OpenRouter, timeout, error handling |
| `src/parse-response.sh` | Create | `jq` validation, extract verdict + findings, regex fallback |
| `src/format-verdict.sh` | Create | Render markdown comment from structured review data |
| `src/post-comment.sh` | Create | GitHub REST API: list → find → edit or create PR comment |
| `scripts/parse-verdict.sh` | Vendor | Copied from toolu repo for format validation in tests |
| `__tests__/fixtures/*` | Create | 7 fixture files (diffs, responses, expected outputs) |
| `__tests__/*.bats` | Create | 6 bats test suites + 1 helpers.bash |
| `README.md` | Create | Marketplace-facing documentation |

## Verification

**Unit (hermetic, no API key):**
```bash
# Run all bats tests
bats __tests__/*.bats

# Validate comment format round-trip through parse-verdict.sh
cat __tests__/fixtures/expected-verdict-comment.md | bash scripts/parse-verdict.sh | jq .

# Validate action.yml schema
curl -sL https://raw.githubusercontent.com/actions/runner/main/src/Misc/action-schema.json | \
  yq eval -o json action.yml | jq --argfile schema /dev/stdin '.'

# Shellcheck all scripts
shellcheck src/*.sh
```

**Integration (requires OPENROUTER_API_KEY + GITHUB_TOKEN, run manually):**
```bash
# Run the action in a test PR
export GITHUB_REPOSITORY="falconiere/code-review-sandbox"
export GITHUB_EVENT_PATH="__tests__/fixtures/test-pr-event.json"
export OPENROUTER_API_KEY="sk-or-..."
export GITHUB_TOKEN="ghp_..."
export INPUT_MODEL="anthropic/claude-sonnet-4"

docker build -t code-review-action:test .
docker run --rm \
  -e GITHUB_REPOSITORY -e GITHUB_EVENT_PATH \
  -e OPENROUTER_API_KEY -e GITHUB_TOKEN -e INPUT_MODEL \
  -e INPUT_MAX_FILES=50 -e INPUT_MAX_DIFF_LINES=5000 \
  -v $(pwd):/github/workspace \
  code-review-action:test
```

**End-to-end (in a real repo's CI):**
1. Push action to GitHub, tag `v0.1.0`
2. In a test repo, create `.github/workflows/code-review.yml` referencing this action
3. Open a PR with known issues → verify comment appears, `parse-verdict.sh` parses it correctly
4. Push a fix commit → verify comment is edited (not duplicated), findings update

## Post-release

Once the action is published and stable, these downstream updates are required in the toolu repo:

1. **Update consumer workflow** — edit `toolu/.github/workflows/code-review.yml` to replace `uses: Falconiere/workflows/.github/workflows/code-review.yml@v2` with `uses: falconiere/code-review-action@v1`.
2. **Update SKILL.md** — edit `code-review/skills/review/SKILL.md` to mention the new action name ("the `code-review-action` CI bot") so users know what tool produces the verdict they see in PR comments.
