# Multi-Provider Code Review — Implementation Plan

**Date:** 2026-06-16   **Status:** Approved   **Spec:** `docs/toolu/specs/2026-06-16-multi-provider-code-review-design.md` (approved)

## Context

The code-review action is OpenRouter-only. The spec adds a `PROVIDERS` input (multiline JSON array of `{provider, model, api_key, ...}` entries) so callers can configure multiple AI vendors per run; one review per provider runs in parallel; the merger combines N verdicts by `MERGE_STRATEGY` (conservative/majority/all_approve). Legacy `OPENROUTER_API_KEY` + `MODEL` + `MAX_TOKENS` + `ENFORCE_JSON_SCHEMA` inputs keep working unchanged (auto-translated to a 1-element `PROVIDERS` list). Per-provider script directories replace the single `call-openrouter.sh`. The per-dim sub-reviewer (`run-dimension.sh`, `dimension-base.txt`, `coordinator.txt`) is removed.

## Approach

- **6 new per-provider directories** under `code-review/src/providers/<name>/`; each contains ≤100 lines of `{build-request.sh, call.sh}`.
- **Provider-agnostic `build-prompt.sh`** produces only the `{system_prompt, user_prompt}` envelope; each provider's `build-request.sh` wraps that into the vendor's wire format.
- **`run-provider.sh`** is the new per-provider orchestrator: env-var setup → `build-prompt | providers/<name>/build-request | providers/<name>/call | parse-response | validate-findings`. It runs in parallel for each entry.
- **`coordinate-findings.sh` rewritten as a deterministic merger** with 3 strategies. No LLM call. Output shape is unchanged so `format-verdict.sh`, `post-comment.sh`, `post-review.sh`, `post-label.sh` need no behavior change (only `post-review.sh` is updated to consume the merged output, not per-provider raw).
- **`parse-response.sh` learns per-provider prefixes** dispatched on `$PROVIDER` env var.
- **Reused utilities (paths)**: `jq`, `curl`, `shellcheck` — already used throughout. `__tests__/helpers.bash` is extended for the new fixture path conventions.
- **Test discipline unchanged**: bats + real recorded fixtures, no mocks.

## Steps / workstreams

### Workstream 1 — Foundation

- **1.1** Add `providers` and `merge_strategy` inputs to `code-review/action.yml`; mark `OPENROUTER_API_KEY` as `required: false`; add doc lines for all 12 legacy inputs per spec.
- **1.2** Refactor `code-review/src/build-prompt.sh` to emit a provider-agnostic `{system, user, max_tokens, enforce_json_schema}` envelope on stdout (drop the OpenRouter-specific `models[]` + `provider.require_parameters` fields; they were OpenRouter-only and multi-provider IS the fallback now).
- **1.3** Create `code-review/src/providers/{openrouter,openai,anthropic,deepseek,moonshot,minimax}/` directories with `.gitkeep` files (real scripts land in Workstream 2).
- **1.4** Create `code-review/src/run-provider.sh` skeleton: parse entry JSON, export `PROVIDER/MODEL/API_KEY/MAX_TOKENS/ENFORCE_JSON_SCHEMA` env vars, run the pipeline `build-prompt | providers/$PROVIDER/build-request | providers/$PROVIDER/call | parse-response | validate-findings`, write the result to a temp file path passed as `$1`.
- **1.5** Extend `__tests__/helpers.bash` with: `assert_json_path`, `assert_contains`, `stub_curl_with_fixture <path>` (replays a recorded response), `capture_temp_file` (for the dispatch loop).

### Workstream 2 — Per-provider scripts

Five of six providers (openai, deepseek, moonshot, minimax, and the openai-compat openrouter) share an OpenAI-compat request/response shape; their `build-request.sh` and `call.sh` scripts are nearly identical. **Duplication is intentional per spec** — explicit per-provider scripts (vs a config-driven generic caller) keep each script under 100 lines and avoid the generic-caller architecture the spec rejected. Only Anthropic has a structurally different request body (top-level system + tool-use).

