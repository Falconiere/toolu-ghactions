<div align="center">

# 🔍 code-review

### AI code review for every pull request

Audits the diff against an 8-dimension checklist — correctness, security, performance, test coverage, doc accuracy, tight assertions, migration warnings, and adherence to the project's own convention files — by running **one model** through either [OpenRouter](https://openrouter.ai) (any OpenAI-compatible model id) or the **native DeepSeek API** (`api.deepseek.com`), selected with a single `PROVIDER` input, via the **[Vercel AI SDK](https://sdk.vercel.ai)** (`generateObject` + Zod: structured output with retries, reasoning disabled). Posts a structured, machine-readable comment with inline, committable suggestions.

[![Release](https://img.shields.io/github/v/release/Falconiere/toolu-ghactions?sort=semver&color=d97757)](https://github.com/Falconiere/toolu-ghactions/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](../LICENSE)
[![Tests](https://img.shields.io/badge/tests-vitest-3fb950)](https://github.com/Falconiere/toolu-ghactions/actions/workflows/tests.yml)

[Quick start](#quick-start) · [Choosing a model](#choosing-a-model) · [How it works](#how-it-works) · [Example verdict](#example-verdict) · [Custom identity](#custom-identity-github-app) · [@mention re-trigger](#mention-re-trigger) · [Review memory](#review-memory) · [Inputs](#inputs) · [Outputs](#outputs)

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
  security-events: write # upload the gitleaks/opengrep SARIF to the Code Scanning tab

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
      - uses: falconiere/toolu-ghactions/code-review@v4
        with:
          API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
```

> `fetch-depth: 0` is recommended but optional — on a shallow checkout the action
> deepens the history itself to find the merge-base.

Use `MODEL_ID` to switch models and `REVIEW_PROMPT_FILE` for a custom checklist:

```yaml
      - uses: falconiere/toolu-ghactions/code-review@v4
        with:
          PROVIDER: openrouter
          MODEL_ID: 'anthropic/claude-sonnet-4'
          API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
          REVIEW_PROMPT_FILE: '.github/review-prompt.md'
```

On every PR push, the action shapes the diff, sends it to the configured model, and posts a verdict comment directly on the PR.

## Choosing a model

The action runs **one model**, selected with three flat inputs:

- **`PROVIDER`** — `openrouter` (default) or `deepseek` (native `api.deepseek.com`).
- **`MODEL_ID`** — the model id (per-provider default if omitted).
- **`API_KEY`** — the provider API key (**required**).

By default it is resolved through OpenRouter; you can also point it at the **native
DeepSeek API** (see below). Anything OpenRouter serves works as long as it's
OpenAI-compatible:

```yaml
- uses: falconiere/toolu-ghactions/code-review@v4
  with:
    PROVIDER: openrouter
    MODEL_ID: 'anthropic/claude-sonnet-4-5'   # default: deepseek/deepseek-v4-pro
    API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
    MAX_TOKENS: '16384'                        # per-request completion budget (default 8192)
```

For OpenRouter, `MODEL_ID` is an OpenRouter model id — `openai/gpt-4o`,
`anthropic/claude-sonnet-4-5`, `deepseek/deepseek-v4-flash`, `moonshotai/kimi-k2`,
and so on. One key, one endpoint: OpenRouter fronts every vendor, so switching
models is a string change, not a new integration.

Under the hood the action calls the model with the [Vercel AI SDK](https://sdk.vercel.ai)'s
`generateObject` against a Zod verdict schema, so the response is **structured by
construction** (with automatic retries and schema repair) rather than parsed out
of free text. Reasoning is disabled to keep the run fast and the token budget on
the review itself. If the model returns empty or unparseable output after retries,
the action surfaces an `error` verdict carrying the finish reason — rendered as
"🚫 Review incomplete" and labeled `request-changes`, so a failed review
never auto-merges. It never emits a silent null verdict.

### Native DeepSeek API

To call DeepSeek's own API (`api.deepseek.com`) directly instead of going through
OpenRouter — lower cost, direct billing — set `PROVIDER: deepseek` and a **native**
model id (no vendor prefix):

```yaml
- uses: falconiere/toolu-ghactions/code-review@v4
  with:
    PROVIDER: deepseek
    MODEL_ID: deepseek-v4-flash
    API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
```

`PROVIDER: deepseek` hits `api.deepseek.com` directly (lower cost, direct billing).
`MODEL_ID` takes a **native** DeepSeek model id (no vendor prefix) and defaults to
`deepseek-v4-flash` (non-thinking, fast, 1M context) when omitted. `API_KEY` is your
DeepSeek key — here `${{ secrets.DEEPSEEK_API_KEY }}` is just the name of *your*
GitHub repo secret, passed into the single `API_KEY` input.

Only `openrouter` (default) and `deepseek` are implemented; any other `PROVIDER`
value fails the action with an error that points you at routing it through OpenRouter
instead (`PROVIDER: "openrouter"`, `MODEL_ID: "<vendor>/<model>"`).

### Removed in v4 (migration)

v4 is a **breaking change**. The split provider/key inputs and the multi-vendor
ensemble inputs are **gone entirely** — they no longer exist on the action (they
are not silent no-ops). Migrate to the three flat provider inputs:

| Removed input | Replacement |
|---|---|
| `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY` | `API_KEY` (the key for the selected `PROVIDER`) |
| `MODEL` | `MODEL_ID` |
| `PROVIDERS` | `PROVIDER` + `MODEL_ID` + `API_KEY` (a single model only) |
| `MERGE_STRATEGY`, `FALLBACK_MODEL`, `REVIEW_MODE`, `ENFORCE_JSON_SCHEMA` | removed — one model, schema always enforced |

## Deterministic checks

The action is a **hybrid**: deterministic scanners run first, then the LLM triages
their findings and adds its own judgment. This makes the objective findings
reproducible and means a provider error never leaves the PR un-reviewed.

- **Secrets** — [gitleaks](https://github.com/gitleaks/gitleaks) (`RUN_SECRET_SCAN`, default on).
- **SAST** — [Opengrep](https://github.com/opengrep/opengrep) (`RUN_SAST`, default on; rules via `SAST_RULES`).

Both run as steps of this composite action (pinned release binaries) and write SARIF.
Their findings (1) **upload to the repo's Code Scanning tab** — which requires
`security-events: write` in your workflow `permissions` — and (2) are passed to the LLM
as TRUSTED context to assess; confirmed ones appear in the verdict comment tagged with
their tool. A scanner that fails to install or run is non-fatal: the review degrades to
LLM-only. On a **fork PR** (where `security-events: write` and the token are read-only) the
SARIF upload is skipped and the review still posts as a comment.

If the LLM call errors, the comment still shows the deterministic findings under a
**Mechanical checks** section with an "LLM judgment unavailable" note — never a blank verdict.

## How it works

The action runs a shape → review → post pipeline:

**1 — Shape the diff.** Resolves the merge-base (deepening a shallow checkout if
needed), strips noise so the model reviews only human-authored changes, drops
binaries, and line-primes every diff line with its real source line number so
findings anchor to actual lines. The diff runs with rename detection (`-M`), so
a `git mv` appears as a **rename** (`rename from`/`rename to` plus only its real
edits, backed by a `## Renamed Files` manifest) instead of being misread as a
deletion plus a brand-new file. Deleted files are classified from the base
commit, where their content still exists.

The noise filter (each dropped file is reported in the comment) covers:
- **Lockfiles** across ecosystems — `*.lock`, `*-lock.json`, `go.sum`,
  `npm-shrinkwrap.json`, `packages.lock.json`, `Package.resolved`,
  `.terraform.lock.hcl`, `*.gradle.lockfile`, `pnpm-lock.yaml`, `bun.lockb`.
- **Vendored dependency dirs** — `node_modules/`, `vendor/`, `third_party/`,
  `Pods/`, `Carthage/`, `bower_components/`, `.yarn/{releases,plugins,unplugged}/`.
- **Build / output dirs** — `dist/`, `build/`, `out/`, `target/`, `coverage/`,
  `__pycache__/`, `.next/`, `.nuxt/`, `.svelte-kit/`, `.terraform/`, `obj/`, …
  (and `*.pyc`).
- **Generated code** — minified (`*.min.*`), source maps (`*.map`), protobuf/gRPC
  (`*.pb.go`, `*_pb2.py`), graphql-codegen (`__generated__/`, `*.generated.ts`),
  .NET (`*.designer.cs`), Dart (`*.g.dart`, `*.freezed.dart`), JS bundles
  (`*.bundle.js`), plus any file flagged `@generated`/`DO NOT EDIT` by content.
- **Repo-marked generated** — any path with `linguist-generated` in
  `.gitattributes` (the same signal GitHub's diff UI uses).
- **Your own globs** — anything matched by the `EXCLUDE_GLOBS` input.

Migrations (`migrations/`) and snapshot tests (`*.snap`) are **kept** for review
by default — add them to `EXCLUDE_GLOBS` if you'd rather skip them.

**2 — Gather rules.** Reads the repo's own convention files from the base ref and
folds them into the prompt (see [Project conventions](#project-conventions)).

**3 — Review.** Builds the system + user prompt and calls the configured model (the
`PROVIDER` backend — OpenRouter or native DeepSeek) via
the Vercel AI SDK (`generateObject` + a Zod verdict schema) against the full
8-dimension checklist (the 8th, convention adherence, applies only when project
rules were found). Output is structured with automatic retries; reasoning is off.
An empty or unparseable response after retries surfaces an `error` verdict
carrying the finish reason — never a silent null.

**4 — Validate & anchor.** Findings are checked against the diff — hallucinated
line numbers and low-confidence findings are dropped, findings are deduplicated by
`(path, line, end_line, text-fingerprint)` keeping the highest severity, and each
is anchored to a real changed line.

**5 — Post.** A summary verdict comment (machine-readable label for `pr-babysit`),
plus — when `INLINE_COMMENTS` is on — per-line review comments with committable
` ```suggestion ` blocks via the GitHub Reviews API (advisory `COMMENT` event; it
never hard-blocks merge).

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

With `INLINE_COMMENTS: true` (default), findings are posted as inline review comments anchored to the exact file and line. When the model has a concrete, high-confidence fix it attaches a ` ```suggestion ` block you can commit straight from the PR. Anchors are validated against GitHub's own view of the PR diff before posting: a finding GitHub cannot anchor degrades to a **file-level** comment instead of failing the whole batch (the summary comment always carries every finding regardless). Set `INLINE_COMMENTS: false` for a summary-comment-only review.

The verdict comment is compatible with [`parse-verdict.sh`](https://github.com/Falconiere/toolu/blob/main/plugins/pr-babysit/scripts/parse-verdict.sh) and the [`pr-babysit`](https://github.com/Falconiere/toolu/tree/main/plugins/pr-babysit) automation loop, so toolu users can drop this into CI and their existing babysit workflow consumes the verdict without changes. The elements that contract depends on — the `### Code Review` heading, at least one checked `- [x]` box, the `### Findings` block, and the machine-readable label — are present in **both** verbosity modes (below).

## Example verdict

The default **compact** shape — a single checklist line, findings sorted worst-severity-first, and sections omitted when empty:

```markdown
**AI Code Review finished in 2m 15s** —— [View job](https://github.com/...)

### Code Review — `feat/add-login`

- [x] Reviewed 4-file diff — verdict set

**Verdict:** ✅ Approved   🔵 2 low

### Review Plan
Reviewing 4 files: 1 correctness-critical (format.ts), 1 test-quality, 1 config,
1 security-sensitive (login.ts).

### Findings (2)
`src/utils/format.ts:17`: low: Comment says 'Temporary workaround' with no
removal date or tracking issue.
`src/utils/__tests__/format.test.ts:6`: low: Test assertion uses loose suffix
match. Tighten to assert full identity.

`merge-approved`
```

**Comment verbosity.** `VERBOSITY` (default `compact`) controls the comment shape:

- **`compact`** (default) — the checklist collapses to one line, and the review-memory recap lists changed findings as `` `path:line` `` refs (the full text already lives once in `### Findings`).
- **`full`** — restores the five-line static checklist and the inline recap text.

These changes apply in **both** modes, independent of `VERBOSITY`:

- The auto-generated `### Top-N must-fix` section is gone — it was a verbatim duplicate of the (now worst-first-sorted) Findings list. The section renders only when the model supplies an explicit `top_must_fix`.
- `### Review Plan` and `### Other checks` are omitted entirely when the model returns nothing for them (no `_No … provided._` filler).

The verdict label at the bottom is machine-readable: `` `merge-approved` `` or `` `request-changes` ``. `pr-babysit` parses it to decide whether the PR is ready to merge. Unless `MANAGE_LABELS` is `false`, the same verdict is also applied as a real PR **label chip** (the opposite one is removed), so PRs are filterable in the GitHub UI — this needs `issues: write` in the workflow's `permissions` block.

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
- uses: falconiere/toolu-ghactions/code-review@v4
  with:
    API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
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
  security-events: write # upload the gitleaks/opengrep SARIF to the Code Scanning tab

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
      - uses: falconiere/toolu-ghactions/code-review@v4
        with:
          API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
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

## Thread-aware replies

When inline comments are on, a re-review **reads the author's replies** on its own
earlier inline threads instead of blindly re-posting every finding:

- 🗣️ **reads replies** — the author's responses on the bot's prior threads are fed
  back into the model prompt (sanitized, in a delimited **UNTRUSTED** block — claims
  to weigh on merit, never instructions).
- ✅ **accepts** — a finding whose rebuttal the model now agrees with is dropped, and
  its thread is **resolved** (with a short note) rather than raised again.
- 💬 **argues** — a finding the model still stands by is re-stated **as a reply in the
  existing thread** (engaging the author's reasoning), not as a duplicate comment.
- ⤵️ **dedup** — only genuinely new findings open new threads; leftover duplicate
  threads for the same finding are resolved.

Threads are matched to findings by the same line-independent fingerprint used by
[Review memory](#review-memory), carried in a hidden marker on each inline comment.
Only the bot's own threads are touched — human review threads are never modified.
Thread reads/writes are best-effort: a GitHub API hiccup degrades to the previous
"post fresh" behavior and never fails the job.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `PROVIDER` | no | `openrouter` | Backend to call: `openrouter` (any OpenAI-compatible model via OpenRouter) or `deepseek` (native `api.deepseek.com`, lower cost). Any other value fails the action with an error suggesting `PROVIDER: "openrouter"` + `MODEL_ID: "<vendor>/<model>"`. See [Native DeepSeek API](#native-deepseek-api). |
| `MODEL_ID` | no | per-provider | Model id. Defaults to `deepseek/deepseek-v4-pro` for `openrouter` (1M-token context, 384k max output, so large diffs and verbose reviews rarely truncate) and `deepseek-v4-flash` for `deepseek`. Use `<vendor>/<model>` ids for OpenRouter; bare ids for native DeepSeek. Pick one with reliable JSON-schema structured output. |
| `API_KEY` | **yes** | — | API key for the selected `PROVIDER` (OpenRouter or DeepSeek). **Required** — an empty value fails the action. Pass via a step-level `env:`/`secrets` reference for secret hygiene. |
| `MAX_TOKENS` | no | `8192` | Max completion-token budget per request (always sent — omitting it makes OpenRouter reserve the model's full output window against your credits and can 402-reject). A response truncated at this limit (`finish_reason: length`) is retried with a doubled budget up to 32768; if it still truncates, the findings completed before the cut are salvaged. |
| `MIN_CONFIDENCE` | no | `high` | Drop findings below this confidence unless severity is blocker/high (`high` or `medium`) |
| `INLINE_COMMENTS` | no | `true` | Post per-line review comments with committable code suggestions (Reviews API), in addition to the summary comment |
| `MANAGE_LABELS` | no | `true` | Set a real PR label chip matching the verdict (`merge-approved` / `request-changes`) and remove the opposite one. Requires `issues: write`. |
| `FAIL_ON` | no | `changes` | Comma-separated verdicts that **fail the job** (turn this check red so branch protection can block the PR): `changes`, `error`, or both. **Defaults to `changes`** — the job goes red when the bot requests changes. Set `none` to keep the job green on every verdict (advisory only), or `changes,error` to also block when the review could not run (`error`). The comment, label, and outputs are still posted; only the exit code changes. Governs the verdict-driven gate only — a thrown infra error fails the job regardless. **Mark this check Required in branch protection** for the red to actually block a merge. See [Blocking merges](#blocking-merges). |
| `BASE_BRANCH` | no | `main` | Base branch for diff comparison. Falls back to `GITHUB_BASE_REF` if unset. |
| `REVIEW_PROMPT_FILE` | no | *(8-dimension checklist)* | Path to a markdown file (relative to repo root) with a custom review prompt. Overrides the default checklist. Project conventions are still gathered and injected, but a custom prompt supplies its own dimensions. |
| `CODEBASE_OVERVIEW` | no | — | High-level context about the codebase (framework, patterns, architecture) injected into the review prompt. |
| `CHECK_PROJECT_RULES` | no | `true` | Auto-read the repo's own convention files **from the base ref** (`CLAUDE.md`, `AGENTS.md`, `.cursor/rules`, `.cursorrules`, `.windsurfrules`, `.github/copilot-instructions.md`, plus `CONVENTIONS.md` / `CONTRIBUTING.md` / `docs/conventions/`) and review the diff against them via the **Convention adherence** dimension. Set `false` to disable. See [Project conventions](#project-conventions). |
| `RULES_GLOB` | no | — | Extra path globs (relative to repo root, newline- or comma-separated) to include as project rules, e.g. `docs/architecture/**`. Matched against tracked files at the base ref. |
| `EXCLUDE_GLOBS` | no | — | Extra path globs (newline- or comma-separated) to **exclude** from the reviewed diff, on top of the built-in generated/vendored/lockfile set and any `.gitattributes` `linguist-generated` paths, e.g. `migrations/**, **/*.snap`. Excluded files are still committed and CI-checked — only kept out of the LLM review. |
| `RULES_MAX_BYTES` | no | `32768` | Byte cap on the gathered rules. Files are added in priority order until the cap; whole files past it are dropped with a truncation notice. |
| `MAX_FILES` | no | `0` (unlimited) | Maximum changed files (counted **after** generated/vendored/excluded files are dropped) before the action skips. `0` reviews any number of files — the only ceiling is your OpenRouter billing balance. Set a positive value to opt into a hard skip on huge PRs. |
| `MAX_DIFF_LINES` | no | `0` (unlimited) | Maximum diff lines before truncation, applied **before** chunking. `0` reviews the whole diff. Set a positive value to keep the first N lines (lexicographic by file path) and append a truncation notice. |
| `MAX_CHUNK_LINES` | no | `1500` | Per-chunk diff-line budget. When the diff exceeds this, it is split into chunks of **whole files** (≤ this many primed lines each), each reviewed in its own model call and the results merged — so a large PR no longer overwhelms a single call and abstains. Module-coupled files (e.g. a Rust `#[path]`/`mod` parent and its child) always share a chunk, and a single file over the budget rides alone **with its full post-change content attached** as read-only context, so the model never judges a construct from a truncated view. A chunk whose call fails is retried once; if it still fails the merged verdict is marked **incomplete** (never a confident approval over unreviewed files). `0` disables chunking (always one call). |
| `MAX_CHUNKS` | no | `20` | Maximum chunks (= model calls) per review, bounding cost and wall-clock on very large PRs. Files beyond the limit are not reviewed and the comment says so. `0` = unlimited. |
| `REQUEST_TIMEOUT_MS` | no | `180000` (3 min) | Per-attempt model deadline in milliseconds. Each chunk gets up to this long per attempt (retried a few times) before it is aborted and the chunk abstains (`This operation was aborted`). Raise it for slow/large models, lower it to fail faster. A non-positive value falls back to the default. |
| `TOKEN` | no | `${{ github.token }}` | GitHub token for posting and editing comments. |
| `APP_ID` | no | — | GitHub App id. Set together with `APP_PRIVATE_KEY` to post as a custom-branded App (`Toolu — Code Review`) instead of `github-actions[bot]`. Both must be set or the action falls back to the default identity. See [Custom identity](#custom-identity-github-app). |
| `APP_PRIVATE_KEY` | no | — | GitHub App private key — raw PEM **or** base64-encoded PEM (auto-decoded). Pair with `APP_ID`. Pass via a secret; never inline. Used only to mint a short-lived installation token — never logged. |
| `TRIGGER_PHRASE` | no | `@toolu` | Mention prefix that re-triggers a review from a PR comment, e.g. `@toolu review focus on auth`. Requires the workflow to also listen on `issue_comment`. See [@mention re-trigger](#mention-re-trigger). |
| `MIN_TRIGGER_PERMISSION` | no | `write` | Minimum repo permission a commenter needs to trigger a review via `@mention`: `write` or `admin`. The check fails closed (denied on any error). |
| `BOT_NAME` | no | `Toolu — Code Review` | Display name shown in the comment body header. |
| `BOT_LOGO_URL` | no | `…/code-review/assets/logo.png` | Logo image shown in the comment body header. |
| `REVIEW_MEMORY` | no | `true` | Recap what changed since the last review (resolved / still-open / new) and keep a collapsed history, using a hidden state marker in the sticky comment. Set `false` to disable. See [Review memory](#review-memory). |
| `VERBOSITY` | no | `compact` | Verdict-comment shape: `compact` (default) collapses the checklist to one line and renders recap buckets as `path:line` refs; `full` restores the multi-line checklist and inline recap text. Findings, the `### Findings` heading, and the state marker are identical in both. An unrecognized value warns and falls back to `compact`. See [Example verdict](#example-verdict). |
| `RUN_SECRET_SCAN` | no | `true` | Run the deterministic secret scan (gitleaks) before the LLM review; its findings feed the LLM as triage context and upload to Code Scanning. See [Deterministic checks](#deterministic-checks). |
| `RUN_SAST` | no | `true` | Run the deterministic SAST pass (Opengrep) before the LLM review; same flow as above. |
| `SAST_RULES` | no | `p/typescript` | Opengrep rule config(s) for the SAST pass (comma-separated). |

### Removed in v4

These inputs were **removed** in v4 (breaking change) — they no longer exist on
the action. See [Removed in v4 (migration)](#removed-in-v4-migration) for the full
mapping.

| Removed input | Replacement |
|---|---|
| `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY` | `API_KEY` |
| `MODEL` | `MODEL_ID` |
| `PROVIDERS` | `PROVIDER` + `MODEL_ID` + `API_KEY` (single model only) |
| `MERGE_STRATEGY`, `FALLBACK_MODEL`, `REVIEW_MODE`, `ENFORCE_JSON_SCHEMA` | removed — one model, schema always enforced |

## Outputs

| Output | Description |
|---|---|
| `verdict` | `approved`, `changes`, `error`, or `skip` |
| `findings-count` | Number of findings reported |
| `comment-url` | URL of the posted verdict comment |

Use outputs in downstream workflow steps. Note that once the action **fails** the job (see [Blocking merges](#blocking-merges)), later steps that read these outputs need `if: always()` to run at all:

```yaml
- uses: falconiere/toolu-ghactions/code-review@v4
  id: review
  with:
    API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
- if: always() && steps.review.outputs.verdict == 'changes'
  run: echo "PR needs work — ${{ steps.review.outputs.findings-count }} findings"
```

## Blocking merges

By default (`FAIL_ON: changes`) the action **fails its own job** when the bot's verdict is `changes` — the check turns red, the verdict comment and label are still posted. To make that red check actually **block a merge**, mark this action's check as a **required status check** in the repository's branch-protection rules (Settings → Branches). Without that, the red check is visible but advisory.

- `FAIL_ON: changes` (default) — block when the bot requests changes.
- `FAIL_ON: changes,error` — also block when the review could not run (provider error/timeout). Safer, but a transient failure reds the check until re-run.
- `FAIL_ON: none` — never fail on a verdict; the review stays purely advisory (the pre-4.x behavior). You can still gate yourself with `if: steps.review.outputs.verdict == 'changes'`.

The gate governs the verdict only; a thrown infra error fails the job regardless of `FAIL_ON`. A `skip` (non-trigger event) never blocks.

## Packaging (v2)

v2 is a **TypeScript node24 JavaScript action** — `runs: node24`, `main: dist/index.cjs`,
a `dist/` bundle committed to the repo. It was rewritten from the previous
Dockerized bash action; there is **no Docker image** anymore.

- **Breaking packaging change, no contract change.** Every `action.yml` input and
  output name and default is preserved, so an existing `@v2` workflow keeps
  working untouched — only the way the action runs changed.
- **Fixes land on merge.** Because consumers run the checked-out ref directly
  (no image to rebuild and re-push to a registry), a fix reaches `@v2` the moment
  it merges — no release required.
- **Single model, two backends.** The 6-vendor parallel ensemble was dropped in
  favor of one model — via OpenRouter or the native DeepSeek API, selected with
  `PROVIDER` — through the Vercel AI SDK. The old ensemble inputs (`PROVIDERS`,
  `MERGE_STRATEGY`, `FALLBACK_MODEL`, `REVIEW_MODE`, `ENFORCE_JSON_SCHEMA`) and the
  split key/model inputs (`OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `MODEL`) were
  [removed in v4](#removed-in-v4-migration).

## Development

TypeScript bundled to `dist/index.cjs`; the dev loop runs on [bun](https://bun.sh). See [CONTRIBUTING](../CONTRIBUTING.md) for the full guide.

```bash
cd code-review
bun install        # deps + git hooks (lefthook)
bun run check      # typecheck + lint (oxlint, type-aware) + fmt:check (oxfmt) + test (vitest)
bun run build      # esbuild → dist/index.cjs (commit it; CI fails if it drifts from src)
```

## License

MIT — see [LICENSE](../LICENSE).
