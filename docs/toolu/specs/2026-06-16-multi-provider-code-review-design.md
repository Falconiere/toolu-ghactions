# Multi-Provider Code Review — Design

**Date:** 2026-06-16   **Status:** Approved   **Author:** Falconiere   **Topic:** Add a `PROVIDERS` input that accepts a list of `{provider, model, api_key}` entries; run one review per provider in parallel; merge N verdicts into one. Keep legacy single-key inputs working.

## Problem

The action only accepts OpenRouter today. Callers who want a different vendor — or who want **multiple vendors to review the same PR in parallel** (e.g., one Anthropic, one DeepSeek, one OpenRouter) and combine their verdicts — cannot use it. This blocks adoption from teams that already have a preferred provider, and it blocks the "ensemble reviewer" workflow where the merge of N independent reviews is more reliable than any single one. We need a `PROVIDERS` input that takes a list of `{provider, model, api_key}` entries, dispatches one review per provider in parallel, normalizes the per-provider response shape, and merges N verdicts using a configurable strategy. The legacy `OPENROUTER_API_KEY` path must keep working unchanged.

## Non-Goals

1. **Bedrock / Azure OpenAI / Vertex** — locked at 6 providers for v1 (openrouter, openai, anthropic, deepseek, moonshot, minimax). Adding a 7th is a follow-up.
2. **Cross-product fan-out (provider × dimension)** — v1 runs **one call per provider** with the full 7-dim checklist. The existing per-dimension sub-reviewer (`run-dimension.sh`, `REVIEW_MODE: parallel`) is removed. A `MULTI_PROVIDER_MODE=cross_product` flag is post-v1.
3. **Custom base URL per provider** — endpoints are hardcoded to vendor canonicals. Power users who need a proxy can run their own provider fork.
4. **Provider-side auth beyond API keys** — no OAuth, no GitHub App login, no service-account JSON. API key string only.
5. **Multi-modal review** — text diffs only.
6. **Anthropic thinking-mode tuning** — v1 forces `temperature=0.1` everywhere. Anthropic thinking requires `temperature=1.0`; if a user picks a thinking model they get the vendor's default behavior, not a thinking trace.
7. **Streaming responses** — synchronous one-shot per provider call, same as today.
8. **Per-provider rate-limit coordination / quota pooling** — each call is independent; if Anthropic rate-limits, that provider's review fails and is reported; no automatic backoff across providers.
9. **Dynamically chosen model per file** — model is fixed per provider entry for the whole run.
10. **A web UI for choosing providers** — YAML only.

## Architecture

**Per-provider script directories + a provider-aware dispatcher in `main.sh` + a multi-provider merger in `coordinate-findings.sh`.**