- **2.1** **`openrouter/`** — port `call-openrouter.sh` → `call.sh` (strip the `OPENROUTER_API_KEY` env-var read; read `$API_KEY` from env). New `build-request.sh`: takes envelope on stdin, emits OpenRouter chat-completions body. No `models[]` array (legacy `FALLBACK_MODEL` is dropped). Honors `enforce_json_schema`.
- **2.2** **`openai/`** — new `build-request.sh` (OpenAI chat-completions body, `response_format: json_schema` when `enforce_json_schema=true`, `max_tokens` always set). New `call.sh` (Bearer auth, retry with backoff on 429/5xx/000, redact error bodies — same hardening as openrouter).
- **2.3** **`anthropic/`** — new `build-request.sh`: top-level `system` field, `messages[]` contains only `user` turn, `max_tokens` always set, `tools: [{name: submit_review, input_schema: <schema>}]` + `tool_choice: {type: tool, name: submit_review}` when `enforce_json_schema=true`; prompt-only JSON when false. New `call.sh` (x-api-key + anthropic-version headers, same retry+redaction pattern).
- **2.4** **`deepseek/`** — new `build-request.sh` (OpenAI-compat body, `response_format: {type: json_object}` when `enforce_json_schema=true`). New `call.sh` (same OpenAI-compat pattern).
- **2.5** **`moonshot/`** — new `build-request.sh` (OpenAI-compat body, `response_format: {type: json_object}` when `enforce_json_schema=true`). New `call.sh`.
- **2.6** **`minimax/`** — new `build-request.sh` (OpenAI-compat body, `response_format: {type: json_object}` when `enforce_json_schema=true`). New `call.sh`.

### Workstream 3 — `parse-response.sh` rewrite

