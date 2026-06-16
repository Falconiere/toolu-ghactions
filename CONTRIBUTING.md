# Contributing

Thanks for improving the AI Code Review action.

## Commit convention

This repo releases automatically via [release-please](https://github.com/googleapis/release-please), so commit messages must follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat: ...` → minor bump
- `fix: ...` → patch bump
- `feat!: ...` / `fix!: ...` (breaking change) → major bump
- `docs:`, `chore:`, `test:`, `ci:` → no bump (still in the changelog)

Use the same convention in PR titles — the squash-merge commit drives the release.

## Development

```bash
# Run the test suite (requires bats, jq, git)
bats code-review/__tests__/*.bats

# Lint shell scripts (style/info are advisory; warnings+ block CI)
shellcheck --severity=warning code-review/src/*.sh scripts/*.sh

# Validate the action metadata
npx @action-validator/cli code-review/action.yml

# Build the Docker image
docker build -t code-review-action:test code-review/
```

## Tests

Tests are [bats](https://github.com/bats-core/bats-core) over **real recorded fixtures** — recorded OpenRouter responses and real git repositories built in `setup()`. Do not add fabricated/mock finding data. The `curl` boundary is replaced by a stub that replays recorded fixtures; the data under test stays real.

## Conventions

- One responsibility per script, named after what it does.
- Shell scripts use `set -euo pipefail`; handle errors, never silence them.
- Every fallible call gets a real handler.
- Keep scripts focused (≤ 300 lines); split when they grow past it.

## Recording provider fixtures

Fixture files live under `code-review/__tests__/fixtures/<provider>/` and must be **real recorded API responses**. To record:

1. Get a real API key for the provider.
2. Make a `curl` call matching the vendor's wire format (see `providers/<name>/call.sh` for the endpoint and headers).
3. Save the raw JSON response to `__tests__/fixtures/<provider>/success.json`. For error fixtures, use a deliberately bad API key to trigger a 401.
4. Sanitize — remove any token/secret from the response body before committing.

Anthropic needs two success fixtures: `success.json` (tool-use) and `success-no-tooluse.json` (text-only).

Merge test fixtures go under `__tests__/fixtures/merge/` as input-expected pairs: `<case>.json` (input) and `<case>.expected.json` (expected output).

**4 providers (anthropic, deepseek, moonshot, minimax) currently have stub fixtures.** Bats tests for these providers are pending until real fixtures are recorded.
