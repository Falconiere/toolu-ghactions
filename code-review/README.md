<div align="center">

# 🔍 code-review

### AI code review for every pull request

Audits the diff against an 8-dimension checklist — correctness, security, performance, test coverage, doc accuracy, tight assertions, migration warnings, and adherence to the project's own convention files — by running **one model** through either [OpenRouter](https://openrouter.ai) (any OpenAI-compatible model id) or a vendor's **native API** — DeepSeek (`api.deepseek.com`), MiniMax (`api.minimax.io`) or Kimi / Moonshot AI (`api.moonshot.ai`) — selected with a single `PROVIDER` input, via the **[Vercel AI SDK](https://sdk.vercel.ai)** (`generateObject` + Zod: structured output with retries, reasoning disabled). Posts a structured, machine-readable comment with inline, committable suggestions.

[![Release](https://img.shields.io/github/v/release/Falconiere/toolu-ghactions?sort=semver&color=d97757)](https://github.com/Falconiere/toolu-ghactions/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](../LICENSE)
[![Tests](https://img.shields.io/badge/tests-vitest-3fb950)](https://github.com/Falconiere/toolu-ghactions/actions/workflows/tests.yml)

[Quick start](#quick-start) · [Choosing a model](#choosing-a-model) · [How it works](#how-it-works) · [Example verdict](#example-verdict) · [Coverage ledger](#coverage-ledger) · [Finding clustering](#finding-clustering) · [Custom identity](#custom-identity-github-app) · [@mention re-trigger](#mention-re-trigger) · [Review memory](#review-memory) · [Inputs](#inputs) · [Outputs](#outputs) · [v7 migration](#v7-migration)

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

- **`PROVIDER`** — `openrouter` (default), or a vendor's native API billed to that
  vendor's own key: `deepseek`, `minimax`, or `kimi` (`moonshot` is accepted as an alias).
- **`MODEL_ID`** — the model id (per-provider default if omitted).
- **`API_KEY`** — the provider API key (**required**).

By default it is resolved through OpenRouter; you can also point it at a **native
vendor API** (see below). Anything OpenRouter serves works as long as it's
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
`deepseek-v4-flash` (fast, 1M context) when omitted. `API_KEY` is your
DeepSeek key — here `${{ secrets.DEEPSEEK_API_KEY }}` is just the name of *your*
GitHub repo secret, passed into the single `API_KEY` input.

### Native MiniMax API

To bill the review to your MiniMax key, set `PROVIDER: minimax` and a **native**
MiniMax model id:

```yaml
- uses: falconiere/toolu-ghactions/code-review@v7
  with:
    PROVIDER: minimax
    MODEL_ID: MiniMax-M3            # default; also MiniMax-M2.7, MiniMax-M2.5, …
    API_KEY: ${{ secrets.MINIMAX_API_KEY }}
```

`PROVIDER: minimax` hits `api.minimax.io` directly. `MODEL_ID` defaults to
`MiniMax-M3` (1M context, the `deepseek-v4-flash` price tier) when omitted. The
action sends `thinking: {type: "disabled"}`, which `MiniMax-M3` honours; the M2.x ids
think on every call regardless, so their reasoning is billed against `MAX_TOKENS` —
the action keeps it out of the JSON (`reasoning_split`) and retries a response that
ran out of budget before any JSON started at the doubled budget, but a larger
`MAX_TOKENS` is the cheaper fix if you pick one. MiniMax silently ignores
`response_format`, so the verdict schema reaches the model through the prompt alone.

### Native Kimi (Moonshot AI) API

To bill the review to your Kimi key, set `PROVIDER: kimi` (or `moonshot`) and a
**native** Kimi model id:

```yaml
- uses: falconiere/toolu-ghactions/code-review@v7
  with:
    PROVIDER: kimi
    MODEL_ID: kimi-k2.7-code        # default; also kimi-k3, kimi-k2.6, kimi-k2.7-code-highspeed
    API_KEY: ${{ secrets.KIMI_API_KEY }}
```

`PROVIDER: kimi` hits `api.moonshot.ai` directly (the host did not change with the
`platform.kimi.ai` rebrand). `MODEL_ID` defaults to `kimi-k2.7-code` (262K context,
the code-specialised model with Kimi's most stable structured output) when omitted;
`kimi-k3` is the 1M-context flagship at roughly 4x the price. Two Kimi-specific
behaviours: the current models reject any explicit sampling value, so the action
sends no `temperature` to Kimi (the vendor default applies), and they reason on
every call with no way to switch it off, so the reasoning is billed against
`MAX_TOKENS` — a response that ran out of budget before any JSON started is retried
at the doubled budget, and a larger `MAX_TOKENS` is the cheaper fix on big chunks.

Only `openrouter` (default), `deepseek`, `minimax` and `kimi` are implemented; any
other `PROVIDER` value fails the action with an error that points you at routing it
through OpenRouter instead (`PROVIDER: "openrouter"`, `MODEL_ID: "<vendor>/<model>"`).

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
`PROVIDER` backend — OpenRouter or a native vendor API) via
the Vercel AI SDK (`generateObject` + a Zod verdict schema) against the full
8-dimension checklist (the 8th, convention adherence, applies only when project
rules were found). Output is structured with automatic retries; reasoning is off on
every backend that has a switch (`reasoning: {effort: "none"}` on OpenRouter,
`thinking: {type: "disabled"}` on native DeepSeek and MiniMax) — it is billed against
`MAX_TOKENS`, so a thinking model spends the budget before emitting any JSON. Kimi's
current models have no switch, so there (and on MiniMax's M2.x ids) a response that
ran out of budget before any JSON started is retried at the doubled budget instead.

A response the schema rejects is not thrown away on sight: the findings completed
before a truncation cut are salvaged, and a complete response that merely deviates
(`"request_changes"` for the verdict, a quoted line number, `"CRITICAL"` for a
severity) is normalized back onto the schema. Normalization never invents a value —
whatever is still invalid is dropped per-finding and the review is marked partial.
A partial review surfaces in the verdict comment as a "⚠️ **Partial review**" note
under the verdict saying what was lost — the "Provider error" wording (and the
"LLM judgment unavailable" note) is reserved for a review where the LLM delivered
no judgment at all.
When nothing trustworthy survives, an empty or unparseable response surfaces an
`error` verdict carrying the finish reason — never a silent null, and never a clean
review over findings that had to be dropped.

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

What it reads, in priority order, **from the base ref** by default (never the PR
head — see `RULES_REF` below for the trusted-repo opt-out):

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

One deliberate consequence of base-ref reading: a same-repo PR that *legitimately
updates* a convention file is still reviewed against the stale base-ref text, so the
reviewer can keep re-raising "violations" of the very rules the PR changes. If your
PR authors are already trusted — same-repo branches, protected by required review —
set `RULES_REF: merge` to read the convention files from the checked-out PR merge
ref instead, so a PR's own convention updates apply to its own review:

```yaml
with:
  RULES_REF: merge # trusted same-repo PRs only — a PR can then modify its own review rules
```

The trade-off is explicit: `merge` gives up the injection guarantee above, so never
enable it on repos that accept fork PRs. Everything else (priority order,
`RULES_GLOB`, `RULES_MAX_BYTES`) behaves identically; an unrecognized value warns
and falls back to `base`.

### Convergence: settled threads & the round cap

A generative reviewer re-derives its findings from the diff on every push, so left alone it can produce a *fresh* batch each round — reworded text (new fingerprint), drifted line anchors, findings wandering into untouched files — and a PR can accumulate dozens of findings without ever reaching the zero-findings verdict. Two mechanisms make the review converge:

- **Settled threads suppress re-raises (always on).** A human resolving one of the bot's inline threads is a decision — and so is [dismissing it in a reply](#dismissing-a-finding-without-resolving-the-thread), either with `@toolu dismiss` or by holding your position after the bot's one rebuttal. A finding covered by a settled thread is dropped everywhere — verdict count, summary comment, inline posting. Coverage is deliberately wider than an exact match: same fingerprint, same `path:line`, same path within **10 lines** (a reworded finding drifts), or — when the settled thread has gone outdated after a push (GitHub detaches its line) — same path and same finding category. **Blocker-severity findings only ever match exactly**, so the loosening can never hide a genuine showstopper, and an *argued-out* thread never suppresses a blocker at all.
- **`MAX_ROUNDS` surrender (opt-in).** Set `MAX_ROUNDS: 5` and the fifth review round (counted from the `REVIEW_MEMORY` history) that would still say `changes` with **only sub-blocker findings** is downgraded to `approved`: the findings stay listed as advisory, the comment carries an explicit `🔁 Round cap` callout, and `FAIL_ON` stops failing the job. One blocker finding disables the cap for that round. `0` (default) keeps the old block-forever behavior.

### Inline comments & suggestions

With `INLINE_COMMENTS: true` (default), findings are posted as inline review comments anchored to the exact file and line, batched at up to 30 comments per `createReview` call. When the model has a concrete, high-confidence fix it attaches a ` ```suggestion ` block you can commit straight from the PR. Anchors are validated against GitHub's own view of the PR diff before posting: a finding on a file GitHub's own diff omits (or whose line can't be mapped onto it) is **never** posted inline — GitHub's Reviews API rejects the whole `createReview` call outright if it contains even one such comment, so there is no file-level fallback. It is instead rendered in the sticky comment's [`### Unanchored findings`](#coverage-ledger) section, so it is never silently lost. If a batch still fails after anchor validation (a comment GitHub's API rejects for a reason we couldn't predict up front), the batch is bisected to isolate the poison comment — every other comment in the batch still posts, and the isolated one is rendered in the sticky comment's [`### Findings GitHub rejected inline`](#coverage-ledger) section, so one bad comment can no longer zero out the whole review or silently drop a finding. Set `INLINE_COMMENTS: false` for a summary-comment-only review.

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

## Coverage ledger

Every review posts a **coverage ledger**, so a large PR can never silently lose files the way a flat "1 of 9 chunks failed" note used to — the sticky comment always accounts for every changed path by name when something needs your attention. It renders as its own `### Coverage` section: a one-line summary of counts per status is always present, plus per-path rows for the statuses below that must stay visible, capped at 50 rows (a "… N more" line covers the rest).

| Status | Meaning |
|---|---|
| `reviewed` | The model read this file's diff and returned a verdict for it. |
| `pattern` | This file's change is byte-identical (once normalized) to the same change in 3+ other files — only the group's **exemplar** was actually sent to a model call; a finding on the exemplar applies to every member. See [Finding clustering](#finding-clustering). |
| `rename` | An exact or near-exact rename with no content of its own to review. |
| `formatting` | A whitespace-only change (empty diff under `git diff -w`). |
| `vendored` / `generated` | Excluded via a `linguist-vendored`/`linguist-generated` attribute in `.gitattributes` — a repo-declared exclusion, distinct from the built-in noise filter below. |
| `excluded` | Dropped by the [noise filter](#how-it-works) or binary detection before diffing; a `reason` names why (`lockfile`, `build-output`, `large-file`, `minified`, `generated`, `binary`, …). |
| `carried` | Out of this round's [incremental scope](#review-memory) (or a cluster member whose exemplar wasn't re-examined) — not re-reviewed this round, so its prior finding rides forward unchanged rather than being silently dropped or falsely reported fixed. |
| `unreviewed` | Attempted and failed — a schema failure that survived bisection, a file past a set `MAX_CHUNKS` cap, or (rare) a path no layer accounted for at all. |
| `pending` | Not yet attempted because `MAX_WALL_MS` ran out this run — resumable, see [`@toolu resume`](#toolu-resume-resuming-a-paused-run). |

**Any `unreviewed` or `pending` entry degrades a would-be `approved` verdict to `error`** — the same fail-safe rule the reviewer has always applied to a failed chunk, now driven by the ledger: an approval can't honestly claim to cover code nobody read.

Findings that can't reach an inline comment are never silently lost either — they render in two companion sections, each capped the same way: `### Unanchored findings` (files GitHub's own diff omits, or whose line can't be mapped onto it) and `### Findings GitHub rejected inline` (a comment isolated by 422-bisection that still failed on its own). See [Inline comments & suggestions](#inline-comments--suggestions).

The ledger section is itself droppable under GitHub's 65 KB comment-size ceiling, but last: an oversized comment first drops the per-path exception rows (keeping the one-line summary), then drops the whole `### Coverage` section, and only *then* starts trimming findings, worst-severity-last. Coverage accounting is the last thing to go, not the first.

## Finding clustering

A defect that repeats identically across many files — the same convention violation copy-pasted, the same missing check after a mechanical refactor — used to post one inline comment per file, sometimes hundreds on a large PR. Findings sharing the same category and near-identical text across **3 or more files** now collapse into one **cluster**: one inline comment, posted on an exemplar file, whose body enumerates every other file carrying the same finding. Smaller repeats (1–2 files) stay individual comments, as before.

The sticky comment's `### Repeated findings` section lists every multi-member cluster the same way — the exemplar's finding, the member count, and the full member-path list — and says explicitly: **dismissing or resolving the exemplar's thread dismisses the whole pattern**, member findings included. That's deliberate, not a quirk of the implementation: every member still keeps its own individual fingerprint internally (nothing is merged for tracking purposes — the underlying finding count in the marker and in [Review memory](#review-memory)'s recap is the true count), so a later push that fixes only *some* members re-splits the cluster and reopens a thread under whichever exemplar is still valid.

Across rounds, cluster identity is pinned: the same exemplar's thread is reused while that finding is still present. If the exemplar gets fixed but other members remain, the thread stays **open** under a newly promoted exemplar (the lowest surviving member) with a reply explaining the handoff — a cluster's thread resolves only once **every** member is gone.

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
  `review` (or `TRIGGER_PHRASE` + `resume`, below) are ignored **before** any
  permission API call (no noise).
- The trailing text (`focus on …`) is treated as an **untrusted focus hint**: it
  is sanitized and injected into the user prompt inside a delimited UNTRUSTED
  block as a hint about *where* to look — **never** as instructions, and it
  cannot change the task, output schema, or verdict rules.
- An allowed trigger reacts 👀 on the comment; a denied one reacts 👎.
- A scoped/steered review (`@toolu review focus on …`) does **not** recompute
  "resolved" — see [Review memory](#review-memory).

### `@toolu resume`: resuming a paused run

When `MAX_WALL_MS` cuts a run short mid-review, the sticky comment says so, and the round is left resumable: the marker records which files were attempted-and-failed (`unreviewed`) and which were never reached (`pending`) without touching `reviewed_tree`, so nothing yet reviewed counts as done. Three things resume it, and all three review **only the exception paths** — never the whole diff again:

- any subsequent push to the PR (its own new/changed lines join the exception paths automatically — see [Review memory](#review-memory));
- a workflow re-run of the same event;
- the `@toolu resume` comment, behind the **same permission gate** as `@toolu review`:

```
@toolu resume
```

`@toolu resume` never re-reviews files that already reached complete coverage, and never clears memory or `reviewed_tree`. Contrast with `@toolu review`, which is still a **full** re-review — it clears `reviewed_tree` and both exception lists and starts over. If there is nothing left to resume (no exception paths recorded — e.g. a run that never actually paused), `@toolu resume` falls back to a full review rather than silently doing nothing.

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
- 🔒 **respects resolutions** — **resolving a bot thread dismisses that finding**:
  on later runs it is dropped from the verdict count, the summary comment, and
  inline posting alike, instead of being re-litigated forever. When every
  remaining finding was human-resolved, a `request-changes` verdict downgrades to
  `merge-approved`. This works even with `INLINE_COMMENTS: false` (threads from
  earlier inline-enabled runs still suppress). Resolved threads are also fed to
  the model as a **dismissed-findings block** ("settled — do not re-raise, not
  even reworded"), so a rephrased variant of a dismissed finding — which gets a
  new fingerprint and often a new line — is suppressed at the source instead of
  slipping past the deterministic match.

### Dismissing a finding without resolving the thread

Resolving a thread used to be the *only* way to settle a finding, so an author who
**refused or explained a finding in a reply** got it raised again on every run. Two
more channels close that:

- 🙅 **`@toolu dismiss`** — reply to the bot's thread with the trigger phrase plus
  `dismiss` (any explanation may follow: `@toolu dismiss — intentional, see ADR-12`).
  The finding is settled exactly as if you had resolved the thread: dropped from the
  verdict, the comment, and inline posting, fed to the model as dismissed, and the
  thread is closed with a note. A deliberate ruling, so it silences **any** severity —
  including a `blocker` — but only on an exact match, never on a reworded variant
  nearby. The phrase follows `TRIGGER_PHRASE`, and a command inside quoted text — a `>`
  blockquote, a fenced block, or an inline `` `code span` `` — is ignored, so showing the
  syntax while arguing the opposite never fires it.
- 🤝 **argued out** — if the bot already answered your reply and you hold your position,
  the disagreement is settled automatically: the finding is suppressed and the thread
  closed with a standing-disagreement note rather than a repeat of the same rebuttal.
  You always get the bot's one rebuttal first — your *first* reply is not a dismissal.
  This is the reviewer conceding an argument, not a ruling on the finding, so it never
  silences a `blocker` (the same rule [`MAX_ROUNDS`](#convergence-settled-threads--the-round-cap)
  follows).

Both are gated on the **same repo permission** as the `@mention` re-trigger
(`MIN_TRIGGER_PERMISSION`, default `write`) and **fail closed** — an unprivileged
commenter cannot silence the reviewer, and a failing permissions API leaves the finding
standing. That matches GitHub's own model: resolving a thread already requires write or
triage access.

Threads are matched to findings by the same line-independent fingerprint used by
[Review memory](#review-memory), carried in a hidden marker on each inline comment.
Only the bot's own threads are touched — human review threads are never modified.
Thread reads/writes are best-effort: a GitHub API hiccup degrades to the previous
"post fresh" behavior and never fails the job. If the bot's
`Re-reviewed — this no longer applies (addressed, or point taken). Resolving.`
reply lands but GitHub's separate resolve mutation fails, that exact bot-authored
note acts as a durable marker: the next run suppresses the finding and retries the
resolution without posting the note again.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `PROVIDER` | no | `openrouter` | Backend to call: `openrouter` (any OpenAI-compatible model via OpenRouter), or a vendor's native API billed to that vendor's key — `deepseek` (`api.deepseek.com`), `minimax` (`api.minimax.io`), or `kimi` (Moonshot AI, `api.moonshot.ai`; `moonshot` is accepted as an alias). Any other value fails the action with an error suggesting `PROVIDER: "openrouter"` + `MODEL_ID: "<vendor>/<model>"`. See [Native DeepSeek API](#native-deepseek-api), [Native MiniMax API](#native-minimax-api), [Native Kimi API](#native-kimi-moonshot-ai-api). |
| `MODEL_ID` | no | per-provider | Model id. Defaults to `deepseek/deepseek-v4-pro` for `openrouter` (1M-token context, 384k max output, so large diffs and verbose reviews rarely truncate), `deepseek-v4-flash` for `deepseek`, `MiniMax-M3` for `minimax`, and `kimi-k2.7-code` for `kimi`. Use `<vendor>/<model>` ids for OpenRouter; bare native ids for the native providers. Pick one with reliable JSON structured output. |
| `API_KEY` | **yes** | — | API key for the selected `PROVIDER` (OpenRouter, DeepSeek, MiniMax, or Kimi). **Required** — an empty value fails the action. Pass via a step-level `env:`/`secrets` reference for secret hygiene. |
| `MAX_TOKENS` | no | `8192` | Max completion-token budget per request (always sent — omitting it makes OpenRouter reserve the model's full output window against your credits and can 402-reject). A response truncated at this limit (`finish_reason: length`) is retried with a doubled budget up to the 131072 ceiling (escalations don't consume hang retries); whatever the outcome, the findings completed before a cut are salvaged. |
| `MIN_CONFIDENCE` | no | `high` | Drop findings below this confidence unless severity is blocker/high (`high` or `medium`) |
| `INLINE_COMMENTS` | no | `true` | Post per-line review comments with committable code suggestions (Reviews API), in addition to the summary comment |
| `MANAGE_LABELS` | no | `true` | Set a real PR label chip matching the verdict (`merge-approved` / `request-changes`) and remove the opposite one. Requires `issues: write`. |
| `FAIL_ON` | no | `changes` | Comma-separated verdicts that **fail the job** (turn this check red so branch protection can block the PR): `changes`, `error`, or both. **Defaults to `changes`** — the job goes red when the bot requests changes. Set `none` to keep the job green on every verdict (advisory only), or `changes,error` to also block when the review could not run (`error`). The comment, label, and outputs are still posted; only the exit code changes. Governs the verdict-driven gate only — a thrown infra error fails the job regardless. **Mark this check Required in branch protection** for the red to actually block a merge. See [Blocking merges](#blocking-merges). |
| `BASE_BRANCH` | no | `main` | Base branch for diff comparison. Falls back to `GITHUB_BASE_REF` if unset. |
| `REVIEW_PROMPT_FILE` | no | *(8-dimension checklist)* | Path to a markdown file (relative to repo root) with a custom review prompt. Overrides the default checklist. Project conventions are still gathered and injected, but a custom prompt supplies its own dimensions. |
| `CODEBASE_OVERVIEW` | no | — | High-level context about the codebase (framework, patterns, architecture) injected into the review prompt. |
| `CHECK_PROJECT_RULES` | no | `true` | Auto-read the repo's own convention files **from the base ref** (`CLAUDE.md`, `AGENTS.md`, `.cursor/rules`, `.cursorrules`, `.windsurfrules`, `.github/copilot-instructions.md`, plus `CONVENTIONS.md` / `CONTRIBUTING.md` / `docs/conventions/`) and review the diff against them via the **Convention adherence** dimension. Set `false` to disable. See [Project conventions](#project-conventions). |
| `RULES_GLOB` | no | — | Extra path globs (relative to repo root, newline- or comma-separated) to include as project rules, e.g. `docs/architecture/**`. Matched against tracked files at the rules ref (see `RULES_REF`). |
| `RULES_REF` | no | `base` | Which ref the convention files are read from. `base` (default) reads the base-branch tip — injection-safe: a PR cannot change the rules it is reviewed against. `merge` reads the checked-out PR merge ref instead, so a same-repo PR that legitimately updates a convention is reviewed against its own text — **only enable it where PR authors are already trusted** (same-repo branches, protected by required review); it lets a PR modify its own review rules, so never use it on repos accepting fork PRs. An unrecognized value warns and falls back to `base`. See [Project conventions](#project-conventions). |
| `EXCLUDE_GLOBS` | no | — | Extra path globs (newline- or comma-separated) to **exclude** from the reviewed diff, on top of the built-in generated/vendored/lockfile set and any `.gitattributes` `linguist-generated` paths, e.g. `migrations/**, **/*.snap`. Excluded files are still committed and CI-checked — only kept out of the LLM review. |
| `RULES_MAX_BYTES` | no | `32768` | Byte cap on the gathered rules. Files are added in priority order until the cap; whole files past it are dropped with a truncation notice. |
| `MAX_FILES` | no | `0` (unlimited) | Maximum changed files (counted **after** generated/vendored/excluded files are dropped) before the action skips. `0` reviews any number of files — the only ceiling is your OpenRouter billing balance. Set a positive value to opt into a hard skip on huge PRs. |
| `MAX_DIFF_LINES` | no | `0` (unlimited) | Maximum diff lines before truncation, applied **before** chunking. `0` reviews the whole diff. Set a positive value to keep the first N lines (lexicographic by file path) and append a truncation notice. |
| `MAX_CHUNK_LINES` | no | `1500` | Per-chunk diff-line budget, applied to the diff **after** [distillation](#how-it-works) has collapsed mechanical repeats/renames/formatting away. When the remaining diff exceeds this, it is split into packages of **whole files** (≤ this many primed lines each), each reviewed in its own model call and the results merged — so a large PR no longer overwhelms a single call and abstains. Module-coupled files (e.g. a Rust `#[path]`/`mod` parent and its child) always share a package, and a single file over the budget rides alone **with its full post-change content attached** as read-only context, so the model never judges a construct from a truncated view. A package whose call fails to produce valid structured output is split and retried in bisecting halves (up to 4 leaves) to isolate just the file(s) actually at fault, instead of writing off the whole package; a leaf that still fails is recorded `unreviewed` in the [coverage ledger](#coverage-ledger) (never a confident approval over unreviewed files). `0` disables chunking (always one call). |
| `MAX_CHUNKS` | no | `0` | Maximum chunks (= model calls) per review, bounding cost and wall-clock on very large PRs. **`0` (default, changed from `20` prior to `@v7` — see [v7 migration](#v7-migration)) = unlimited.** When set, files beyond the cap are recorded **per-file** as `unreviewed` in the [coverage ledger](#coverage-ledger), which also degrades a would-be `approved` verdict to `error`; the `### Other checks` section of the summary comment also carries a short notice naming them, on top of (not instead of) the per-file ledger rows. |
| `MAX_WALL_MS` | no | `0` | Soft wall-clock budget, in milliseconds, for the whole review loop. `0` (default) = off, never interrupts a run. When set and exceeded mid-run, packages not yet started are recorded `pending` in the [coverage ledger](#coverage-ledger) instead of being attempted, `reviewed_tree` does **not** advance, and the round becomes resumable — via [`@toolu resume`](#toolu-resume-resuming-a-paused-run), a plain workflow re-run, or automatically on the PR's next push. Checked before every package and before every bisection split; a call already in flight always finishes. |
| `REQUEST_TIMEOUT_MS` | no | `180000` (3 min) | Per-attempt model deadline in milliseconds. Each chunk gets up to this long per attempt (retried a few times) before it is aborted and the chunk abstains (`This operation was aborted`). Raise it for slow/large models, lower it to fail faster. A non-positive value falls back to the default. |
| `TOKEN` | no | `${{ github.token }}` | GitHub token for posting and editing comments. |
| `APP_ID` | no | — | GitHub App id. Set together with `APP_PRIVATE_KEY` to post as a custom-branded App (`Toolu — Code Review`) instead of `github-actions[bot]`. Both must be set or the action falls back to the default identity. See [Custom identity](#custom-identity-github-app). |
| `APP_PRIVATE_KEY` | no | — | GitHub App private key — raw PEM **or** base64-encoded PEM (auto-decoded). Pair with `APP_ID`. Pass via a secret; never inline. Used only to mint a short-lived installation token — never logged. |
| `TRIGGER_PHRASE` | no | `@toolu` | Mention prefix for the bot's two comment commands: `@toolu review [focus on …]` re-triggers a review (requires the workflow to also listen on `issue_comment` — see [@mention re-trigger](#mention-re-trigger)), and `@toolu dismiss` in a reply on one of the bot's inline threads settles that finding (see [Dismissing a finding](#dismissing-a-finding-without-resolving-the-thread)). |
| `MIN_TRIGGER_PERMISSION` | no | `write` | Minimum repo permission a commenter needs to trigger a review via `@mention` **or** dismiss a finding on a bot thread: `write` or `admin`. The check fails closed (denied on any error). |
| `BOT_NAME` | no | `Toolu — Code Review` | Display name shown in the comment body header. |
| `BOT_LOGO_URL` | no | `…/code-review/assets/logo.png` | Logo image shown in the comment body header. |
| `REVIEW_MEMORY` | no | `true` | Recap what changed since the last review (resolved / still-open / new) and keep a collapsed history, using a hidden state marker in the sticky comment. Set `false` to disable. See [Review memory](#review-memory). |
| `VERBOSITY` | no | `compact` | Verdict-comment shape: `compact` (default) collapses the checklist to one line and renders recap buckets as `path:line` refs; `full` restores the multi-line checklist and inline recap text. Findings, the `### Findings` heading, and the state marker are identical in both. An unrecognized value warns and falls back to `compact`. See [Example verdict](#example-verdict). |
| `RUN_SECRET_SCAN` | no | `true` | Run the deterministic secret scan (gitleaks) before the LLM review; its findings feed the LLM as triage context and upload to Code Scanning. See [Deterministic checks](#deterministic-checks). |
| `RUN_SAST` | no | `true` | Run the deterministic SAST pass (Opengrep) before the LLM review; same flow as above. |
| `SAST_RULES` | no | `p/typescript` | Opengrep rule config(s) for the SAST pass (comma-separated). |
| `TOOLU_API_KEY` | no | `` | toolu.sh org API token (`toolu_…`) enabling review-run reporting to the platform. Empty (default) disables reporting. Only finding metadata is sent — never code, text, suggestions, or quoted lines. Requires `INLINE_COMMENTS: true`. See [Platform reporting](#platform-reporting). |
| `TOOLU_API_URL` | no | `https://api.toolu.sh` | Base URL of the toolu.sh API. Override only for a self-hosted platform. |


### Platform reporting (optional)

When `TOOLU_API_KEY` is set, the action reports each review run to the toolu.sh platform so findings and verdicts are aggregated for metrics and history — metrics that would otherwise be lost when the PR closes. Reporting is opt-in (empty by default).

**Metadata only.** Only finding metadata is sent: fingerprint, file path, line, severity, category, and provenance (the source tool: `llm`, `gitleaks`, `opengrep`, or `eslint`). The verdict and run timing are included. **Never** sent: the finding text, the quoted source line, code suggestions, or any code of any kind. The console links back to the GitHub comment for the full finding prose.

**Requires inline comments.** Reporting is skipped when `INLINE_COMMENTS` is false — the action only reports findings that appear in inline threads, and without inline comments, no threads are posted. In that case, every persisting finding would look new on every push, making reconciliation impossible. A warning is logged when reporting is skipped.

**Best-effort.** Reporting never fails the job. A non-2xx response, timeout, or network error produces a warning and nothing else. One attempt, no retry.

**Fork PRs.** Runs from fork PRs are never reported — GitHub withholds secrets from fork runs, so `TOOLU_API_KEY` is empty there.

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

## v7 migration

`@v7` ships the size-proof review pipeline described throughout this README — deterministic diff distillation (renames/formatting/mechanical repeats collapsed before any model call) → a small intent-brief call → bounded per-package reviewers with schema bisection → a deterministic reducer (carry-forward, clustering, publish hardening). No input is **removed**, but defaults and comment shapes change, so it ships as a new major tag rather than a silent behavior flip:

| What changed | Detail |
|---|---|
| `MAX_CHUNKS` default | `20` → `0` (unlimited). Files beyond an explicitly-set cap are now recorded per-file `unreviewed` in the [coverage ledger](#coverage-ledger) — the summary's `### Other checks` notice is still posted alongside those per-file rows, not instead of them. |
| Comment shape | The sticky comment gains four new sections — `### Coverage`, `### Repeated findings`, `### Unanchored findings`, `### Findings GitHub rejected inline` — see [Coverage ledger](#coverage-ledger), [Finding clustering](#finding-clustering), and [Inline comments & suggestions](#inline-comments--suggestions). |
| Prompt bytes | The user prompt's block order changed (the shared prefix — system, codebase overview, project rules, brief, prior threads — now extends further before the per-package blocks, for prompt-cache efficiency), so prompt byte counts differ from `@v6` even on an identical diff. The review's substance is unaffected. |
| Inline anchoring | The `subject_type: "file"` fallback is **gone** — a finding on a file GitHub's own diff can't anchor a comment to is never posted as a file-level comment. It appears in the sticky comment's `### Unanchored findings` section instead. See [Inline comments & suggestions](#inline-comments--suggestions). |
| New input | `MAX_WALL_MS` — soft wall-clock budget, resumable via [`@toolu resume`](#toolu-resume-resuming-a-paused-run). See [Inputs](#inputs). |

No workflow YAML changes are required to adopt `@v7` — bump the pinned ref (`falconiere/toolu-ghactions/code-review@v7`) and the new behavior applies on the next run. If any downstream tooling parses the sticky comment's markdown directly (rather than the machine-readable verdict label `pr-babysit` uses), re-check it against the new section shapes above; the verdict label, checklist line, and `### Findings` block are unchanged.

## Packaging

The action is a **composite** whose two node steps are nested **node24 actions**, each with its bundle colocated and committed:
- `run/` — the main LLM review (`run/index.cjs`)
- `sanitize-sarif/` — the SARIF region sanitizer (`sanitize-sarif/index.cjs`)

The composite invokes them with the `$/` self-repository syntax (GA 2026-07-30), which resolves against this action's repository at your pinned ref — so the nested steps always match the version you pinned.

**Self-hosted runners:** because the node steps are node-type actions, the Actions runner supplies its own bundled Node — **no node on the runner's PATH is required**. The `$/` syntax requires **Actions runner ≥ 2.336.0** (GitHub-hosted and auto-updating self-hosted runners are already there; a version-pinned older runner must update).

It was rewritten from the previous Dockerized bash action; there is **no Docker image** anymore.

- **Breaking packaging change, no contract change.** Every `action.yml` input and
  output name and default is preserved, so an existing `@v2` workflow keeps
  working untouched — only the way the action runs changed.
- **Fixes land on merge.** Because consumers run the checked-out ref directly
  (no image to rebuild and re-push to a registry), a fix reaches the action the moment
  it merges — no release required.
- **Single model, one backend at a time.** The 6-vendor parallel ensemble was dropped
  in favor of one model — via OpenRouter or a native vendor API (DeepSeek, MiniMax,
  Kimi), selected with `PROVIDER` — through the Vercel AI SDK. The old ensemble inputs (`PROVIDERS`,
  `MERGE_STRATEGY`, `FALLBACK_MODEL`, `REVIEW_MODE`, `ENFORCE_JSON_SCHEMA`) and the
  split key/model inputs (`OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `MODEL`) were
  [removed in v4](#removed-in-v4-migration).

## SARIF sanitizer

Runs automatically inside the composite — nothing to wire. gitleaks emits `region` values of `0` for findings it cannot anchor to a line (path-based rules like private-key files), and GitHub Code Scanning rejects the **entire** SARIF file for it (`startLine must be greater than or equal to 1`).

Between the scanner steps and the upload, the sanitizer **copies** each `*.sarif` into an upload-only directory, fixing regions only in the copies: `startLine < 1` is clamped to `1`; sub-1 `startColumn`/`endLine`/`endColumn` are **deleted** (their SARIF defaults are sane, and a clamped empty region would trade one rejection for another). The upload step reads only the sanitized copies.

The originals in `$RUNNER_TEMP` are untouched on purpose: the LLM triage reads those and deliberately **drops** unanchorable line-0 results instead of rewriting them — a finding that cannot be cited in the diff should not reach the review, but a real secret in a key file should still reach the Code Scanning tab (anchored at line 1).

Best-effort like the scanner steps: an unparseable file is skipped with a workflow warning, and the step never fails the review.


## Streaming salvage & budget ceiling

Large PRs can exceed the per-request `MAX_TOKENS` budget. When this happens:
- **Streaming salvage** — findings completed *before* the truncation cut are kept (partial review), instead of the whole chunk being lost.
- **Budget escalation** — a truncated response is retried with double the budget (`8192 → 16384 → 32768 → 65536 → 131072`), up to the 131072-token ceiling.
- **Honest partial banner** — when the budget still runs out, the comment names the lever that can actually help: raise `MAX_TOKENS` while below the 131072 ceiling, lower `MAX_CHUNK_LINES` at it.

A truncation salvage never approves: a chunk cut mid-review always carries a `changes` verdict (the model never finished deciding), and unreviewed/pending files degrade a would-be `approved` to `error` via the coverage ledger — incomplete coverage never auto-merges.

## Development

TypeScript bundled to `run/index.cjs` and `sanitize-sarif/index.cjs`; the dev loop runs on [bun](https://bun.sh). See [CONTRIBUTING](../CONTRIBUTING.md) for the full guide.

```bash
cd code-review
bun install        # deps + git hooks (lefthook)
bun run check      # typecheck + lint (oxlint, type-aware) + fmt:check (oxfmt) + test (vitest)
bun run build      # esbuild → run/index.cjs and sanitize-sarif/index.cjs (commit both; CI fails if they drift from src)
```

## Eval harness

`code-review/evals/` is a **live eval harness**, not a unit test: it fetches a real
PR's changed files via the `gh` CLI, replays them into a scratch git repo, and runs
the SAME `runReview()` entry point this action calls — distill → cartographer →
chunked package reviewers (bisection included) → clustering → render — with a REAL
model call, but with GitHub posting swapped for a recording fake so nothing is
actually posted. It then prints a scorecard: changed files, per-stratum counts,
pattern groups (count + biggest), packages, model calls (cartographer vs.
package-layer, which folds in any bisection retries), findings raw vs. clustered,
coverage-status counts, marker bytes vs. the 65 000-char comment-size ceiling, and
wall time.

It is **excluded from `bun run check`** — evals/ sits outside `tsconfig.json`'s
`include` and outside oxlint/oxfmt's walk (see `package.json`'s `lint`/`fmt`
scripts), and vitest's own `include` glob never reaches it either. Its own tests
live in `evals/__tests__/`, run directly with `bun test evals/__tests__`.

```bash
cd code-review
bun run eval -- --help                            # usage; no key, gh, or network needed

API_KEY=sk-or-... bun run eval -- \                # a live run (needs `gh`, authenticated)
  --pr Falconiere/comemory#72 \
  --provider openrouter --model deepseek/deepseek-v4-pro \
  --out scorecard.json
```

Flags: `--pr <owner/repo#number>` (default `Falconiere/comemory#72`), `--provider`/
`--model` (defaulting to this action's own defaults), `--max-wall-ms` (forwarded as
`MAX_WALL_MS`), `--out <file>` (also write the scorecard as JSON).

## License

MIT — see [LICENSE](../LICENSE).