- **3.1** Refactor `code-review/src/parse-response.sh` to dispatch on `$PROVIDER` env var: `openrouter|openai|deepseek|moonshot|minimax` → `.choices[0].message.content`; `anthropic` with `enforce_json_schema=true` → `.content[?(@.type=="tool_use" and @.name=="submit_review")].input`; `anthropic` with `enforce_json_schema=false` → `.content[?(@.type=="text")].text|[0]`. **Fallback chain for Anthropic**: tool_use → text-block → regex. If tool_use is absent (e.g., model doesn't support tools), fall back to the text-block path; if text-block is also absent, fall back to the regex path (free-text → findings). Log a one-line warning to stderr naming the fallback path used (debugging aid). `thinking` blocks are skipped at every step. Existing regex fallback preserved.
- **3.2** `parse-response.sh` normalizes every successful call to the shape in the spec: `{provider, model, verdict, findings, review_plan, other_checks, top_must_fix}`. `reasoning` is captured then dropped before stdout. On error: `{provider, model, error, verdict: null, findings: []}`.

### Workstream 4 — `coordinate-findings.sh` rewrite (multi-provider merger)

- **4.1** New stdin shape: `{providers: [{provider, verdict|error, findings, top_must_fix, other_checks, ...}], strategy: "conservative|majority|all_approve"}`. New stdout shape: `{verdict, findings, review_plan, other_checks, top_must_fix}` (unchanged from old contract).
- **4.2** Dedupe key: `(path, line, end_line, lowercased-text-fingerprint-80)`. Severity = max across matches. `category` is preserved (first provider wins), not part of the dedupe key.
- **4.3** Strategy logic: `conservative` (any changes OR any error → changes); `majority` (`ceil(N/2)+1` changes win, errors abstain); `all_approve` (all must say approved; errors count as changes).
- **4.4** `top_must_fix` aggregation: dedupe by path, max severity, cap 3.
- **4.5** Auto-generate `review_plan` ("Reviewed by N providers: <list>. Merged with <strategy>.") and `other_checks` (per-provider agreement summary: `openai: approved, anthropic: changes, deepseek: error`).
- **4.6** **All-providers-error edge case:** if all N providers returned `{error, verdict: null}`, the merger still produces a verdict — `conservative` and `all_approve` produce `changes`; `majority` produces `approved` (0 changes vs 0 approvals is a tie → default `approved` is the safest interpretation since abstention never counts). The verdict comment's `other_checks` names every errored provider and the error. The action posts a verdict comment, NOT a skip.

### Workstream 5 — `main.sh` rewrite

- **5.1** Read `INPUT_PROVIDERS`; if empty/non-JSON, fall back to legacy resolution (build 1-element list from `INPUT_OPENROUTER_API_KEY` + `INPUT_MODEL` + `INPUT_ENFORCE_JSON_SCHEMA` + `INPUT_MAX_TOKENS`); log deprecation hint when legacy path triggers.
- **5.2** If both `INPUT_PROVIDERS` and `INPUT_OPENROUTER_API_KEY` set: log warning, use `INPUT_PROVIDERS`, ignore legacy.
- **5.3** Spawn one `bash run-provider.sh <temp-path> <entry.json>` background job per entry. **Failure detection:** `wait $pid` returns the exit code; on non-zero, capture stderr (truncate to 200 chars), record `{provider, error: "job exited N: <stderr tail>"}` in the result file, and continue. `set -o pipefail` is honored in `run-provider.sh` so a parse-response or validate-findings failure surfaces as a non-zero exit. A failed job does NOT abort the run; the merger treats it as a `changes` vote (conservative) or abstention (majority).
- **5.4** Assemble the merger input `{providers: [...], strategy: $INPUT_MERGE_STRATEGY}` and pipe to `coordinate-findings.sh`. Downstream (format-verdict → post-comment → post-label → post-review) unchanged.
- **5.5** Per-entry `max_tokens` precedence: per-entry value → `INPUT_MAX_TOKENS` → 4096.

### Workstream 6 — Fixture recording (real API calls)

Each provider gets 2 fixtures recorded from a real API call (sanitized). Use the local proxy pattern documented in CONTRIBUTING. Recording procedure is one-time per provider. **If a provider's API is unavailable on recording day**, mark that provider's bats tests as `@test "skip: fixture pending"` and proceed without them; the corresponding ledger step records the skip and the merge can be done later when the API is reachable.

- **6.1** `__tests__/fixtures/openrouter/success.json` + `error-401.json` (existing fixtures may already cover this — reuse if so).
- **6.2** `__tests__/fixtures/openai/success.json` + `error-401.json`.
- **6.3** `__tests__/fixtures/anthropic/success.json` (tool_use shape) + `error-401.json` + `success-no-tooluse.json` (text-only path).
- **6.4** `__tests__/fixtures/deepseek/success.json` + `error-401.json`.
- **6.5** `__tests__/fixtures/moonshot/success.json` + `error-401.json`.
- **6.6** `__tests__/fixtures/minimax/success.json` + `error-401.json`.
- **6.7** `__tests__/fixtures/merge/{two-providers-approve-changes,three-providers-majority-changes,four-providers-conflicting-severities,two-providers-one-error}.{json,expected.json}` — 4 cases × 2 files = 8 merge fixtures.

### Workstream 7 — Test suite

- **7.1** `__tests__/providers/<name>/call.bats` × 6 — 1 success + 1 error per provider, asserting exit code, stderr redaction, stdout shape.
- **7.2** `__tests__/providers/<name>/build-request.bats` × 6 — assert request body shape per vendor (e.g., Anthropic has top-level `system`; OpenAI has `messages[0].role=system`; OpenAI has `response_format: json_schema`; DeepSeek has `response_format: json_object`).
- **7.3** `__tests__/parse-response.bats` — one subtest per provider, plus Anthropic tool_use subtest + Anthropic text-only subtest + thinking-block-skip subtest.
- **7.4** `__tests__/coordinate-findings.bats` — 3 strategies × 4 conflict cases (2p-approve-changes, 3p-majority, 4p-conflicting, 2p-one-error) = 12 cases. Plus 1 case per provider erroring out (already covered in 2p-one-error).
- **7.5** `__tests__/main.bats` — back-compat: legacy `OPENROUTER_API_KEY` flow still works (AC 10, 11, 12). Multi-provider: 2-provider `PROVIDERS` dispatches 2 jobs (AC 1). "Both set" warning (AC 36).
- **7.6** `__tests__/run-provider.bats` — 1 happy path per provider (6 subtests) with `enforce_json_schema: true` and `enforce_json_schema: false` for each = 12 subtests.
- **7.7** `__tests__/post-review.bats` — update to assert that with N providers in upstream, only the merged findings get posted as inline comments (AC 28).
- **7.8** `shellcheck --severity=warning code-review/src/**/*.sh` returns 0.
- **7.9** `npx @action-validator/cli code-review/action.yml` returns 0.

### Workstream 8 — Docs in sync + delete obsolete

- **8.1** `README.md` — add "Multiple providers" section with `PROVIDERS` JSON example + `merge_strategy` table. Add "Legacy single-provider" note pointing to the new input. Update the quickstart to mention `PROVIDERS` as preferred. Add AC #28, #29, #30 to the inputs table where relevant.
- **8.2** `CONTRIBUTING.md` — new "Recording provider fixtures" section with the local-proxy capture workflow.
- **8.3** Delete obsolete files: `code-review/src/call-openrouter.sh`, `code-review/src/run-dimension.sh`, `code-review/prompts/dimension-base.txt`, `code-review/prompts/coordinator.txt`. Update `code-review/__tests__/call-openrouter.bats` → `__tests__/providers/openrouter/call.bats` (move + update).
- **8.4** Update `code-review/src/post-review.sh` to consume the merged output (single source of findings), not per-provider raw.
- **8.5** `CHANGELOG.md` is auto-managed by release-please; do not hand-edit. Use `feat: ...` commit message.

### Workstream 9 — End-to-end verification

- **9.1** `bats code-review/__tests__/*.bats code-review/__tests__/providers/**/*.bats` — all green.
- **9.2** `shellcheck --severity=warning code-review/src/**/*.sh` — 0 issues.
- **9.3** `npx @action-validator/cli code-review/action.yml` — 0 issues.
- **9.4** `docker build -t code-review-action:test code-review/` — image builds.
- **9.5** Manual smoke test: run the action in a test workflow against a real PR with 1 provider (openrouter, no merge complexity) and 2 providers (verifies fan-out + merge). Confirm the verdict comment matches the spec's example shape. (Out-of-band; not in CI.)

## Critical files

**Create**:
- `code-review/src/run-provider.sh`
- `code-review/src/providers/{openrouter,openai,anthropic,deepseek,moonshot,minimax}/build-request.sh` (6 files)
- `code-review/src/providers/{openrouter,openai,anthropic,deepseek,moonshot,minimax}/call.sh` (6 files)
- `code-review/__tests__/helpers.bash` updates
- `code-review/__tests__/providers/<name>/{call,build-request}.bats` (12 files)
- `code-review/__tests__/{parse-response,coordinate-findings,main,run-provider,post-review}.bats` (5 files; rewrite or new)
- `code-review/__tests__/fixtures/<provider>/{success,error-401}.json` (12 files)
- `code-review/__tests__/fixtures/merge/{input,expected}.json` pairs (8 files)

**Modify**:
- `code-review/action.yml` — new `providers` + `merge_strategy` inputs; mark legacy `OPENROUTER_API_KEY` as optional
- `code-review/src/build-prompt.sh` — strip OpenRouter-specific body fields
- `code-review/src/parse-response.sh` — per-provider dispatch
- `code-review/src/coordinate-findings.sh` — rewrite as multi-provider merger
- `code-review/src/main.sh` — rewrite dispatcher with parallel jobs
- `code-review/src/post-review.sh` — consume merged output
- `README.md` — multiple-providers section + deprecation note
- `CONTRIBUTING.md` — recording-fixtures section

**Delete**:
- `code-review/src/call-openrouter.sh` (moved to `providers/openrouter/call.sh`)
- `code-review/src/run-dimension.sh` (per-dim sub-reviewer removed)
- `code-review/prompts/dimension-base.txt` (per-dim sub-reviewer removed)
- `code-review/prompts/coordinator.txt` (LLM coordinator removed; merge is deterministic)
- `code-review/__tests__/call-openrouter.bats` (moved to `__tests__/providers/openrouter/call.bats`)

## Verification (end-to-end)

Run these commands in order. Each must exit 0 before proceeding to the next.

```bash
# 1. Lint (recurses into providers/*/ via find, no globstar needed)
find code-review/src -name '*.sh' -exec shellcheck --severity=warning {} +

# 2. Action metadata
npx @action-validator/cli code-review/action.yml

# 3. Bats suite (all green)
bats code-review/__tests__/*.bats code-review/__tests__/providers/*/*.bats

# 4. Docker build
docker build -t code-review-action:test code-review/

# 5. Manual smoke (out-of-band): trigger a real workflow run with 1 + 2 providers
```

## Reused utilities (no new dependencies)

- `jq`, `curl`, `bats` — already in the Docker image and dev environment.
- `__tests__/helpers.bash` — extended, not replaced.
- `code-review/src/validate-findings.sh` — unchanged (moved to per-provider call site, no script changes).
- `code-review/src/format-verdict.sh` — unchanged (output contract is unchanged).
- `code-review/src/post-comment.sh`, `post-label.sh` — unchanged.
- `code-review/src/fetch-diff.sh`, `shape-diff.sh` — unchanged.

## Risks + open questions from spec carried into execution

- **OQ #1 (Anthropic tool-use fallback)**: if tool_use returns empty on a model, `parse-response.sh` falls back to the text-block path. If text-block path also fails, regex fallback. Tested in Workstream 7.3.
- **OQ #2 (free-form JSON quality on DeepSeek/Moonshot/MiniMax)**: regex fallback path is the only safety net. Tested in Workstream 7.3.
- **OQ #4 (rate limits)**: not blocking; monitor in production; add `PROVIDER_CONCURRENCY` in v1.1 if needed.

## Out of scope (per spec non-goals)

- 7th provider (Bedrock, Azure, Vertex, etc.)
- Cross-product fan-out (`MULTI_PROVIDER_MODE=cross_product`)
- Custom base URLs, OAuth, multi-modal
- Anthropic thinking-mode tuning
- Dynamic model selection per file
- Web UI for choosing providers

## Steps (machine-readable)

```json
[
  {"id": "1.1", "title": "Add PROVIDERS + MERGE_STRATEGY inputs to action.yml; mark legacy inputs", "check": "npx @action-validator/cli code-review/action.yml"},
  {"id": "1.2", "title": "Refactor build-prompt.sh to provider-agnostic envelope", "check": "bats code-review/__tests__/build-prompt.bats"},
  {"id": "1.3", "title": "Create providers/ directory structure (6 dirs)", "check": "test -d code-review/src/providers/openrouter && test -d code-review/src/providers/openai && test -d code-review/src/providers/anthropic && test -d code-review/src/providers/deepseek && test -d code-review/src/providers/moonshot && test -d code-review/src/providers/minimax"},
  {"id": "1.4", "title": "Create run-provider.sh skeleton", "check": "bash -n code-review/src/run-provider.sh"},
  {"id": "1.5", "title": "Extend __tests__/helpers.bash with stub_curl_with_fixture + assert helpers", "check": "bash -c 'source code-review/__tests__/helpers.bash && declare -F stub_curl_with_fixture >/dev/null && declare -F assert_json_path >/dev/null'"},
  {"id": "2.1", "title": "openrouter: port call.sh + new build-request.sh", "check": "bats code-review/__tests__/providers/openrouter/call.bats code-review/__tests__/providers/openrouter/build-request.bats"},
  {"id": "2.2", "title": "openai: new call.sh + build-request.sh", "check": "bats code-review/__tests__/providers/openai/call.bats code-review/__tests__/providers/openai/build-request.bats"},
  {"id": "2.3", "title": "anthropic: new call.sh + build-request.sh (with tool-use)", "check": "bats code-review/__tests__/providers/anthropic/call.bats code-review/__tests__/providers/anthropic/build-request.bats"},
  {"id": "2.4", "title": "deepseek: new call.sh + build-request.sh", "check": "bats code-review/__tests__/providers/deepseek/call.bats code-review/__tests__/providers/deepseek/build-request.bats"},
  {"id": "2.5", "title": "moonshot: new call.sh + build-request.sh", "check": "bats code-review/__tests__/providers/moonshot/call.bats code-review/__tests__/providers/moonshot/build-request.bats"},
  {"id": "2.6", "title": "minimax: new call.sh + build-request.sh", "check": "bats code-review/__tests__/providers/minimax/call.bats code-review/__tests__/providers/minimax/build-request.bats"},
  {"id": "3.1", "title": "Refactor parse-response.sh to per-provider dispatch with Anthropic fallback chain (tool_use -> text-block -> regex, with warning log)", "check": "bats code-review/__tests__/parse-response.bats"},
  {"id": "3.2", "title": "parse-response.sh normalizes to spec shape (drops reasoning)", "check": "bats code-review/__tests__/parse-response.bats --filter reasoning-dropped"},
  {"id": "4.1", "title": "coordinate-findings.sh new stdin/stdout shape", "check": "bats code-review/__tests__/coordinate-findings.bats"},
  {"id": "4.2", "title": "dedupe with end_line in key", "check": "bats code-review/__tests__/coordinate-findings.bats --filter end-line-dedupe"},
  {"id": "4.3", "title": "3 strategies + provider error handling", "check": "bats code-review/__tests__/coordinate-findings.bats"},
  {"id": "4.4", "title": "top_must_fix aggregation", "check": "bats code-review/__tests__/coordinate-findings.bats --filter top-must-fix"},
  {"id": "4.5", "title": "auto-generate review_plan + other_checks", "check": "bats code-review/__tests__/coordinate-findings.bats --filter review-plan"},
  {"id": "4.6", "title": "all-providers-error edge case (merger still produces verdict; comment names errored providers)", "check": "bats code-review/__tests__/coordinate-findings.bats --filter all-errored"},
  {"id": "5.1", "title": "main.sh reads PROVIDERS, falls back to legacy", "check": "bats code-review/__tests__/main.bats --filter backcompat"},
  {"id": "5.2", "title": "main.sh: both-set warning", "check": "bats code-review/__tests__/main.bats --filter both-set"},
  {"id": "5.3", "title": "main.sh: parallel dispatch + collect (wait $pid exit-code path; failed job -> {provider, error}; set -o pipefail in run-provider.sh)", "check": "bats code-review/__tests__/main.bats --filter dispatch"},
  {"id": "5.4", "title": "main.sh: assemble merger input + call coordinate-findings", "check": "bats code-review/__tests__/main.bats --filter end-to-end"},
  {"id": "5.5", "title": "main.sh: max_tokens precedence (per-entry > MAX_TOKENS > 4096)", "check": "bats code-review/__tests__/main.bats --filter max-tokens"},
  {"id": "6.1", "title": "openrouter fixtures recorded (reuse existing if applicable)", "check": "test -f code-review/__tests__/fixtures/openrouter/success.json && test -f code-review/__tests__/fixtures/openrouter/error-401.json"},
  {"id": "6.2", "title": "openai fixtures recorded", "check": "test -f code-review/__tests__/fixtures/openai/success.json && test -f code-review/__tests__/fixtures/openai/error-401.json"},
  {"id": "6.3", "title": "anthropic fixtures recorded (tool_use + text-only + error)", "check": "test -f code-review/__tests__/fixtures/anthropic/success.json && test -f code-review/__tests__/fixtures/anthropic/success-no-tooluse.json && test -f code-review/__tests__/fixtures/anthropic/error-401.json"},
  {"id": "6.4", "title": "deepseek fixtures recorded", "check": "test -f code-review/__tests__/fixtures/deepseek/success.json && test -f code-review/__tests__/fixtures/deepseek/error-401.json"},
  {"id": "6.5", "title": "moonshot fixtures recorded", "check": "test -f code-review/__tests__/fixtures/moonshot/success.json && test -f code-review/__tests__/fixtures/moonshot/error-401.json"},
  {"id": "6.6", "title": "minimax fixtures recorded", "check": "test -f code-review/__tests__/fixtures/minimax/success.json && test -f code-review/__tests__/fixtures/minimax/error-401.json"},
  {"id": "6.7", "title": "merge fixtures recorded (8 files: 4 cases × input + expected)", "check": "for c in two-providers-approve-changes three-providers-majority-changes four-providers-conflicting-severities two-providers-one-error; do test -f code-review/__tests__/fixtures/merge/$c.json && test -f code-review/__tests__/fixtures/merge/$c.expected.json; done"},
  {"id": "7.1", "title": "per-provider call.bats × 6 (success + error)", "check": "bats code-review/__tests__/providers/*/call.bats"},
  {"id": "7.2", "title": "per-provider build-request.bats × 6 (vendor shape assertions)", "check": "bats code-review/__tests__/providers/*/build-request.bats"},
  {"id": "7.3", "title": "parse-response.bats (per-provider + tool_use + thinking-block)", "check": "bats code-review/__tests__/parse-response.bats"},
  {"id": "7.4", "title": "coordinate-findings.bats (12 merge cases)", "check": "bats code-review/__tests__/coordinate-findings.bats"},
  {"id": "7.5", "title": "main.bats (backcompat + multi-provider + both-set)", "check": "bats code-review/__tests__/main.bats"},
  {"id": "7.6", "title": "run-provider.bats (6 providers × 2 enforce_json_schema settings = 12 subtests)", "check": "bats code-review/__tests__/run-provider.bats"},
  {"id": "7.7", "title": "post-review.bats (merged-only findings for INLINE_COMMENTS)", "check": "bats code-review/__tests__/post-review.bats"},
  {"id": "7.8", "title": "shellcheck clean (find-based recurse into providers/*/)", "check": "find code-review/src -name '*.sh' -exec shellcheck --severity=warning {} +"},
  {"id": "7.9", "title": "action.yml validates", "check": "npx @action-validator/cli code-review/action.yml"},
  {"id": "8.1", "title": "README updated with PROVIDERS section + merge_strategy table", "check": "grep -q '## Multiple providers' README.md && grep -q 'merge_strategy' README.md"},
  {"id": "8.2", "title": "CONTRIBUTING updated with Recording provider fixtures section", "check": "grep -q 'Recording provider fixtures' CONTRIBUTING.md"},
  {"id": "8.3", "title": "Obsolete files deleted (call-openrouter.sh, run-dimension.sh, dimension-base.txt, coordinator.txt, call-openrouter.bats)", "check": "! test -f code-review/src/call-openrouter.sh && ! test -f code-review/src/run-dimension.sh && ! test -f code-review/prompts/dimension-base.txt && ! test -f code-review/prompts/coordinator.txt && ! test -f code-review/__tests__/call-openrouter.bats"},
  {"id": "8.4", "title": "post-review.sh consumes merged output (not per-provider raw)", "check": "bats code-review/__tests__/post-review.bats"},
  {"id": "9.1", "title": "All bats tests green", "check": "bats code-review/__tests__/*.bats code-review/__tests__/providers/*/*.bats"},
  {"id": "9.2", "title": "shellcheck --severity=warning clean (find-based recurse)", "check": "find code-review/src -name '*.sh' -exec shellcheck --severity=warning {} +"},
  {"id": "9.3", "title": "action-validator clean", "check": "npx @action-validator/cli code-review/action.yml"},
  {"id": "9.4", "title": "Docker image builds", "check": "docker build -t code-review-action:test code-review/"},
  {"id": "9.5", "title": "Manual smoke test (deferred; not a CI gate)", "check": "true"}
]
```
