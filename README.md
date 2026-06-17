<div align="center">

# toolu-ghactions

### Engineering discipline, enforced on every pull request.

[toolu](https://github.com/Falconiere/toolu) wires quality gates into your local AI coding agent — blocking the session while any error stands. **toolu-ghactions** carries the same discipline into CI: a multi-vendor **AI code reviewer** that audits every PR against a 7-dimension checklist and posts a machine-readable verdict, plus a **Cloudflare Tunnel** action that exposes a runner port for live preview review. I build these to keep the quality bar high on the work I ship every day — open, MIT-licensed, take the whole thing or lift a piece.

[![Release](https://img.shields.io/github/v/release/Falconiere/toolu-ghactions?sort=semver&color=d97757)](https://github.com/Falconiere/toolu-ghactions/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Tests](https://img.shields.io/badge/tests-108%20passing-brightgreen)](https://github.com/Falconiere/toolu-ghactions/actions/workflows/tests.yml)
[![Vendors](https://img.shields.io/badge/AI%20vendors-6-d97757)](#code-review)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-blueviolet)](./CONTRIBUTING.md)

[Why](#why) · [Actions](#actions) · [code-review](#code-review) · [cloudflare-tunnel](#cloudflare-tunnel) · [How it works](#how-it-works) · [Development](#development) · [Releases](#releases)

</div>

---

## Why

Your AI coding agent writes a PR in minutes — then it's *your* afternoon spent re-typing the same review feedback: *that error is swallowed, that test is all mocks, that line number is hallucinated, that doc no longer matches the code.* The discipline lives in your head, and it doesn't scale to every PR on every repo.

`toolu` solved that locally — hooks that gate every edit before the agent moves on. **toolu-ghactions is the CI half of the same idea:**

- **Review runs on the diff, not in your head.** Every PR is audited against a fixed 7-dimension checklist (correctness, security, performance, test coverage, doc accuracy, tight assertions, migration warnings) by one model or an **ensemble of up to 6 vendors** voting in parallel.
- **The verdict is machine-readable.** A structured comment ends in `` `agent-merge-approved` `` / `` `agent-request-changes` `` — the exact format [`pr-babysit`](https://github.com/Falconiere/toolu/tree/main/plugins/pr-babysit) and [`parse-verdict.sh`](https://github.com/Falconiere/toolu/blob/main/plugins/pr-babysit/scripts/parse-verdict.sh) already consume. Drop it into CI and your existing babysit loop reads it with zero changes.
- **It's advisory, never a hard block.** Findings post as inline comments with committable ` ```suggestion ` blocks. CI stays green; you stay in control.

One YAML block, your API key, done. MIT-licensed and built in the open.

## Actions

| | Action | What it does | Sub-actions |
|---|---|---|---|
| 🔍 | [**code-review**](./code-review/README.md) | AI PR review against a 7-dimension checklist across 6 vendors (OpenRouter, OpenAI, Anthropic, DeepSeek, Moonshot, MiniMax). Posts a structured verdict + inline suggestions. | — |
| 🌐 | [**cloudflare-tunnel**](./cloudflare-tunnel/README.md) | Expose a runner port to the public internet via a Cloudflare Tunnel — quick or named — for live preview / visual review. | `start` · `stop` · `wait` |

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
      - uses: falconiere/toolu-ghactions/code-review@v2
        with:
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
```

Multi-provider ensembles, merge strategies, custom checklists, and the full inputs table → **[`code-review/README.md`](./code-review/README.md)**.

### cloudflare-tunnel

```yaml
- uses: falconiere/toolu-ghactions/cloudflare-tunnel/start@v2
  id: tunnel
  with:
    port: 3000
- run: echo "Live at ${{ steps.tunnel.outputs.tunnel-url }}"
```

Named tunnels, outputs, and troubleshooting → **[`cloudflare-tunnel/README.md`](./cloudflare-tunnel/README.md)**.

## How it works

The code-review action runs a **fan-out → merge → post** pipeline. Each provider reviews the diff independently; a deterministic merger (no LLM) combines the verdicts and posts one comment.

```mermaid
flowchart LR
    PR([Pull request]) --> D[fetch &amp; shape diff<br/>strip noise · line-prime]
    D --> P1[provider 1]
    D --> P2[provider 2]
    D --> PN[provider N]
    P1 --> M{{merge verdicts<br/>dedup · merge_strategy}}
    P2 --> M
    PN --> M
    M --> V([post verdict<br/>+ inline suggestions])
    style PR fill:#d97757,color:#fff,stroke:none
    style M fill:#1f6feb,color:#fff,stroke:none
    style V fill:#3fb950,color:#fff,stroke:none
```

1. **Fetch & shape.** Resolve the merge-base, strip noise (lockfiles, minified, generated, source maps), drop binaries, and prime every diff line with its real source line number so findings anchor to actual lines.
2. **Parallel reviews.** One review per provider against the full checklist. Findings are validated per-provider — hallucinated line numbers and low-confidence findings dropped before the merge.
3. **Merge.** A deterministic merger dedups findings by `(path, line, end_line, fingerprint)`, keeps the highest severity, and sets the final verdict per `merge_strategy` (`conservative` / `majority` / `all_approve`).
4. **Post.** A summary verdict comment with the machine-readable label, plus per-line review comments with committable suggestions via the GitHub Reviews API.

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
# Run all test suites (108 tests; requires bats, jq, git)
bats code-review/__tests__/*.bats cloudflare-tunnel/__tests__/*.bats

# Build the Docker images
docker build -t code-review-action:test code-review/
docker build -t cloudflare-tunnel-action:test cloudflare-tunnel/

# Lint all shell scripts (style/info advisory; warnings+ block CI)
shellcheck --severity=warning code-review/src/*.sh cloudflare-tunnel/src/*.sh scripts/*.sh

# Validate action.yml against GitHub's schema
npx @action-validator/cli code-review/action.yml
```

Tests are hermetic — recorded fixtures for provider responses, mocked `curl` for GitHub API calls. No API key needed for the unit suite. See **[CONTRIBUTING.md](./CONTRIBUTING.md)**.

## Releases

Fully automated via [release-please](https://github.com/googleapis/release-please) — a release is cut on every push to `main` when conventional-commit changes are detected.

- **Commit convention** — [Conventional Commits](https://www.conventionalcommits.org/): `fix:` → patch, `feat:` → minor, `feat!:`/`fix!:` → major. `docs:`/`chore:`/`test:`/`ci:` → changelog only.
- **release-please PR** — opened/updated on each push to `main` with the version bump and changelog.
- **Merge it** — triggers `release.yml`: tags the release, publishes a GitHub Release, and force-moves the floating major alias (`v2` → latest `v2.x.y`).

Pin `@v2` for the floating major (**recommended**), or `@v2.0.0` for exact semver. Force a bump with `Release-As: X.Y.Z` in a commit footer.

## License

MIT — see [LICENSE](./LICENSE).
