# Code Review — Hardening, API Fixes & Quality Re-Architecture — Plan

**Date:** 2026-06-16   **Spec:** `docs/toolu/specs/2026-06-16-code-review-action-hardening-design.md`

## Context

The published code-review action makes false claims (no CI/LICENSE), can hang/leak/fail-silently at runtime, misuses the OpenRouter API (no `max_tokens` → credit over-reservation; no provider routing/fallback), and its single-call review design produces noisy, unvalidated findings. This plan delivers — in **one PR** — the infra/doc fixes, runtime + API hardening, the `minimax/minimax-m3` default, and a production-grade re-architecture: parallel per-dimension sub-reviewers → deterministic finding validation → coordinator filter.

## Approach

Edit the existing bash pipeline and add five scripts + four asset/infra files. Reuse the safe-JSON `jq -nc --arg` pattern already in `build-prompt.sh:97` across all JSON sites; reuse the 7 dimensions in `prompts/review-checklist.txt` as the source for grouped sub-reviewer prompts; keep `format-verdict.sh` rendering, extending only its inputs.

**Dimension grouping (resolves spec Q3):** 4 sub-reviewer groups, configurable — `correctness`; `security`; `performance+migration`; `tests+assertions+docs`. Plus 1 coordinator call ⇒ 5 calls/review in `parallel` mode (legacy 1 call in `single` mode). Cost documented in README.

