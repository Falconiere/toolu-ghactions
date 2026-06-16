# Toolu GitHub Actions

[![tests](https://github.com/Falconiere/toolu-ghactions/actions/workflows/tests.yml/badge.svg)](https://github.com/Falconiere/toolu-ghactions/actions/workflows/tests.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A monorepo of composable, Docker-based GitHub Actions that bring the [toolu](https://github.com/Falconiere/toolu) workflow methodology to any repository. Each action is self-contained, versioned together, and published to the GitHub Marketplace.

## Actions

| Action | What it does | Sub-actions |
|---|---|---|
| [**code-review**](./code-review/README.md) | AI PR review against a 7-dimension checklist across 6 vendors (OpenRouter, OpenAI, Anthropic, DeepSeek, Moonshot, MiniMax). Posts a structured verdict + inline suggestions. | — |
| [**cloudflare-tunnel**](./cloudflare-tunnel/README.md) | Expose a runner port to the public internet via a Cloudflare Tunnel — quick or named. | `start`, `stop`, `wait` |

### code-review

Drop it into `.github/workflows/code-review.yml` and add an OpenRouter key:

```yaml
name: Code Review
on:
  pull_request:
    types: [opened, synchronize, ready_for_review, reopened]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      issues: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: falconiere/toolu-ghactions/code-review@v1
        with:
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
```

Full inputs, multi-provider ensembles, and merge strategies → [`code-review/README.md`](./code-review/README.md).

### cloudflare-tunnel

```yaml
- uses: falconiere/toolu-ghactions/cloudflare-tunnel/start@v1
  id: tunnel
  with:
    port: 3000
- run: echo "Live at ${{ steps.tunnel.outputs.tunnel-url }}"
```

Named tunnels, outputs, and troubleshooting → [`cloudflare-tunnel/README.md`](./cloudflare-tunnel/README.md).

## Repository structure

```
.
├── code-review/            # AI code review action (Toolu AI Code Review)
│   ├── action.yml
│   ├── Dockerfile
│   ├── src/                # fetch-diff → build-prompt → providers/<name>/ → merge → post
│   ├── prompts/            # Default review checklist
│   └── __tests__/          # Hermetic bats test suite
├── cloudflare-tunnel/      # Cloudflare Tunnel action (Toolu Cloudflare Tunnel)
│   ├── start/ stop/ wait/  # Sub-action entry points
│   ├── Dockerfile
│   ├── src/                # start.sh / stop.sh / wait.sh / install-cloudflared.sh
│   └── __tests__/          # Hermetic bats test suite
├── scripts/                # Shared helpers (parse-verdict.sh, capture-fixtures.sh)
└── docs/toolu/             # Design specs and build plans
```

The monorepo is structured so future actions share conventions and utilities.

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

Tests are hermetic — they use recorded fixtures for provider responses and mock `curl` for GitHub API calls. No API key needed for the unit test suite.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the contribution workflow.

## Releases

Releases are fully automated via [release-please](https://github.com/googleapis/release-please). A release is cut on every push to `main` when conventional-commit-triggered changes are detected.

- **Commit convention** — [Conventional Commits](https://www.conventionalcommits.org/) in PR titles and merge commits: `fix:` → patch, `feat:` → minor, `feat!:`/`fix!:` → major. `docs:`/`chore:`/`test:`/`ci:` → no bump (changelog only).
- **release-please PR** — opened/updated on each push to `main` with the version bump and changelog entry.
- **Merge it** — merging triggers `release.yml`, which tags the release, publishes a GitHub Release, and force-moves the floating major alias (e.g. `v1` → latest `v1.x.y`).

Versioning:

- `@v1` — floating major alias, tracks latest `v1.x.y`. **Recommended for callers.**
- `@v1.0.0` — pin to exact semver for maximum stability.

To force a specific bump, add `Release-As: X.Y.Z` to a commit footer. No other manual steps.

## License

MIT — see [LICENSE](./LICENSE).
