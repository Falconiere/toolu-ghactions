#!/usr/bin/env bash
# main.sh — entrypoint for the AI Code Review GitHub Action.
#
# Reads $INPUT_PROVIDERS (a JSON array of {provider, model, api_key} entries).
# Falls back to legacy single-provider inputs (OPENROUTER_API_KEY + MODEL + MAX_TOKENS
# + ENFORCE_JSON_SCHEMA) when PROVIDERS is empty.
#
# Pipeline (multi-provider):
#   1. Validate env
#   2. Fetch diff + post in-progress comment
#   3. Spawn N parallel `run-provider.sh` jobs (one per provider entry)
#   4. Merge N results via `coordinate-findings.sh` (with $INPUT_MERGE_STRATEGY)
#   5. Format verdict, post comment + label + inline review
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GITHUB_OUTPUT="${GITHUB_OUTPUT:-/dev/stdout}"
MERGE_STRATEGY="${INPUT_MERGE_STRATEGY:-conservative}"

REVIEW_START_TIME=$(date +%s)
export REVIEW_START_TIME

# --- Helper: post an error comment and exit, surfacing child diagnostics ---
fail() {
    local message="$1"
    local detail="${2:-}"
    echo "[ERROR] $message" >&2
    [ -n "$detail" ] && echo "--- detail ---" >&2 && echo "$detail" >&2

    if [ -f "$SCRIPT_DIR/post-comment.sh" ] && [ -n "${GITHUB_TOKEN:-}" ]; then
        ERROR_BODY="**AI Code Review failed** —— [View job](${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-unknown}/actions/runs/${GITHUB_RUN_ID:-?})

---
### Code Review — error

- [x] Read repository context and PR diff
- [ ] Review changed files
- [ ] Analyze correctness, security, performance
- [ ] Post findings

**Error:** $message

\`agent-request-changes\`
"
        COMMENT_URL=$(echo "$ERROR_BODY" | bash "$SCRIPT_DIR/post-comment.sh" || echo "")
        [ -n "$COMMENT_URL" ] && echo "comment-url=$COMMENT_URL" >> "$GITHUB_OUTPUT"
        bash "$SCRIPT_DIR/post-label.sh" error || true
    fi

    echo "verdict=error" >> "$GITHUB_OUTPUT"
    echo "findings-count=0" >> "$GITHUB_OUTPUT"
    exit 1
}

# --- Phase 1: Build the providers list (multi or legacy) ---
build_providers_list() {
    # Translate INPUT_OPENROUTER_API_KEY → OPENROUTER_API_KEY (legacy action.yml env mapping).
    if [ -z "${OPENROUTER_API_KEY:-}" ] && [ -n "${INPUT_OPENROUTER_API_KEY:-}" ]; then
        export OPENROUTER_API_KEY="$INPUT_OPENROUTER_API_KEY"
    fi

    if [ -n "${INPUT_PROVIDERS:-}" ]; then
        # If legacy OPENROUTER_API_KEY is also set, warn and use PROVIDERS.
        if [ -n "${OPENROUTER_API_KEY:-}" ]; then
            echo "[WARN] OPENROUTER_API_KEY (and other legacy single-provider inputs) ignored; using PROVIDERS" >&2
        fi
        if ! echo "$INPUT_PROVIDERS" | jq -e 'type == "array" and length > 0' >/dev/null 2>&1; then
            echo "INPUT_PROVIDERS is set but is not a non-empty JSON array." >&2
            return 1
        fi
        echo "$INPUT_PROVIDERS"
        return 0
    fi

    # Legacy: build a 1-element list.
    if [ -n "${OPENROUTER_API_KEY:-}" ]; then
        echo "[WARN] OPENROUTER_API_KEY is the legacy single-provider input; prefer PROVIDERS for multi-provider configurations" >&2
        [ -n "${INPUT_FALLBACK_MODEL:-}" ] && echo "[WARN] FALLBACK_MODEL is dropped (was OpenRouter-specific; multi-provider IS the fallback)" >&2
        [ -n "${INPUT_REVIEW_MODE:-}" ] && [ "${INPUT_REVIEW_MODE}" != "single" ] && echo "[WARN] REVIEW_MODE is a no-op; multi-provider replaces per-dim fan-out" >&2
        jq -nc --arg model "${INPUT_MODEL:-minimax/minimax-m3}" \
                  --arg key "${OPENROUTER_API_KEY}" \
                  --argjson enforce "${INPUT_ENFORCE_JSON_SCHEMA:-true}" \
                  --argjson maxtok "${INPUT_MAX_TOKENS:-4096}" \
            '[{provider: "openrouter", model: $model, api_key: $key, enforce_json_schema: $enforce, max_tokens: $maxtok}]'
        return 0
    fi

    echo "Set PROVIDERS (preferred) or OPENROUTER_API_KEY (legacy) before running this action." >&2
    return 1
}

PROVIDERS_LIST=$(build_providers_list) || fail "No providers configured"
N=$(echo "$PROVIDERS_LIST" | jq 'length')
echo "Configured $N provider(s): $(echo "$PROVIDERS_LIST" | jq -r '[.[].provider] | join(", ")')" >&2

[ -n "${GITHUB_TOKEN:-}" ] || fail "GITHUB_TOKEN is not set"

# --- Phase 2: Fetch diff ---
echo "[1/5] Fetching PR diff..." >&2
DIFF_ERR=$(mktemp)
DIFF_DATA=$(bash "$SCRIPT_DIR/fetch-diff.sh" 2>"$DIFF_ERR") || fail "Failed to fetch PR diff" "$(cat "$DIFF_ERR")"

# Guard: fetch-diff always prints a JSON object on success (even the skip/empty
# cases). Empty stdout means an exit-0 path forgot to emit — fail loudly here
# rather than feeding "" into the jq calls below (which would surface as the
# cryptic "invalid JSON text passed to --argjson").
if [ -z "${DIFF_DATA//[[:space:]]/}" ]; then
    fail "Diff fetch produced no output" "$(cat "$DIFF_ERR")"
fi

SKIP_ERROR=$(echo "$DIFF_DATA" | jq -r '.error // ""' || true)
if [ -n "$SKIP_ERROR" ]; then
    echo "[SKIP] $SKIP_ERROR" >&2
    echo "verdict=skip" >> "$GITHUB_OUTPUT"
    echo "findings-count=0" >> "$GITHUB_OUTPUT"
    SKIP_BODY="**AI Code Review skipped** —— [View job](${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-unknown}/actions/runs/${GITHUB_RUN_ID:-?})

---
### Code Review — skipped

**Skipped:** $SKIP_ERROR
"
    SKIP_URL=$(echo "$SKIP_BODY" | bash "$SCRIPT_DIR/post-comment.sh" || echo "")
    [ -n "$SKIP_URL" ] && echo "comment-url=$SKIP_URL" >> "$GITHUB_OUTPUT"
    exit 0
fi

TOTAL_FILES=$(echo "$DIFF_DATA" | jq -r '.total_files // 0')
if [ "$TOTAL_FILES" -eq 0 ]; then
    echo "[SKIP] No file changes to review" >&2
    echo "verdict=skip" >> "$GITHUB_OUTPUT"
    echo "findings-count=0" >> "$GITHUB_OUTPUT"
    NOOP_BODY="**AI Code Review finished** —— [View job](${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-unknown}/actions/runs/${GITHUB_RUN_ID:-?})

---
### Code Review — \`${GITHUB_HEAD_REF:-unknown}\`

**No file changes to review.** 🎉

\`agent-merge-approved\`
"
    NOOP_URL=$(echo "$NOOP_BODY" | bash "$SCRIPT_DIR/post-comment.sh" || echo "")
    [ -n "$NOOP_URL" ] && echo "comment-url=$NOOP_URL" >> "$GITHUB_OUTPUT"
    bash "$SCRIPT_DIR/post-label.sh" approved || true
    exit 0
fi

echo "  Files: $TOTAL_FILES, Lines: $(echo "$DIFF_DATA" | jq -r '.total_lines')" >&2

# --- In-progress comment (best-effort) ---
IN_PROGRESS_BODY="**AI Code Review running** —— [View job](${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-unknown}/actions/runs/${GITHUB_RUN_ID:-?})

---
### PR Review in Progress

- [ ] Read repository context and PR diff
- [ ] Review changed files
- [ ] Analyze correctness, security, performance
- [ ] Post findings
- [ ] Set verdict label
"
echo "$IN_PROGRESS_BODY" | bash "$SCRIPT_DIR/post-comment.sh" >/dev/null || echo "  Warning: could not post in-progress comment" >&2

# --- Phase 3: Parallel provider reviews ---
echo "[2/5] Parallel provider reviews (strategy: $MERGE_STRATEGY)..." >&2
TMPD=$(mktemp -d)
trap 'rm -rf "$TMPD"' EXIT
declare -A PID
declare -A ERR_TMP

for i in $(seq 0 $((N - 1))); do
    ENTRY=$(echo "$PROVIDERS_LIST" | jq -c ".[$i]")
    OUT="$TMPD/result-$i.json"
    ERR_FILE="$TMPD/err-$i.log"
    ERR_TMP[$i]="$ERR_FILE"
    ENTRY_FILE="$TMPD/entry-$i.json"
    printf '%s' "$ENTRY" > "$ENTRY_FILE"
    (
        echo "$DIFF_DATA" | bash "$SCRIPT_DIR/run-provider.sh" "$ENTRY_FILE" "$OUT" >/dev/null 2>"$ERR_FILE"
    ) &
    PID[$i]=$!
done

# Wait on all jobs; non-zero exit is recorded as {provider, error} by run-provider.sh.
OK=0
for i in $(seq 0 $((N - 1))); do
    if wait "${PID[$i]}"; then
        OK=$((OK + 1))
    else
        RC=$?
        ENTRY=$(echo "$PROVIDERS_LIST" | jq -c ".[$i]")
        PROVIDER_NAME=$(echo "$ENTRY" | jq -r '.provider')
        MODEL_NAME=$(echo "$ENTRY" | jq -r '.model')
        ERR_TAIL=$(tail -c 200 "${ERR_TMP[$i]}" 2>/dev/null | tr '\n' ' ' | head -c 200)
        jq -nc --arg p "$PROVIDER_NAME" --arg m "$MODEL_NAME" --arg e "job exited $RC: $ERR_TAIL" \
            '{provider:$p, model:$m, error:$e, verdict:null, findings:[]}' > "$TMPD/result-$i.json"
        echo "  [warn] provider '$PROVIDER_NAME' failed: $ERR_TAIL" >&2
    fi
done
echo "  $OK/$N provider jobs succeeded" >&2

# --- Phase 4: Merge N results ---
MERGE_INPUT=$(jq -nc \
    --argjson providers "$(jq -c -s '.' "$TMPD"/result-*.json)" \
    --arg strategy "$MERGE_STRATEGY" \
    '{providers: $providers, strategy: $strategy}')

MERGE_ERR=$(mktemp)
PARSED=$(echo "$MERGE_INPUT" | bash "$SCRIPT_DIR/coordinate-findings.sh" 2>"$MERGE_ERR") || fail "Multi-provider merge failed" "$(cat "$MERGE_ERR")"

VERDICT=$(echo "$PARSED" | jq -r '.verdict // "changes"')
FINDINGS_COUNT=$(echo "$PARSED" | jq '.findings | length')
echo "[3/5] Verdict: $VERDICT, Findings: $FINDINGS_COUNT" >&2

# --- Phase 5: Format + post summary comment ---
echo "[4/5] Posting verdict comment..." >&2
FMT_ERR=$(mktemp)
COMMENT_BODY=$(echo "$PARSED" | bash "$SCRIPT_DIR/format-verdict.sh" 2>"$FMT_ERR") || fail "Failed to format verdict comment" "$(cat "$FMT_ERR")"
POST_ERR=$(mktemp)
COMMENT_URL=$(echo "$COMMENT_BODY" | bash "$SCRIPT_DIR/post-comment.sh" 2>"$POST_ERR") || fail "Failed to post verdict comment" "$(cat "$POST_ERR")"

# Set the real verdict label on the PR (non-fatal).
bash "$SCRIPT_DIR/post-label.sh" "$VERDICT" || echo "  Warning: could not set verdict label" >&2

# --- Phase 6: Inline review comments + suggestions (non-fatal) ---
# Always consumes the MERGED findings only — never per-provider raw output.
echo "[5/5] Posting inline review comments..." >&2
echo "$PARSED" | bash "$SCRIPT_DIR/post-review.sh" || echo "  Warning: inline review step failed (summary comment still posted)" >&2

# --- Outputs ---
echo "verdict=$VERDICT" >> "$GITHUB_OUTPUT"
echo "findings-count=$FINDINGS_COUNT" >> "$GITHUB_OUTPUT"
echo "comment-url=$COMMENT_URL" >> "$GITHUB_OUTPUT"

echo "Review complete: $VERDICT ($FINDINGS_COUNT findings) — $COMMENT_URL" >&2
exit 0