**Size discipline:** fan-out lives in a new `run-dimension.sh` (one dimension's build→call→parse) so `main.sh` stays ≤300 lines; if `fetch-diff.sh` exceeds 300 lines, split diff-shaping into `shape-diff.sh`.

**Commit order:** gate first (tests.yml), then cheap infra/docs/model, then runtime+API hardening, then the re-architecture, then docs-sync + full-suite — so each step lands on a green gate.

**Tests:** bats over real recorded fixtures (per-dimension OpenRouter responses, a coordinator response, a free-text fallback, real git repos built in `setup()` for diff/binary/lockfile cases). The `curl` binary is replaced by a boundary double that replays fixtures and logs args — network stub, never fabricated finding data. Fixtures are captured FIRST (right after the gate) because every harden/feature test consumes them.

**Fan-out semantics (resolves plan-review):** sub-reviewer jobs run as background processes writing to `$TMPDIR/<dim>.json`; after `wait`, each job's status is collected explicitly per-PID (`wait "$pid"` in a loop) since `set -euo pipefail` does NOT abort on a backgrounded failure. **Partial failure is tolerated:** if ≥1 dimension job fails but ≥1 succeeds, the review proceeds on the successful set and the coordinator/comment notes which dimensions were skipped; only if ALL dimension jobs fail does `main` call `fail()`.

**Line-priming contract:** `fetch-diff.sh` prefixes each kept diff line with its new-file absolute number (`Lnnn: `) and records the valid set in `changed_lines[]`; `dimension-base.txt` instructs the model to cite those exact `Lnnn` numbers; `parse-response.sh` strips the `L` prefix to an integer `line`; `validate-findings.sh` keeps a finding only if `line ∈ changed_lines`. The contract is the `Lnnn` number — same value end to end.

## Steps (machine-readable)

```json
[
  {
    "id": "ci-tests-workflow",
    "title": "Add .github/workflows/tests.yml: test job (bats) + lint job (shellcheck + action-validator), on push + pull_request",
    "check": "test -f .github/workflows/tests.yml && grep -q 'code-review/__tests__' .github/workflows/tests.yml && grep -q 'shellcheck' .github/workflows/tests.yml && grep -q 'action-validator' .github/workflows/tests.yml"
  },
  {
    "id": "license",
    "title": "Add MIT LICENSE file at repo root (year 2026, holder Falconiere)",
    "check": "test -f LICENSE && grep -qi 'MIT License' LICENSE && grep -q 'Falconiere' LICENSE"
  },
  {
    "id": "readme-dev-globs",
    "title": "Fix README dev commands: actions/* globs -> code-review/* paths",
    "check": "! grep -q 'actions/\\*' README.md && grep -q 'code-review/__tests__/\\*.bats' README.md && grep -q 'code-review/src/\\*.sh' README.md"
  },
  {
    "id": "hygiene-files",
    "title": "Add CONTRIBUTING.md (conventional commits + bats instructions) and .github/CODEOWNERS (* @Falconiere)",
    "check": "test -f CONTRIBUTING.md && grep -qi 'conventional commit' CONTRIBUTING.md && test -f .github/CODEOWNERS && grep -q '@Falconiere' .github/CODEOWNERS"
  },
  {
    "id": "default-model",
    "title": "Switch default model to minimax/minimax-m3 in action.yml + build-prompt.sh + README; remove all qwen/qwen3.7-max",
    "check": "grep -q 'minimax/minimax-m3' code-review/action.yml && grep -q 'minimax/minimax-m3' code-review/src/build-prompt.sh && grep -q 'minimax/minimax-m3' README.md && ! grep -rq 'qwen/qwen3.7-max' code-review/ README.md"
  },
  {
    "id": "action-yml-inputs",
    "title": "Add inputs FALLBACK_MODEL, MAX_TOKENS, REVIEW_MODE, MIN_CONFIDENCE, ENFORCE_JSON_SCHEMA to action.yml; add 'skip' to the verdict output description line",
    "check": "bash -c 'for i in FALLBACK_MODEL MAX_TOKENS REVIEW_MODE MIN_CONFIDENCE ENFORCE_JSON_SCHEMA; do grep -q \"$i\" code-review/action.yml || exit 1; done' && grep -qE 'approved.*changes.*skip|skip.*verdict' code-review/action.yml"
  },
  {
    "id": "release-infra",
    "title": "release.yml: pass token RELEASE_PLEASE_TOKEN to release-please + error-handle force-push of major alias; release-please-config.json: remove redundant top-level release-type (confirmed present at line 2, dup of per-package line 8)",
    "check": "grep -q 'RELEASE_PLEASE_TOKEN' .github/workflows/release.yml && jq -e '.[\"release-type\"]==null' .github/release-please-config.json >/dev/null && jq -e '.packages[\".\"][\"release-type\"]==\"simple\"' .github/release-please-config.json >/dev/null"
  },
  {
    "id": "dockerfile-pin",
    "title": "Pin Dockerfile base image to alpine:3.21 by sha256 digest",
    "check": "grep -qE 'FROM alpine:3.21@sha256:[0-9a-f]{64}' code-review/Dockerfile"
  },
  {
    "id": "parse-verdict-strict",
    "title": "scripts/parse-verdict.sh: set -o pipefail -> set -euo pipefail",
    "check": "grep -q 'set -euo pipefail' scripts/parse-verdict.sh && bash -n scripts/parse-verdict.sh"
  },
  {
    "id": "real-fixtures",
    "title": "Capture real recorded fixtures BEFORE the harden/feature steps that consume them: one OpenRouter response per dimension group (correctness/security/performance/tests), a coordinator response, a free-text (ENFORCE_JSON_SCHEMA=false) response, a 429-then-200 pair, a 500-with-fake-Bearer body, a 200-with-embedded-error body; plus git setup() helpers (real PNG, real *.lock, hallucinated-line case)",
    "check": "bash -c 'cd code-review/__tests__/fixtures && for f in sample-openrouter-response-correctness.json sample-openrouter-response-security.json sample-openrouter-response-performance.json sample-openrouter-response-tests.json sample-coordinator-response.json sample-openrouter-response-freetext.txt sample-openrouter-429.json sample-openrouter-500-leak.txt sample-openrouter-200-embedded-error.json; do test -f \"$f\" || { echo \"missing $f\"; exit 1; }; done'"
  },
  {
    "id": "call-openrouter-harden",
    "title": "call-openrouter.sh: --data-binary @tmpfile (ARG_MAX) + EXIT trap, --connect-timeout 15 + --max-time, retry 3x w/ BACKOFF_BASE on 429/503/5xx/000 honoring Retry-After, parse HTTP-200-embedded-error, truncate body to 200 chars in error stderr, pass max_tokens + top-level models[primary,fallback] + provider routing through. Add bats cases for each new behavior against the recorded fixtures.",
    "check": "bash -n code-review/src/call-openrouter.sh && bats code-review/__tests__/call-openrouter.bats && grep -q 'connect-timeout' code-review/src/call-openrouter.sh && grep -qiE 'retr(y|ies) on 429|429.*then.*200' code-review/__tests__/call-openrouter.bats && grep -qiE 'leak|secret|truncat' code-review/__tests__/call-openrouter.bats && grep -qiE 'embedded error|200.*error' code-review/__tests__/call-openrouter.bats"
  },
  {
    "id": "post-comment-harden",
    "title": "post-comment.sh: add --connect-timeout 10 --max-time 30 to all curls, send bodies via --data @tmpfile, collect matching comment IDs across all pages then sort_by(.created_at)|last globally. Add a bats case for cross-page latest-comment selection.",
    "check": "bash -n code-review/src/post-comment.sh && bats code-review/__tests__/post-comment.bats && grep -q 'max-time' code-review/src/post-comment.sh && grep -qiE 'across pages|all pages|pagination' code-review/__tests__/post-comment.bats"
  },
  {
    "id": "fetch-diff-harden",
    "title": "fetch-diff.sh: all error JSON via jq -nc --arg, binary detection via git diff --numstat, line count via printf '%s'. Add bats cases for a quote-containing BASE_BRANCH (valid JSON) and numstat binary detection.",
    "check": "bash -n code-review/src/fetch-diff.sh && bats code-review/__tests__/fetch-diff.bats && grep -q 'numstat' code-review/src/fetch-diff.sh && grep -qiE 'quote|binary' code-review/__tests__/fetch-diff.bats"
  },
  {
    "id": "fetch-diff-noise-chunk",
    "title": "fetch-diff.sh (split into shape-diff.sh if >300 non-comment lines): strip noise files (*.lock,*-lock.json,*.min.js/css,*.map,@generated) into dropped_files; emit per-file hunks with new-file absolute line-number priming (Lnnn:) + changed_lines[]; replace lexicographic truncation with per-file budget + hunk-boundary header-preserving truncation. Add bats cases for lockfile drop and hunk-boundary truncation.",
    "check": "bash -n code-review/src/fetch-diff.sh && bats code-review/__tests__/fetch-diff.bats && grep -rq 'dropped_files' code-review/src/ && grep -rq 'changed_lines' code-review/src/ && grep -qiE 'lock|dropped|chunk|truncat' code-review/__tests__/fetch-diff.bats"
  },
  {
    "id": "dimension-prompts",
    "title": "Add prompts/dimension-base.txt (negative constraints, HIGH-confidence rule, cite primed Lnnn numbers, verbatim-quote requirement, emit suggestion+end_line when a concrete fix is known, reasoning-first + findings JSON schema) and prompts/coordinator.txt (dedup, reasonableness, verdict, review_plan, top_must_fix); keep review-checklist.txt for single mode, add negative constraints to it",
    "check": "test -f code-review/prompts/dimension-base.txt && test -f code-review/prompts/coordinator.txt && grep -qi 'high.confidence' code-review/prompts/dimension-base.txt && grep -qiE 'Lnnn|line number|primed' code-review/prompts/dimension-base.txt && grep -qi 'suggestion' code-review/prompts/dimension-base.txt"
  },
  {
    "id": "build-prompt-dimension",
    "title": "build-prompt.sh: INPUT_DIMENSION builds scoped sub-reviewer prompt (base + dimension focus); always set max_tokens + temperature; add top-level models[MODEL,FALLBACK_MODEL]; gate response_format + provider.require_parameters on ENFORCE_JSON_SCHEMA; extend finding schema with reasoning(first), confidence, category, end_line, suggestion; single-mode path preserved. Update build-prompt.bats for dimension + schema + provider assertions.",
    "check": "bash -n code-review/src/build-prompt.sh && bats code-review/__tests__/build-prompt.bats && grep -q 'max_tokens' code-review/src/build-prompt.sh && grep -q 'require_parameters' code-review/src/build-prompt.sh && grep -qiE 'dimension|require_parameters|max_tokens' code-review/__tests__/build-prompt.bats"
  },
  {
    "id": "parse-response-extend",
    "title": "parse-response.sh: emit {dimension,findings:[{path,line,end_line,severity,category,confidence,quoted_line,suggestion,text}],reasoning}; strip Lnnn prefix to integer line; invalid-verdict/error JSON via jq -nc --arg; regex fallback tolerates leading reasoning/<thinking> block. Update parse-response.bats for new fields + reasoning-tolerant fallback.",
    "check": "bash -n code-review/src/parse-response.sh && bats code-review/__tests__/parse-response.bats && grep -qiE 'confidence|reasoning' code-review/__tests__/parse-response.bats"
  },
  {
    "id": "validate-findings",
    "title": "Add code-review/src/validate-findings.sh (with header doc line): deterministic drop of findings whose path not in changed_files or line not in changed_lines (verify quoted_line +/-2); apply MIN_CONFIDENCE gate; drop the suggestion (not the finding) when confidence!=high or the line..end_line span isn't fully in changed_lines; emit dropped-count to stderr (not silent)",
    "check": "test -f code-review/src/validate-findings.sh && head -3 code-review/src/validate-findings.sh | grep -q '#' && bash -n code-review/src/validate-findings.sh && bats code-review/__tests__/validate-findings.bats && grep -qiE 'hallucinat|not in diff|dropped|999' code-review/__tests__/validate-findings.bats && grep -qi 'suggestion' code-review/__tests__/validate-findings.bats"
  },
  {
    "id": "coordinate-findings",
    "title": "Add code-review/src/coordinate-findings.sh (with header doc line): build coordinator request from validated finding union via coordinator.txt -> call-openrouter -> emit final {review_plan,verdict,findings,other_checks,top_must_fix} (format-verdict shape); note which dimensions were skipped on partial failure. Handle ENFORCE_JSON_SCHEMA=false (parse via parse-response fallback).",
    "check": "test -f code-review/src/coordinate-findings.sh && head -3 code-review/src/coordinate-findings.sh | grep -q '#' && bash -n code-review/src/coordinate-findings.sh && bats code-review/__tests__/coordinate-findings.bats && grep -qiE 'dedup|duplicate' code-review/__tests__/coordinate-findings.bats"
  },
  {
    "id": "run-dimension",
    "title": "Add code-review/src/run-dimension.sh (with header doc line): for one dimension, pipe diff -> build-prompt(INPUT_DIMENSION) -> call-openrouter -> parse-response; writes one dimension result JSON; non-zero exit on failure so main can collect per-PID status",
    "check": "test -f code-review/src/run-dimension.sh && head -3 code-review/src/run-dimension.sh | grep -q '#' && bash -n code-review/src/run-dimension.sh && bats code-review/__tests__/run-dimension.bats"
  },
  {
    "id": "main-orchestrator",
    "title": "main.sh: parallel mode fans out 4 dimension groups via run-dimension.sh as background jobs into mktemp -d; after wait, collect each job's status per-PID (set -e safe); tolerate partial failure (proceed if >=1 succeeds, fail() only if ALL fail); aggregate -> validate-findings -> coordinate-findings -> format-verdict -> post-comment (summary) -> post-review (inline, non-fatal); single mode keeps legacy path; remove 2>/dev/null from child calls and surface child stderr in fail(). Add main.bats cases for parallel aggregation + partial-failure + single mode.",
    "check": "bash -n code-review/src/main.sh && bats code-review/__tests__/main.bats && ! grep -q '2>/dev/null' code-review/src/main.sh && grep -q 'post-review.sh' code-review/src/main.sh && grep -qiE 'partial|all.*fail|single mode|parallel' code-review/__tests__/main.bats"
  },
  {
    "id": "format-verdict-extend",
    "title": "format-verdict.sh: render confidence + category alongside each finding; tolerate missing fields; KEEP the agent-merge-approved/agent-request-changes label + finding line shape that scripts/parse-verdict.sh and external pr-babysit consume. Add a bats case asserting parse-verdict.sh still parses the rendered output.",
    "check": "bash -n code-review/src/format-verdict.sh && bats code-review/__tests__/format-verdict.bats && grep -qiE 'category|confidence' code-review/src/format-verdict.sh && grep -qiE 'category.*confidence|confidence.*category' code-review/__tests__/format-verdict.bats && grep -qiE 'parse-verdict|compat' code-review/__tests__/format-verdict.bats"
  },
  {
    "id": "post-review",
    "title": "Add code-review/src/post-review.sh (header doc line) + INLINE_COMMENTS input (default true) in action.yml: read final findings + head SHA (.pull_request.head.sha) + PR number; build POST /repos/{repo}/pulls/{pr}/reviews body {commit_id, event:'COMMENT', body, comments:[{path,line,side:'RIGHT',body}]}; include only findings whose line in changed_lines; render a ```suggestion block when a finding has confidence==high + a suggestion + an anchored span; curl with shared --connect-timeout/--max-time + retry; on 422/failure log + exit 0 (non-fatal). Tests: real PR-event fixture + curl-double assert review body shape, suggestion rendering, out-of-diff exclusion, INLINE_COMMENTS=false skip, 422 non-fatal.",
    "check": "test -f code-review/src/post-review.sh && head -3 code-review/src/post-review.sh | grep -q '#' && bash -n code-review/src/post-review.sh && grep -q 'INLINE_COMMENTS' code-review/action.yml && bats code-review/__tests__/post-review.bats && grep -qiE 'suggestion' code-review/__tests__/post-review.bats && grep -qiE '422|INLINE_COMMENTS' code-review/__tests__/post-review.bats"
  },
  {
    "id": "docs-sync",
    "title": "README: inputs table (FALLBACK_MODEL, MAX_TOKENS, REVIEW_MODE, MIN_CONFIDENCE, ENFORCE_JSON_SCHEMA, INLINE_COMMENTS, OPENROUTER_API_KEY footnote), outputs incl. skip, default model, How-it-works rewrite for parallel sub-reviewers + coordinator + inline comments & suggestions + cost note, dev section; action.yml descriptions accurate",
    "check": "grep -q 'REVIEW_MODE' README.md && grep -q 'minimax/minimax-m3' README.md && grep -q 'skip' README.md && grep -q 'INLINE_COMMENTS' README.md && grep -qiE 'coordinator|sub-reviewer|parallel' README.md && grep -qiE 'suggestion|inline comment' README.md"
  },
  {
    "id": "full-suite-core",
    "title": "Core green gate (always runnable): all bats pass + shellcheck clean (--severity=warning floor; style/info advisory) across src + scripts",
    "check": "bats code-review/__tests__/*.bats && shellcheck --severity=warning code-review/src/*.sh scripts/*.sh"
  },
  {
    "id": "full-suite-env",
    "title": "Environment-gated gate: action-validator (@action-validator/cli) + docker build (skip cleanly if docker/npx unavailable in sandbox; MUST run in CI tests.yml)",
    "check": "bash -c 'command -v docker >/dev/null && docker build -t code-review-action:test code-review/ || echo \"docker unavailable - deferred to CI\"; command -v npx >/dev/null && npx --yes @action-validator/cli code-review/action.yml || echo \"npx unavailable - deferred to CI\"'"
  }
]
```

## Critical files

| File | Action | What |
|---|---|---|
| `.github/workflows/tests.yml` | Create | bats + lint CI |
| `LICENSE`, `CONTRIBUTING.md`, `.github/CODEOWNERS` | Create | infra/hygiene |
| `code-review/src/run-dimension.sh` | Create | one dimension's build→call→parse |
| `code-review/src/validate-findings.sh` | Create | deterministic finding validation + confidence gate |
| `code-review/src/coordinate-findings.sh` | Create | coordinator LLM call |
| `code-review/src/shape-diff.sh` | Create (if needed) | diff noise-strip + hunk chunking if fetch-diff >300 lines |
| `code-review/prompts/dimension-base.txt`, `coordinator.txt` | Create | sub-reviewer + coordinator prompts |
| `code-review/src/main.sh` | Edit | parallel orchestration, stderr surfacing |
| `code-review/src/fetch-diff.sh` | Edit | jq errors, numstat binary, noise strip, hunk chunk, line priming |
| `code-review/src/build-prompt.sh` | Edit | per-dimension, max_tokens, models, provider routing, schema |
| `code-review/src/call-openrouter.sh` | Edit | timeouts, retry, 200-error, secret-truncate, ARG_MAX |
| `code-review/src/parse-response.sh` | Edit | extended schema, jq errors, reasoning-tolerant fallback |
| `code-review/src/post-comment.sh` | Edit | timeouts, --data @file, global pagination |
| `code-review/src/format-verdict.sh` | Edit | confidence/category render |
| `scripts/parse-verdict.sh` | Edit | set -euo pipefail |
| `code-review/Dockerfile` | Edit | digest pin |
| `code-review/action.yml` | Edit | inputs + outputs |
| `.github/workflows/release.yml`, `release-please-config.json` | Edit | token + dedup release-type |
| `README.md` | Edit | docs sync |
| `code-review/__tests__/*.bats` + `fixtures/*` | Create/Edit | real-data tests per script |

## Verification

```bash
# Full local gate (mirrors full-suite step)
bats code-review/__tests__/*.bats
shellcheck code-review/src/*.sh scripts/*.sh
npx --yes action-validator code-review/action.yml
docker build -t code-review-action:test code-review/

# Re-architecture real-data paths
#  - parallel fan-out: main.bats drives 4 dimension fixtures -> aggregated -> coordinator -> verdict
#  - hallucinated line dropped: validate-findings.bats asserts a path:line absent from the diff is removed
#  - noise strip: fetch-diff.bats on a real commit touching a *.lock + a source file
#  - retry/secret: call-openrouter.bats replays 429->200 (BACKOFF_BASE=0) and a 500 with a fake Bearer token

# LIVE verification (spec Q1 — not a CI check; run once during execution with a real key):
#  POST a minimal request with provider.require_parameters=true to confirm
#  minimax/minimax-m3 honors response_format json_schema. If it errors,
#  flip ENFORCE_JSON_SCHEMA default to false; FALLBACK_MODEL (claude-sonnet-4-5) covers either way.
```

**Conventional commits:** `feat:` for the model switch + new inputs/quality features (minor bump), `fix:` for the runtime/correctness bugs, `ci:`/`docs:`/`chore:` for infra. One PR; release-please cuts a single minor release.

## Deviations

- **2026-06-16 — shellcheck floor `--severity=warning`.** Pre-existing `style`/`info` nits (SC2001/SC2129, and an intentional-literal-backtick SC2016 false-positive in `format-verdict.sh`) made bare `shellcheck` exit 1 and red the lint gate. Policy: lint floor is `warning` (warnings + errors still block; style/info advisory). Applied to `tests.yml`, plan `full-suite-core` check, README, CONTRIBUTING. Genuine bugs at `fetch-diff.sh:71` / `main.sh` are still fixed by their own steps (numstat rewrite / orchestrator rewrite).
- **2026-06-16 — feature added mid-execution: inline review comments + code suggestions.** User requirement after foundation landed. Routed back through spec (see "Inline review comments & suggestions" section) before coding. Decisions: curl (no gh), `event=COMMENT` always, suggestions when HIGH-confidence + anchored. New step `post-review` + `INLINE_COMMENTS` input; schema gains `suggestion`/`end_line` carried through dimension-prompts → build-prompt → parse-response → validate-findings; `main-orchestrator` wires `post-review` non-fatally. Plan grew 25 → 26 steps.
- **2026-06-16 — action-validator package = `@action-validator/cli`.** Bare `npx action-validator` resolves to an unrelated v0.0.7 package ("could not determine executable"). The real validator is `@action-validator/cli` (bin `action-validator`). Applied to `tests.yml`, plan `full-suite-env`, README, CONTRIBUTING.

- **2026-06-16 — M3 supports json_schema (spec Q1 resolved).** `scripts/capture-fixtures.sh` captured all 4 dimensions in json_schema mode with no provider error → `ENFORCE_JSON_SCHEMA=true` default kept.
- **2026-06-16 — docker build deferred to CI.** The local Docker daemon went down mid-execution, so `full-suite-env`'s build step couldn't run locally. Verified the Dockerfile by inspection (all new `src/`+`prompts/` files are covered by the existing `COPY` lines) and added a dedicated `build` job to `tests.yml` so every push builds the image. `action-validator` + all 62 bats + shellcheck pass locally.
- **2026-06-16 — bats test names cannot contain backticks.** A `` ```json `` in a `@test` name broke bash sourcing of the file; renamed to plain text. Same applies to comemory save strings (backticks trigger command substitution).

- **2026-06-16 — execution-review caught a docker blocker.** Once the daemon came up, the build revealed two bugs: (1) `docker build … .` (repo-root context) fails because the Dockerfile `COPY src/`/`COPY prompts/` resolve against the context, not the Dockerfile dir — GitHub builds the action with context `code-review/`, so the README/CI command must too. Fixed to `docker build -t code-review-action:test code-review/` in `tests.yml`, README, CONTRIBUTING, plan. (2) The pinned digest was an amd64-specific child manifest (platform warning); repinned to the multi-arch index digest `sha256:48b0309…`. Build now exits 0 clean. Also fixed `fetch-diff.sh` post-truncation `grep -c ''` (empty input would exit 1 under `set -e`).

## Open items carried from spec

- **Q1 M3 × json_schema** — live-verify during execution (see Verification).
- **Q4 `RELEASE_PLEASE_TOKEN`** — user must create the repo secret; code degrades gracefully without it.
- **comemory PATH** — env gap, out of band; not in this PR.
