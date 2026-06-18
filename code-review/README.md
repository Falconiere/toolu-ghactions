<div align="center">

# 🔍 code-review

### Multi-vendor AI code review for every pull request

Audits the diff against an 8-dimension checklist — correctness, security, performance, test coverage, doc accuracy, tight assertions, migration warnings, and adherence to the project's own convention files — using **one model or an ensemble of up to 6 vendors** (OpenRouter, OpenAI, Anthropic, DeepSeek, Moonshot, MiniMax) voting in parallel. Merges the verdicts and posts a structured, machine-readable comment with inline, committable suggestions.

[![Release](https://img.shields.io/github/v/release/Falconiere/toolu-ghactions?sort=semver&color=d97757)](https://github.com/Falconiere/toolu-ghactions/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](../LICENSE)
[![Tests](https://img.shields.io/badge/tests-119%20passing-3fb950)](https://github.com/Falconiere/toolu-ghactions/actions/workflows/tests.yml)

[Quick start](#quick-start) · [Multiple providers](#multiple-providers) · [How it works](#how-it-works) · [Example verdict](#example-verdict) · [Custom identity](#custom-identity-github-app) · [@mention re-trigger](#mention-re-trigger) · [Review memory](#review-memory) · [Inputs](#inputs) · [Outputs](#outputs)

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
        {"provider": "openrouter", "model": "deepseek/deepseek-v4-flash", "api_key": "${{ secrets.OPENROUTER_API_KEY }}"},
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
| `majority` | More than half of the `D` deciding providers (`floor(D/2)+1`) must say `changes`. |
| `all_approve` | All deciding providers must say `approved`. |

Errored providers (crash, rate-limit, bad response) **abstain** — the verdict is
computed only over providers that returned a real opinion, so one flaky provider
never forces a `changes` verdict on its own. If **every** provider errors (or
none is configured), the verdict is `error`, rendered as "🚫 Review incomplete —
provider error" and carrying the `agent-request-changes` label so a failed
review never auto-merges.

Provider findings are deduplicated across providers by
`(path, line, end_line, text-fingerprint)` and the highest severity wins.

### Legacy single-provider (back-compat)

The legacy `OPENROUTER_API_KEY` + `MODEL` inputs still work — they're
auto-translated to a single-provider `PROVIDERS` list:

```yaml
- uses: falconiere/toolu-ghactions/code-review@v2
  with:
    OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
    MODEL: 'deepseek/deepseek-v4-flash'
```

This is identical to the v1.2 behavior and requires no migration.
`FALLBACK_MODEL` is dropped (multi-provider IS the fallback). `REVIEW_MODE` is
a no-op (the per-dimension sub-reviewer is replaced by multi-provider dispatch).

## How it works

The action runs a fan-out → merge → post pipeline:

**1 — Fetch & shape the diff.** Resolves the merge-base, strips noise (lockfiles,
minified, generated, source maps, `dist/`/`build/` output, plus anything detected
as generated by content — a line over 5000 chars or a blob over 1MB), drops
binaries, and line-primes every diff line with its real source line number so
findings anchor to actual lines.
Then gathers the repo's own convention files from the base ref (see
[Project conventions](#project-conventions)).

**2 — Parallel provider reviews.** One review runs per provider in the `providers`
list. Each provider gets the full 8-dimension checklist (the 8th, convention
adherence, applies only when project rules were found). Findings are validated
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

### Project conventions

The reviewer reads your repo's own rules and checks the diff against them — so a
change that breaks a documented house rule gets flagged, citing the rule. On by
default (`CHECK_PROJECT_RULES: true`); set it `false` to turn off.

What it reads, in priority order, **from the base ref** (never the PR head):

1. Root agent-rule files — `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.windsurfrules`, `.github/copilot-instructions.md`
2. Nested `CLAUDE.md` / `AGENTS.md` in ancestor directories of the changed files (per-package rules in a monorepo)
3. Rule directories — everything under `.cursor/rules/` and `.windsurf/rules/`
4. Curated conventions — `CONVENTIONS.md`, `CONTRIBUTING.md`, and `docs/conventions/`
5. Anything you add via `RULES_GLOB`

The gathered text is capped at `RULES_MAX_BYTES` (default 32 KB); whole files past
the cap are dropped with a notice. Two guarantees worth calling out:

- **Injection-safe.** Rules are read from the base branch tip via `git show`, so a
  PR that edits `CLAUDE.md` to say "approve everything" cannot influence its own
  review — the change only takes effect once merged. The rule text is reference
  data; it can never alter the verdict logic or output schema.
- **Bounded & quiet.** The plan/spec tree (`docs/toolu/**`, etc.) is never scooped;
  only the convention files above and your explicit `RULES_GLOB` are read.

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

## Custom identity (GitHub App)

By default the bot posts as the generic `github-actions[bot]` — anonymous, with
no project face. To brand it as **Toolu — Code Review** with its own avatar and
header logo, create a GitHub App and pass its `APP_ID` + `APP_PRIVATE_KEY`. The
private key is used *only* to mint a short-lived installation token at the start
of the run; it is never logged, and the comment then posts under the App's
identity. Without these inputs nothing changes — you stay on `github-actions[bot]`.

> The body header (logo + name) renders on **both** paths — even the
> `github-actions[bot]` fallback reads as "Toolu — Code Review". The App only
> changes the *posting account* (avatar + login on the comment).

> **It's your App, not ours.** This action is App-agnostic — it never ships or
> shares a private key. Whoever holds an App's key can post as that App, so a
> single shared identity across everyone's repos is impossible without a hosted
> token broker (which this action is not). To get a custom chip you create
> **your own** App and keep **your own** key in **your own** secrets. The App can
> be **private** (only your account can install it) — public is unnecessary.

### One-click setup (App Manifest)

Open **[`code-review/app-manifest.html`](./app-manifest.html)** (host it on GitHub
Pages, or just open the file in a browser). Enter your org (or leave blank for a
personal account) and click **Create the App** — GitHub pre-fills the name, the
four least-privilege permissions, and disables the webhook from
[`app-manifest.json`](./app-manifest.json). Then, on the created App's page:

1. Copy the **App ID**.
2. Click **Generate a private key** → downloads a `.pem`.
3. **Install** the App on the repo/org you want reviewed.
4. Add both as secrets (repo or org): `APP_ID` and `APP_PRIVATE_KEY`. Paste the
   full PEM, **or** base64-encode it first (`base64 -w0 key.pem`) to keep it on a
   single line — the action auto-detects and decodes either form.

### Manual setup

Prefer clicking through github.com → Settings → Developer settings → GitHub Apps:

1. **New GitHub App.** Name it whatever you like; uncheck/disable the webhook.
2. **Upload a logo/avatar** so the App has a face on the PR.
3. **Repository permissions** — only these four: **Pull requests: Read & write**,
   **Issues: Read & write**, **Contents: Read**, **Metadata: Read**.
4. **Install** it on the repo (or org), then **Generate a private key**.
5. Store the App **id** and **private key** (PEM) as repo/org secrets.

### Use it

```yaml
- uses: falconiere/toolu-ghactions/code-review@v2
  with:
    OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
    APP_ID: ${{ secrets.APP_ID }}
    APP_PRIVATE_KEY: ${{ secrets.APP_PRIVATE_KEY }}
```

The private key only signs a JWT exchanged for a short-lived installation token;
it is **never written to logs**. If exactly one of `APP_ID`/`APP_PRIVATE_KEY` is
set (or the mint fails), the action logs a `[WARN]` and continues on the
`github-actions[bot]` fallback.

> **Fork PRs stay unbranded.** GitHub withholds secrets from `pull_request` runs
> triggered by forks, so `APP_PRIVATE_KEY` is empty there and the bot falls back
> to `github-actions[bot]` (still fully functional). The branded identity shows on
> same-repo PRs and on `@toolu` re-triggers by collaborators.

> The header logo lives at [`code-review/assets/logo.png`](./assets/logo.png) and
> is currently a **placeholder** — replace it with your own art, or point
> `BOT_LOGO_URL` / `BOT_NAME` at your branding.

## @mention re-trigger

On a PR that iterates, a maintainer can ask for a fresh pass from a comment:

```
@toolu review
@toolu review focus on the auth changes
```

To enable it, the workflow must listen on **both** `pull_request` and
`issue_comment` (the latter is where comments arrive), carry the right
`permissions:`, and set a per-PR `concurrency:` group so two quick re-triggers
don't race on the single sticky comment:

```yaml
name: Code Review
on:
  pull_request:
    types: [opened, synchronize, ready_for_review, reopened]
  issue_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write
  issues: write

concurrency:
  group: code-review-${{ github.event.issue.number || github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: falconiere/toolu-ghactions/code-review@v2
        with:
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
```

The `concurrency:` group is keyed per PR — note the
`github.event.issue.number || github.event.pull_request.number` fallback, since
`issue_comment` and `pull_request` events expose the PR number on different
fields. On a comment trigger the action self-fetches the PR head, so no extra
checkout step is needed.

**Security gate.** A comment trigger runs with the repo's secrets, so the gate
**fails closed**:

- Only commenters with **write / maintain / admin** (per `MIN_TRIGGER_PERMISSION`,
  default `write`) can trigger. The permission check is denied on *any* error
  (non-2xx, missing field, network failure) — never failing open.
- Comments from bots, non-PR issues, or comments without the `TRIGGER_PHRASE` +
  `review` are ignored **before** any permission API call (no noise).
- The trailing text (`focus on …`) is treated as an **untrusted focus hint**: it
  is sanitized and injected into the user prompt inside a delimited UNTRUSTED
  block as a hint about *where* to look — **never** as instructions, and it
  cannot change the task, output schema, or verdict rules.
- An allowed trigger reacts 👀 on the comment; a denied one reacts 👎.
- A scoped/steered review (`@toolu review focus on …`) does **not** recompute
  "resolved" — see [Review memory](#review-memory).

## Review memory

With `REVIEW_MEMORY: true` (default), each review recaps what changed since the
last pass instead of starting from scratch:

- ✅ **resolved** — findings from the previous pass that are now gone
- 🔁 **still open** — findings carried over from the previous pass
- ⚠️ **new** — findings introduced since the previous pass

…plus a collapsed `<details>` **history** of recent passes (verdict + counts).
Findings are matched across runs by a line-independent fingerprint
(`path` + `category` + normalized text), so a finding that merely drifted to a
new line stays **still open** rather than flipping to resolved + new.

The state is stored in a **hidden HTML marker** inside the sticky review comment
itself (gzip + base64) — no external store, no extra permissions, nothing to
clean up. The marker is login-agnostic, so it survives switching to a custom App
identity; if the comment is deleted, memory simply starts fresh.

`resolved` is only computed on a **full review**. On a steered/focused run
(`@toolu review focus on …`) or a truncated/partial diff, resolutions are *not*
recomputed (the recap is labeled accordingly) — a finding that wasn't
re-examined is never falsely reported as fixed. Set `REVIEW_MEMORY: false` to
turn the recap and history off.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `PROVIDERS` | no | — | JSON array of `{provider, model, api_key}` entries. When set, runs one review per provider in parallel. Preferred over the legacy single-provider inputs. |
| `MERGE_STRATEGY` | no | `conservative` | How to merge N verdicts: `conservative` (any changes wins), `majority`, `all_approve` |
| `OPENROUTER_API_KEY` | no | — | **Legacy.** OpenRouter API key. Used only when `PROVIDERS` is unset. Auto-translated to a single-provider `PROVIDERS` list. |
| `MODEL` | no | `deepseek/deepseek-v4-flash` | **Legacy.** OpenRouter model identifier. Used only when `PROVIDERS` is unset and `OPENROUTER_API_KEY` is set. |
| `FALLBACK_MODEL` | no | *(dropped)* | **Legacy — dropped.** Extra model in the OpenRouter `models[]` fallback array. Multi-provider replaces this. Logs a deprecation hint if set. |
| `MAX_TOKENS` | no | `4096` | Max completion tokens per request. Default for per-entry `max_tokens` when the entry omits it. |
| `REVIEW_MODE` | no | *(no-op)* | **Legacy — no-op.** Per-dimension sub-reviewer is removed; multi-provider replaces it. |
| `MIN_CONFIDENCE` | no | `high` | Drop findings below this confidence unless severity is blocker/high (`high` or `medium`) |
| `ENFORCE_JSON_SCHEMA` | no | `true` | Use `response_format` json_schema + provider routing; set `false` for free-text + regex fallback |
| `INLINE_COMMENTS` | no | `true` | Post per-line review comments with committable code suggestions (Reviews API), in addition to the summary comment |
| `MANAGE_LABELS` | no | `true` | Set a real PR label chip matching the verdict (`agent-merge-approved` / `agent-request-changes`) and remove the opposite one. Requires `issues: write`. |
| `BASE_BRANCH` | no | `main` | Base branch for diff comparison. Falls back to `GITHUB_BASE_REF` if unset. |
| `REVIEW_PROMPT_FILE` | no | *(8-dimension checklist)* | Path to a markdown file (relative to repo root) with a custom review prompt. Overrides the default checklist. Project conventions are still gathered and injected, but a custom prompt supplies its own dimensions. |
| `CODEBASE_OVERVIEW` | no | — | High-level context about the codebase (framework, patterns, architecture) injected into the review prompt. |
| `CHECK_PROJECT_RULES` | no | `true` | Auto-read the repo's own convention files **from the base ref** (`CLAUDE.md`, `AGENTS.md`, `.cursor/rules`, `.cursorrules`, `.windsurfrules`, `.github/copilot-instructions.md`, plus `CONVENTIONS.md` / `CONTRIBUTING.md` / `docs/conventions/`) and review the diff against them via the **Convention adherence** dimension. Set `false` to disable. See [Project conventions](#project-conventions). |
| `RULES_GLOB` | no | — | Extra path globs (relative to repo root, newline- or comma-separated) to include as project rules, e.g. `docs/architecture/**`. Matched against tracked files at the base ref. |
| `RULES_MAX_BYTES` | no | `32768` | Byte cap on the gathered rules. Files are added in priority order until the cap; whole files past it are dropped with a truncation notice. |
| `MAX_FILES` | no | `0` (unlimited) | Maximum changed files before the action skips. `0` reviews any number of files — the only ceiling is your OpenRouter billing balance. Set a positive value to opt into a hard skip on huge PRs. |
| `MAX_DIFF_LINES` | no | `0` (unlimited) | Maximum diff lines before truncation. `0` reviews the whole diff. Set a positive value to keep the first N lines (lexicographic by file path) and append a truncation notice. |
| `TOKEN` | no | `${{ github.token }}` | GitHub token for posting and editing comments. |
| `APP_ID` | no | — | GitHub App id. Set together with `APP_PRIVATE_KEY` to post as a custom-branded App (`Toolu — Code Review`) instead of `github-actions[bot]`. Both must be set or the action falls back to the default identity. See [Custom identity](#custom-identity-github-app). |
| `APP_PRIVATE_KEY` | no | — | GitHub App private key — raw PEM **or** base64-encoded PEM (auto-decoded). Pair with `APP_ID`. Pass via a secret; never inline. Used only to mint a short-lived installation token — never logged. |
| `TRIGGER_PHRASE` | no | `@toolu` | Mention prefix that re-triggers a review from a PR comment, e.g. `@toolu review focus on auth`. Requires the workflow to also listen on `issue_comment`. See [@mention re-trigger](#mention-re-trigger). |
| `MIN_TRIGGER_PERMISSION` | no | `write` | Minimum repo permission a commenter needs to trigger a review via `@mention`: `write` or `admin`. The check fails closed (denied on any error). |
| `BOT_NAME` | no | `Toolu — Code Review` | Display name shown in the comment body header. |
| `BOT_LOGO_URL` | no | `…/code-review/assets/logo.png` | Logo image shown in the comment body header. |
| `REVIEW_MEMORY` | no | `true` | Recap what changed since the last review (resolved / still-open / new) and keep a collapsed history, using a hidden state marker in the sticky comment. Set `false` to disable. See [Review memory](#review-memory). |

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