Trade-off: explicit per-provider scripts vs a single config-driven generic caller. **Explicit wins** because request-body shapes diverge structurally (Anthropic's `system` is top-level, OpenAI-compatible vendors use `messages[0].role=system`, Gemini is not in our list but if added would be `systemInstruction.parts[].text`). A single generic script with case statements would hit the 300-line ceiling and mix concerns. The cost: 6 small directories instead of 1 file. Worth it.

### Provider directory shape

```
code-review/src/providers/<name>/
├── build-request.sh   # stdin: review-mode envelope; stdout: provider request body JSON
└── call.sh            # stdin: request body; stdout: provider response JSON (raw, unparsed)
```

Two responsibilities per provider: build the request body for that vendor's wire format, and make the HTTP call. `parse-response.sh` (top-level, not per-provider) handles shape normalization. This keeps each provider script under 100 lines.

### Entrypoint flow

`main.sh` reads `INPUT_PROVIDERS` (a JSON array string). If empty, it builds a 1-element array from the legacy `OPENROUTER_API_KEY` + `INPUT_MODEL` + `INPUT_FALLBACK_MODEL` + `INPUT_ENFORCE_JSON_SCHEMA` (back-compat). Then:

1. **Phase 1–2** unchanged: validate env, fetch diff, post in-progress comment.
2. **Phase 3 — Parallel provider reviews (new):** for each entry in the providers array, dispatch a background job:
   - `bash run-provider.sh <entry.json>` — sets `PROVIDER`, `MODEL`, `API_KEY`, `ENFORCE_JSON_SCHEMA`, `MAX_TOKENS` env vars from the entry, then runs `build-prompt.sh | providers/<name>/build-request.sh | providers/<name>/call.sh | parse-response.sh | validate-findings.sh`. **Per-provider validate** anchors each finding to the diff (dropping hallucinated line numbers + low-confidence findings) before the cross-provider merge — so the merger only sees validated findings. Diff is the same for all providers, so dedupe keys remain stable.
   - The job writes `{provider, verdict, findings, review_plan, other_checks, top_must_fix, error?}` to a temp file. `reasoning` is captured by `parse-response.sh` but **dropped before the temp file** — it is per-reviewer metadata, not user-facing.
   - `main.sh` waits on all jobs. A job that fails is recorded as `{provider, error: "..."}` but does not abort the run.
3. **Phase 4 — Multi-provider merge (rewritten `coordinate-findings.sh`):** reads N provider results + `MERGE_STRATEGY` input, dedupes findings across providers (by `path:line` + text similarity), applies the strategy, outputs the final `{verdict, findings, review_plan, other_checks, top_must_fix}` shape.
4. **Phase 5–6** unchanged: format-verdict, post-comment, post-label, post-review.

The per-dim sub-reviewer (`run-dimension.sh`, `coordinate-findings.sh` old behavior, `prompts/dimension-base.txt`) is **removed**. The `REVIEW_MODE: single|parallel` input becomes a no-op kept for back-compat (logs a deprecation hint if non-default).

### Files and responsibilities

```
code-review/
├── action.yml                       # UPDATED: add PROVIDERS, MERGE_STRATEGY inputs
├── Dockerfile                       # unchanged
├── src/
│   ├── main.sh                      # REWRITTEN: dispatch N parallel provider jobs
│   ├── fetch-diff.sh                # unchanged
│   ├── shape-diff.sh                # unchanged
│   ├── build-prompt.sh              # REWRITTEN: provider-agnostic prompt content (was OpenRouter-specific)
│   ├── parse-response.sh            # REWRITTEN: provider-aware normalization prefix
│   ├── coordinate-findings.sh       # REWRITTEN: multi-provider merger
│   ├── validate-findings.sh         # unchanged
│   ├── format-verdict.sh            # unchanged
│   ├── post-comment.sh              # unchanged
│   ├── post-review.sh               # UPDATED: consumes merged findings, not per-provider raw
│   ├── post-label.sh                # unchanged
│   ├── run-provider.sh              # NEW: one provider end-to-end (replaces run-dimension.sh)
│   ├── call-openrouter.sh           # RENAMED → providers/openrouter/call.sh
│   └── providers/                   # NEW directory
│       ├── openrouter/
│       │   ├── build-request.sh
│       │   └── call.sh
│       ├── openai/
│       │   ├── build-request.sh
│       │   └── call.sh
│       ├── anthropic/
│       │   ├── build-request.sh
│       │   └── call.sh
│       ├── deepseek/
│       │   ├── build-request.sh
│       │   └── call.sh
│       ├── moonshot/
│       │   ├── build-request.sh
│       │   └── call.sh
│       └── minimax/
│           ├── build-request.sh
│           └── call.sh
├── prompts/
│   ├── review-checklist.txt         # unchanged (used as system prompt content)
│   ├── dimension-base.txt           # DELETED (per-dim sub-reviewer removed)
│   └── coordinator.txt              # DELETED (LLM coordinator removed; merge is deterministic)
└── __tests__/
    ├── fixtures/
    │   ├── openrouter/              # NEW
    │   │   ├── success.json
    │   │   └── error-401.json
    │   ├── openai/                  # NEW
    │   │   ├── success.json
    │   │   └── error-401.json
    │   ├── anthropic/               # NEW
    │   │   ├── success.json         # shape: {content:[{type:text,text:"..."}]}
    │   │   └── error-401.json
    │   ├── deepseek/                # NEW
    │   │   ├── success.json
    │   │   └── error-401.json
    │   ├── moonshot/                # NEW
    │   │   ├── success.json
    │   │   └── error-401.json
    │   ├── minimax/                 # NEW
    │   │   ├── success.json
    │   │   └── error-401.json
    │   └── merge/                   # NEW
    │       ├── two-providers-approve-changes.json
    │       ├── three-providers-majority-changes.json
    │       └── four-providers-conflicting-severities.json
    ├── build-prompt.bats            # REWRITTEN (provider-agnostic)
    ├── call-openrouter.bats         # RENAMED → providers/openrouter/call.bats
    ├── parse-response.bats          # REWRITTEN (covers all 6 shapes)
    ├── coordinate-findings.bats     # REWRITTEN (multi-provider merge cases)
    ├── main.bats                    # REWRITTEN (parallel dispatch, back-compat)
    ├── run-provider.bats            # NEW
    └── ... (unchanged) fetch-diff.bats, shape-diff.bats, validate-findings.bats, format-verdict.bats, post-comment.bats, post-review.bats, post-label.bats
```

### Merge strategy semantics

`coordinate-findings.sh` takes N `{verdict, findings, ...}` objects + `MERGE_STRATEGY` and produces one:

| Strategy | Verdict rule | Findings output |
|---|---|---|
| `conservative` (default) | `changes` if **any** provider returned `changes`; else `approved` | Union of all findings, deduped by `(path, line, normalized_text)` with severity = max across providers |
| `majority` | `changes` if **`ceil(N/2)+1`** or more providers returned `changes`; else `approved` | Union deduped; severity = max across providers; per-severity vote reported in `other_checks` |
| `all_approve` | `approved` only if **all** providers returned `approved`; else `changes` | Union deduped; severity = max across providers |

Dedupe key: `(path, line, end_line, lowercased-text-fingerprint)` where fingerprint is the first 80 chars of normalized text (lowercased, whitespace-collapsed, punctuation stripped). Two findings from different providers at the same `path:line:end_line` with similar text collapse to one with the **higher** severity. Findings with different `end_line` (e.g., one provider reports a single line, another reports a multi-line span) are **not** deduped — both appear in the merged output. The `category` field is a free-form string from the model, preserved in the merged output, and **not** part of the dedupe key.

The `review_plan` field of the merged output is built deterministically as a markdown string: `"Reviewed by N providers: <list>. Merged with <strategy>."`. The `other_checks` field includes a per-provider agreement summary (`openai: approved, anthropic: changes, deepseek: approved`).

`top_must_fix` aggregation: each provider returns up to 3 items. The merger dedupes the union by finding path, keeps the one with the highest severity, caps the result at 3 items. If providers disagree on a must-fix item's path, each variant is listed.

`INLINE_COMMENTS` interaction: when `INLINE_COMMENTS: true` and N providers run, the action posts inline comments derived from the **merged findings only** — one set of inline comments, sourced from the merger. The post-review.sh script is updated to consume the merged output instead of per-provider outputs. Per-provider raw findings are never posted as inline comments.

A provider that **errored out** (HTTP failure, parse failure) is recorded as `{provider, error: "..."}` and counted as `changes` under `conservative`, as abstained under `majority`, as `changes` under `all_approve`. The verdict comment's "other checks" section names the failed provider and the error so the reader can see why the verdict was set.

## Interfaces / Schema

### `action.yml` (new + changed inputs)

```yaml
inputs:
  # New: primary multi-provider input
  providers:
    description: |
      Multiline YAML/JSON array of provider entries. Each entry has:
        provider: openrouter | openai | anthropic | deepseek | moonshot | minimax
        model: <vendor model id>
        api_key: <string>
        enforce_json_schema: true | false  (optional, default: true)
      When set, this takes precedence over the legacy single-provider inputs.
    required: false

  # New: how to merge N verdicts
  merge_strategy:
    description: |
      conservative = any provider "changes" wins (default, safest).
      majority = ceil(N/2)+1 "changes" wins.
      all_approve = all providers must say "approved".
    required: false
    default: 'conservative'

  # Legacy (back-compat): all still accepted. Used only when PROVIDERS is empty.
  # Behavior is unchanged from v1.0 unless noted.
  openrouter-api-key:
    required: false   # was: true
    # When PROVIDERS is unset, builds a 1-element openrouter entry. FALLBACK_MODEL is dropped.
  model:
    required: false
    # Passed as the `model` field of the auto-built 1-element entry.
  fallback-model:
    required: false
    # SILENTLY DROPPED. The legacy `models[]` array was OpenRouter-only; multi-provider IS the fallback.
    # Deprecation hint is logged once per run when set.
  enforce-json-schema:
    required: false
    # Passed as `enforce_json_schema` on the auto-built entry.
  review-mode:
    required: false
    # NO-OP. Accepted but ignored. Non-default values log a deprecation hint.
  review-prompt-file:
    required: false
    # Unchanged. The custom checklist is used as the system prompt content for all providers.
  codebase-overview:
    required: false
    # Unchanged. Injected into the user prompt for all providers.
  base-branch:
    required: false
    # Unchanged. Resolved by fetch-diff.sh.
  inline-comments:
    required: false
    # CHANGED. With N providers, inline comments are derived from the MERGED findings only.
    # One set of inline comments, sourced from the merger. Per-provider raw findings are not posted.
  manage-labels:
    required: false
    # Unchanged. Single verdict label applied as before.
  max-files:
    required: false
    # Unchanged. Single skip threshold applied before any provider runs.
  max-diff-lines:
    required: false
    # Unchanged. Truncation applied once, before any provider runs.
  max-tokens:
    required: false
    # Used as the DEFAULT for the per-entry `max_tokens` field. Per-entry value overrides.
    # Precedence: per-entry `max_tokens` > `MAX_TOKENS` input > 4096.
  token:
    required: false
    # Unchanged. Single GitHub token used for all comment + label + review API calls.
```

### `PROVIDERS` input format

A multiline string containing a **JSON array** (NOT YAML — `jq` parses the input and YAML is not valid JSON). The `api_key` value supports the standard GitHub Actions `${{ secrets.X }}` interpolation inside multiline `with:` blocks (a known and accepted pattern; secrets are auto-masked in CI logs).

Entry shape:
- `provider` (required) — one of `openrouter | openai | anthropic | deepseek | moonshot | minimax`
- `model` (required) — vendor model id (e.g., `minimax/minimax-m3`, `claude-sonnet-4-5`, `gpt-4o`, `deepseek-chat`)
- `api_key` (required) — the API key string (or `${{ secrets.X }}` reference)
- `enforce_json_schema` (optional, default `true`) — request strict JSON output
- `max_tokens` (optional, default `4096`) — per-entry response budget. Anthropic requires this; other providers treat it as the response cap

```yaml
- uses: falconiere/toolu-ghactions/code-review@v1
  with:
    providers: |
      [
        {"provider": "openrouter", "model": "minimax/minimax-m3", "api_key": "${{ secrets.OPENROUTER_API_KEY }}"},
        {"provider": "anthropic",  "model": "claude-sonnet-4-5", "api_key": "${{ secrets.ANTHROPIC_API_KEY }}"},
        {"provider": "deepseek",   "model": "deepseek-chat",    "api_key": "${{ secrets.DEEPSEEK_API_KEY }}"}
      ]
    merge_strategy: conservative
```

Single-provider shorthand (back-compat) — leave `PROVIDERS` unset and pass legacy inputs:

```yaml
- uses: falconiere/toolu-ghactions/code-review@v1
  with:
    OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
    MODEL: 'minimax/minimax-m3'
```

This is internally translated to `PROVIDERS=[{provider: openrouter, model: minimax/minimax-m3, api_key: ..., enforce_json_schema: true}]`. `FALLBACK_MODEL` is **dropped** (the legacy `models[]` fallback was an OpenRouter-only feature; multi-provider IS the fallback now). A deprecation log line is emitted.

### Per-provider wire format summary

| Provider | Endpoint | Auth header | System prompt location | Structured output |
|---|---|---|---|---|
| `openrouter` | `POST https://openrouter.ai/api/v1/chat/completions` | `Authorization: Bearer $API_KEY` | `messages[0]` (`role: system`) | `response_format: {type: json_schema, json_schema: {...}}` when `enforce_json_schema: true` |
| `openai` | `POST https://api.openai.com/v1/chat/completions` | `Authorization: Bearer $API_KEY` | `messages[0]` (`role: system`) | `response_format: {type: json_schema, ...}` (strict) when `enforce_json_schema: true` |
| `anthropic` | `POST https://api.anthropic.com/v1/messages` | `x-api-key: $API_KEY` + `anthropic-version: 2023-06-01` | top-level `system` field (not in `messages[]`) | `tools: [{name: submit_review, input_schema: <schema>}]` + `tool_choice: {type: tool, name: submit_review}` when `enforce_json_schema: true`; falls back to prompt-only JSON when `false` |
| `deepseek` | `POST https://api.deepseek.com/v1/chat/completions` | `Authorization: Bearer $API_KEY` | `messages[0]` (`role: system`) | `response_format: {type: json_object}` (free-form JSON, not strict schema) when `enforce_json_schema: true` |
| `moonshot` | `POST https://api.moonshot.ai/v1/chat/completions` | `Authorization: Bearer $API_KEY` | `messages[0]` (`role: system`) | `response_format: {type: json_object}` when `enforce_json_schema: true` |
| `minimax` | `POST https://api.minimax.io/v1/chat/completions` | `Authorization: Bearer $API_KEY` | `messages[0]` (`role: system`) | `response_format: {type: json_object}` when `enforce_json_schema: true` |

Anthropic-specific request differences:
- `max_tokens` is **required**, default 4096 (matches `MAX_TOKENS` input).
- `messages` contains only `user`/`assistant` turns; system goes top-level.
- Response shape: `{content: [{type: "text", text: "..."}, ...], stop_reason, usage}`. There may also be `{type: "thinking", thinking: "..."}` blocks which `parse-response.sh` skips.

OpenAI / OpenRouter / DeepSeek / Moonshot / MiniMax share the `choices[0].message.content` response shape. They differ in whether they accept strict json_schema. The build-request scripts encode this.

**Per-provider temperature defaults** (set by `build-request.sh` from a per-provider table):

| Provider | Default temperature | Rationale |
|---|---|---|
| `openrouter` | `0.1` | OpenRouter best practice; low noise. |
| `openai` | `0.1` | Same. |
| `anthropic` | `0.0` | Anthropic deterministic mode; consistent with "be specific, cite exact paths". Avoids the 1.0 required by thinking models (we don't expose thinking mode in v1). |
| `deepseek` | `0.1` | Same as openrouter. |
| `moonshot` | `0.1` | Same. |
| `minimax` | `0.1` | Same. |

**Per-provider response parsing paths** (used by `parse-response.sh`, dispatched on `PROVIDER` env var):

| Provider | Response JSON path | Notes |
|---|---|---|
| `openrouter`, `openai`, `deepseek`, `moonshot`, `minimax` | `.choices[0].message.content` | Shared. |
| `anthropic` (default, `enforce_json_schema: false`) | `.content[?(@.type=="text")].text \| [0]` | Skips `thinking` blocks. |
| `anthropic` (`enforce_json_schema: true`) | `.content[?(@.type=="tool_use" and @.name=="submit_review")].input` | Tool-use input IS the review JSON. Falls back to text-block path if tool_use absent. |

### Normalized provider result shape

Every `call.sh` output is normalized by `parse-response.sh` to:

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-5",
  "verdict": "approved" | "changes",
  "findings": [
    {
      "path": "src/auth.ts",
      "line": 42,
      "end_line": 42,
      "severity": "blocker" | "high" | "medium" | "low" | "nit",
      "category": "security",
      "confidence": "high" | "medium" | null,
      "quoted_line": "...",
      "suggestion": "...",
      "text": "SQL injection: ..."
    }
  ],
  "review_plan": "",
  "reasoning": "",
  "other_checks": "",
  "top_must_fix": []
}
```

If a provider's call **errors** (HTTP non-2xx after retries, non-JSON response, embedded error), the normalized output is:

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-5",
  "error": "OpenAI authentication failed",
  "verdict": null,
  "findings": []
}
```

The merger treats `verdict: null` as "this provider abstained / errored" per the rules in the merge strategy table.

### Coordinator merge input/output

`coordinate-findings.sh` stdin (new shape):

```json
{
  "providers": [
    {"provider": "openrouter", "verdict": "approved", "findings": [...], "other_checks": "..."},
    {"provider": "anthropic",  "verdict": "changes", "findings": [...], "other_checks": "..."},
    {"provider": "deepseek",   "error": "rate limited", "verdict": null, "findings": []}
  ],
  "strategy": "conservative"
}
```

stdout (unchanged outer shape — same fields `format-verdict.sh`, `post-comment.sh`, `post-review.sh`, `post-label.sh` already consume):

```json
{
  "verdict": "changes",
  "findings": [...],
  "review_plan": "Reviewed by 3 providers: openrouter, anthropic, deepseek. Merged with conservative (deepseek errored: rate limited).",
  "other_checks": "Per-provider: openrouter=approved, anthropic=changes, deepseek=error. Deduped 4 findings into 3.",
  "top_must_fix": ["src/auth.ts:42 — SQL injection"]
}
```

Note: `reasoning` is **dropped** from the merge output. `validate-findings.sh` is not in the new pipeline (it runs per-provider, inside `run-provider.sh`, before the merge input is assembled).

### Backwards-compat translation

`main.sh` resolution order on entry:

```
1. If INPUT_PROVIDERS is set and non-empty JSON array → use it (parse, validate entries, dispatch)
2. Else if INPUT_OPENROUTER_API_KEY is set → build [{provider: openrouter, model: $INPUT_MODEL, api_key: $INPUT_OPENROUTER_API_KEY, enforce_json_schema: $INPUT_ENFORCE_JSON_SCHEMA}] and dispatch
   - Log a deprecation hint: "OPENROUTER_API_KEY is the legacy single-provider input; prefer PROVIDERS for multi-provider configurations"
3. Else → fail with clear message: "Set PROVIDERS (preferred) or OPENROUTER_API_KEY (legacy)"
```

`FALLBACK_MODEL` is **silently dropped** in the legacy path (it was OpenRouter-specific; multi-provider IS the fallback now). The deprecation hint mentions this.

`REVIEW_MODE` (legacy) is **silently accepted but ignored** unless set to a non-default value, in which case a deprecation log line points to the new model.

**Both PROVIDERS and legacy set:** if `INPUT_PROVIDERS` is set and `INPUT_OPENROUTER_API_KEY` is also set, `PROVIDERS` wins and the legacy inputs are ignored with a log line: `OPENROUTER_API_KEY (and other legacy single-provider inputs) ignored; using PROVIDERS`. This prevents silent override confusion for users migrating from v1.0.

### Test strategy

Hermetic bats tests; **no mocks, recorded fixtures only**. For each provider, two fixtures are recorded: a successful response and an error response. The `curl` boundary is replaced by a stub that replays the fixture (same pattern as today's `call-openrouter.bats`).

- `code-review/__tests__/providers/<name>/call.bats` — 1 success + 1 error case per provider, asserting exit code, stderr, stdout shape.
- `code-review/__tests__/providers/<name>/build-request.bats` — asserts the request body matches the expected per-vendor shape (e.g., Anthropic request has top-level `system`, OpenAI request has `messages[0].role=system`).
- `code-review/__tests__/parse-response.bats` — one subtest per provider, asserts normalized shape from each vendor's raw response shape.
- `code-review/__tests__/coordinate-findings.bats` — 3 strategies × 3 cases (2-providers / 3-providers / 4-providers) × 3 conflict shapes (unanimous / one-disagrees / majority-flips) = 27 cases. Plus 1 case per provider erroring out.
- `code-review/__tests__/main.bats` — back-compat: 1 test asserts legacy `OPENROUTER_API_KEY` flow still works; 1 test asserts `PROVIDERS` flow dispatches N jobs in parallel.
- `code-review/__tests__/run-provider.bats` — 1 happy path per provider.

**Fixture recording process:** a developer records fixtures by running the action once with a real API key against a real provider, captures the HTTP exchange via a local proxy, sanitizes, and commits the JSON to `__tests__/fixtures/<provider>/`. This is documented in `CONTRIBUTING.md` (new section). Fixture data must be real — no synthetic model responses.

**Fixture pair convention:** merge test fixtures are input + expected pairs:
- `merge/<case>.json` — the input (N provider results + strategy)
- `merge/<case>.expected.json` — the expected merger output

Per-provider call/build fixtures are a single `success.json` (raw HTTP response) and `error-<code>.json` (raw HTTP error response). The bats test asserts exit code, stderr redaction, and stdout shape (parsed via `jq`).

**Real-data discipline:** no mocked model responses, no fabricated findings, no fake JSON for `success.json`. If a provider's real response is non-JSON (e.g., Anthropic thinking-block-only response), record the real response and let the bats test assert the regex-fallback path.

### Conventions carried forward

- **One responsibility per file** — each provider script is ≤100 lines (well under the 300-line ceiling).
- **Test strategy** — bats + real recorded fixtures; no mocks. Each provider gets a fixtures directory.
- **Doc lines** — every script header gets a concise comment explaining its job and stdin/stdout contract.
- **Docs in sync** — this spec touches the README (new `PROVIDERS` example, deprecation note for legacy), `action.yml` (input changes), `CONTRIBUTING.md` (new "Recording provider fixtures" section), and `CHANGELOG.md` (release-please will generate the entry from the conventional commit). All updated in the same change.
- **Size discipline** — provider scripts are small; `main.sh` grows but stays under 300 lines because the per-provider dispatch loop is generic. `coordinate-findings.sh` grows to ~150 lines (was ~50) but is still under the limit.

## Acceptance Criteria

Testable against real recorded fixtures and real workflow runs.

1. **Multi-provider dispatch** — Given `PROVIDERS` with 2 entries (openrouter + anthropic), `main.sh` spawns 2 background `run-provider.sh` jobs, both complete, and `coordinate-findings.sh` receives both results.
2. **Per-provider success** — Given a valid OpenAI key + `gpt-4o`, `providers/openai/call.sh` returns 200 + valid JSON within 120s; `parse-response.sh` normalizes to `{verdict, findings, ...}`.
3. **Anthropic system-prompt placement** — Given `providers/anthropic/build-request.sh` and a system prompt, the request body has `system` at the top level (not in `messages[]`) and `messages[]` contains only user/assistant turns.
4. **Anthropic tool-use for structured output** — Given `enforce_json_schema: true` and an Anthropic entry, the request body includes `tools: [{name: submit_review, input_schema: <schema>}]` and `tool_choice: {type: tool, name: submit_review}`.
5. **Anthropic thinking-block skip** — Given a response containing `{content: [{type: thinking, ...}, {type: text, text: "..."}]}`, `parse-response.sh` extracts only the text block.
6. **Per-provider error** — Given an invalid Anthropic key, `providers/anthropic/call.sh` exits non-zero with a redacted error JSON; the provider result is `{provider: anthropic, error: "..."}`.
7. **OpenAI-compat vendor shared shape** — Given identical system + user prompts, `providers/{openai,deepseek,moonshot,minimax,openrouter}/build-request.sh` all produce bodies that are JSON-valid and contain `messages[0].role: "system"`.
8. **OpenAI strict schema** — Given `enforce_json_schema: true` and an OpenAI entry, the request body has `response_format: {type: json_schema, json_schema: {strict: true, schema: ...}}`.
9. **OpenAI-compat free-form JSON** — Given `enforce_json_schema: true` and a DeepSeek / Moonshot / MiniMax entry, the request body has `response_format: {type: json_object}` (not `json_schema`).
10. **Back-compat single-provider** — Given `OPENROUTER_API_KEY` set and `PROVIDERS` empty, `main.sh` dispatches exactly 1 background job (openrouter), logs a deprecation hint, and the run completes with the same verdict format as v1.0.
11. **Back-compat FALLBACK_MODEL dropped** — Given `FALLBACK_MODEL` set in legacy mode, the log line names it as dropped; no `models[]` array is built.
12. **REVIEW_MODE deprecation** — Given `REVIEW_MODE: parallel` (or any non-default), `main.sh` logs a one-line deprecation hint and proceeds; the value is otherwise ignored.
13. **Merge conservative (default)** — Given providers A=approved, B=changes, C=error, the merged verdict is `changes`; findings are unioned with dedupe; `other_checks` lists A=approved, B=changes, C=error.
14. **Merge majority** — Given 3 providers (2 changes, 1 approved), `MERGE_STRATEGY=majority` produces `changes`. Given 3 providers (1 changes, 2 approved), produces `approved`. Given 2 providers (1 changes, 1 approved), produces `approved` (ceil(2/2)+1 = 2 needed, only 1 has it).
15. **Merge all_approve** — Given 2 providers (1 changes, 1 approved), produces `changes`. Given 3 providers all `approved`, produces `approved`.
16. **Provider error counts as changes (conservative / all_approve)** — Given 1 provider OK + 1 errored, `conservative` and `all_approve` produce `changes`; the verdict comment names the errored provider and the error.
17. **Provider error abstains (majority)** — Given 1 provider says changes + 1 errors + 1 approves, `majority` produces `approved` (1 change, 0 valid approvals vs 1 change, 1 valid approval = tie → approved because abstention doesn't count).
18. **Dedupe key** — Given two providers report the same finding at `src/auth.ts:42` with severity `medium` and `high`, the merged finding has severity `high` (max) and appears once.
19. **Dedupe text fingerprint** — Given two findings at the same `path:line` with text differing only in whitespace and punctuation, they collapse to one.
20. **No cross-path dedupe** — Given the same text at `auth.ts:42` and `users.ts:42`, both appear in the merged output.
21. **Output shape unchanged** — `coordinate-findings.sh` stdout matches the existing `{verdict, findings, review_plan, other_checks, top_must_fix}` shape consumed by `format-verdict.sh` and `post-*.sh`. No downstream script needs to change.
22. **All 6 providers ship with fixtures** — `__tests__/fixtures/{openrouter,openai,anthropic,deepseek,moonshot,minimax}/` each contain a `success.json` and an `error-*.json` recorded from a real API call.
23. **Lint clean** — `shellcheck --severity=warning code-review/src/**/*.sh` returns 0.
24. **Marketplace action-yml valid** — `npx @action-validator/cli code-review/action.yml` returns 0.
25. **README updated** — `README.md` has a "Multiple providers" example with a `PROVIDERS` block, the `merge_strategy` table, and a "Legacy single-provider" note pointing to the new input.
26. **CONTRIBUTING updated** — `CONTRIBUTING.md` has a "Recording provider fixtures" section with the proxy-based capture workflow.
27. **Marketplace deprecation safety** — When a user upgrades from v1.2.x to v1.3.x with only legacy inputs, the action runs unchanged. No silent failure.
28. **INLINE_COMMENTS with N providers** — Given `INLINE_COMMENTS: true` and 3 providers, the action posts inline comments derived from the **merged findings only**. Per-provider raw findings are not posted as inline comments; only one set of inline comments appears.
29. **Validate runs per-provider** — Given 3 providers, the new pipeline runs `validate-findings.sh` 3 times (once per provider) before the merge. The merger only sees validated findings.
30. **max_tokens per-provider** — Given a PROVIDERS entry with `max_tokens: 8192` for Anthropic, the Anthropic request body has `max_tokens: 8192`. When the entry omits `max_tokens`, the value falls back to `$MAX_TOKENS` input (default 4096). Precedence: per-entry `max_tokens` > `MAX_TOKENS` input > 4096.
31. **Top-must-fix aggregation** — Given 3 providers each with `top_must_fix: ["a", "b", "c"]` (disjoint paths), the merged `top_must_fix` has 3 items. Given overlapping paths with different severities, the higher-severity item wins. Result is capped at 3.
32. **Reasoning dropped from merge** — Given 3 providers with non-empty `reasoning` strings, the merged output's `reasoning` field is absent or empty. The `other_checks` field is the only place per-provider context surfaces.
33. **end_line in dedupe key** — Given provider A reports `auth.ts:42-42` and provider B reports `auth.ts:42-50` for the same text, both appear in the merged output (different end_line → no dedupe). Given A reports `auth.ts:42-42` and B reports `auth.ts:42-42` for similar text, they collapse to one with max severity.
34. **Category preserved, not deduped** — Given provider A reports `category: "security"` and provider B reports `category: "injection"` for the same finding, the merged finding's `category` is one of the two (deterministic pick — first provider wins); the dedupe key does not include category.
35. **Anthropic tool_use extraction** — Given an Anthropic response with `content: [{type: "thinking", thinking: "..."}, {type: "tool_use", name: "submit_review", input: {verdict: "approved", findings: [...]}}]`, `parse-response.sh` extracts `input` (the review JSON) and ignores both the thinking block and any text block.
36. **Both PROVIDERS and legacy set** — Given both `PROVIDERS` and `OPENROUTER_API_KEY` set, the action uses `PROVIDERS`, logs a one-line warning naming the ignored legacy input, and proceeds.

## Open Questions

1. **Anthropic structured output: tool-use vs prompt-only** — *Owner: Falconiere.* v1 spec picks tool-use when `enforce_json_schema: true`. If a user reports tool-call failures on certain Anthropic models (some legacy models don't support tool use), fallback path is to drop `tools` and rely on prompt+regex. This is a per-call decision; `build-request.sh` can branch on model name. Decide during implementation based on which Anthropic models support tools. If unclear, ship with `enforce_json_schema: true` default for Anthropic that uses tool-use, and add a model capability allowlist.
2. **DeepSeek / Moonshot / MiniMax free-form JSON quality** — *Owner: Falconiere.* These vendors don't accept strict `json_schema`; we use `response_format: {type: json_object}`. The model is asked to output JSON matching our schema, but the response can be malformed. The `parse-response.sh` regex fallback (already in place) handles this, but the quality may be lower than OpenAI's strict mode. Decide during implementation: are the regex fallback findings acceptable, or do we need per-vendor retry policies? Most likely: ship v1 with the existing fallback and iterate.
3. **`PROVIDERS` secret masking in CI logs** — *Owner: Falconiere.* GitHub Actions masks `${{ secrets.X }}` references in logs. When the `api_key` field is a `${{ secrets.X }}` literal, it gets masked. But if a user pastes a raw key (don't do this), no masking. Document the recommended pattern; don't enforce it in code.
4. **Provider rate limits across parallel jobs** — *Owner: Falconiere.* A 4-provider run fires 4 simultaneous outbound HTTPS requests. If a provider rate-limits one, only that provider fails (others complete); the merger handles the partial result. No global coordination. If users hit problems, a `PROVIDER_CONCURRENCY` input can serialize in v1.1. Ship without it; add if needed.
5. **Cross-product fan-out (provider × dimension)** — *Owner: post-v1.* This spec removes the per-dimension sub-reviewer. If users want 6 providers × 4 dimensions = 24 calls for highest quality, that's a `MULTI_PROVIDER_MODE=cross_product` input in a follow-up. Out of v1 scope; non-goal #2.
6. **Merged verdict label** — *Owner: Falconiere (resolved).* Each provider's individual verdict IS listed in the `other_checks` section of the verdict comment (see AC 13). The merged verdict label (`` `agent-merge-approved` `` or `` `agent-request-changes` ``) follows the strategy. If users find the per-provider breakdown noisy, a `SHOW_PROVIDER_RESULTS: false` input can suppress it in v1.1.
7. **Moonshot regional endpoint** — *Owner: Falconiere.* `https://api.moonshot.ai/v1` vs `https://api.moonshot.cn/v1`. v1 uses `.ai` (international). Document the `.cn` option in a follow-up if users request it; v1 ships `.ai` only.
8. **Minimax regional endpoint** — *Owner: Falconiere.* `https://api.minimax.io/v1` (international) vs `https://api.minimaxi.com/v1` (China). v1 uses `.io`. Same as #7.
