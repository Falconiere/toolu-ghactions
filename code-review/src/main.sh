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

# --- Custom identity: mint a GitHub App installation token when APP_ID +
# APP_PRIVATE_KEY are provided. All downstream API calls (comments, reviews,
# labels, reactions) inherit it through GITHUB_TOKEN, so the bot posts as the
# App. Absent/misconfigured creds fall back to github-actions[bot] (the script
# warns and exits non-zero, so this `if` simply keeps the existing token). ---
if APP_TOKEN=$(bash "$SCRIPT_DIR/mint-app-token.sh"); then
    if [ -n "$APP_TOKEN" ]; then
        export GITHUB_TOKEN="$APP_TOKEN"
        echo "  Using GitHub App identity for PR comments" >&2
    fi
fi

[ -n "${GITHUB_TOKEN:-}" ] || fail "GITHUB_TOKEN is not set"

# --- Resolve the triggering event (pull_request, or an @mention issue_comment).
# Emits {run, review_head, base_ref, instruction, full_review, ...}. On run=false
# (non-PR comment, no trigger phrase, insufficient permission, bot author) we set
# a skip verdict and exit cleanly — consumers gating on outputs.verdict still get
# a value. ---
EVENT_ERR=$(mktemp)
EVENT_JSON=$(bash "$SCRIPT_DIR/resolve-event.sh" 2>"$EVENT_ERR") || fail "Failed to resolve triggering event" "$(cat "$EVENT_ERR")"
if [ "$(echo "$EVENT_JSON" | jq -r '.run')" != "true" ]; then
    REASON=$(echo "$EVENT_JSON" | jq -r '.reason // "not-triggered"')
    echo "[SKIP] Not triggering a review: $REASON" >&2
    echo "verdict=skip" >> "$GITHUB_OUTPUT"
    echo "findings-count=0" >> "$GITHUB_OUTPUT"
    exit 0
fi
REVIEW_HEAD=$(echo "$EVENT_JSON" | jq -r '.review_head // "HEAD"'); export REVIEW_HEAD
EVENT_BASE=$(echo "$EVENT_JSON" | jq -r '.base_ref // ""')
[ -n "$EVENT_BASE" ] && [ "$EVENT_BASE" != "null" ] && export INPUT_BASE_BRANCH="$EVENT_BASE"
INPUT_REVIEW_INSTRUCTION=$(echo "$EVENT_JSON" | jq -r '.instruction // ""'); export INPUT_REVIEW_INSTRUCTION
FULL_REVIEW=$(echo "$EVENT_JSON" | jq -r '.full_review // true'); export FULL_REVIEW

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

# --- Review memory: read the PRIOR state from the existing sticky comment NOW,
# before the in-progress update overwrites its body (which would clobber the
# hidden marker). Best-effort: any failure leaves an empty prior so the review
# still runs. STICKY_COMMENT_ID is reused by every post-comment call below. ---
REVIEW_MEMORY="${INPUT_REVIEW_MEMORY:-true}"
PRIOR_STATE="{}"
if [ "$REVIEW_MEMORY" = "true" ]; then
    STICKY_JSON=$(bash "$SCRIPT_DIR/find-sticky-comment.sh" 2>/dev/null || echo '{}')
    STICKY_ID=$(echo "$STICKY_JSON" | jq -r '.id // ""' 2>/dev/null || echo "")
    PRIOR_BODY=$(echo "$STICKY_JSON" | jq -r '.body // ""' 2>/dev/null || echo "")
    PRIOR_STATE=$(printf '%s' "$PRIOR_BODY" | bash "$SCRIPT_DIR/review-state.sh" decode 2>/dev/null || echo '{}')
    [ -n "$STICKY_ID" ] && export STICKY_COMMENT_ID="$STICKY_ID"
fi

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

# --- Review memory: diff current findings against the prior state, then export
# the recap, history, and freshly-encoded state marker for format-verdict.sh.
# resolved is only computed for in-scope paths on a full review (review-state.sh
# enforces the scope rule). Entirely best-effort — never blocks the verdict. ---
if [ "$REVIEW_MEMORY" = "true" ]; then
    IN_SCOPE=$(echo "$DIFF_DATA" | jq -c '.changed_files // []' 2>/dev/null || echo '[]')
    HEAD_SHA="${GITHUB_SHA:-}"
    if [ "$REVIEW_HEAD" != "HEAD" ]; then
        HEAD_SHA=$(git rev-parse "$REVIEW_HEAD" 2>/dev/null || echo "${GITHUB_SHA:-}")
    fi
    DIFF_IN=$(jq -nc \
        --argjson prior "$PRIOR_STATE" \
        --argjson cur "$(echo "$PARSED" | jq -c '.findings // []')" \
        --argjson inscope "$IN_SCOPE" \
        --argjson full "$FULL_REVIEW" \
        --arg sha "$HEAD_SHA" \
        --arg verdict "$VERDICT" \
        '{prior: (if ($prior|type)=="object" and ($prior|length)>0 then $prior else null end),
          current_findings: $cur,
          scope: {in_scope_paths: $inscope, full_review: $full},
          head_sha: $sha, verdict: $verdict}' 2>/dev/null || echo "")
    if [ -n "$DIFF_IN" ] && STATE_DIFF=$(echo "$DIFF_IN" | bash "$SCRIPT_DIR/review-state.sh" diff 2>/dev/null) && [ -n "$STATE_DIFF" ]; then
        HAD_PRIOR=$(echo "$PRIOR_STATE" | jq -r '((.findings? // []) | length) > 0 or ((.history? // []) | length) > 0' 2>/dev/null || echo false)
        if [ "$HAD_PRIOR" = "true" ]; then
            if REVIEW_RECAP_JSON=$(echo "$STATE_DIFF" | jq -c '{new, open, resolved, counts}' 2>/dev/null) && [ -n "$REVIEW_RECAP_JSON" ]; then
                export REVIEW_RECAP_JSON
            fi
        fi
        REVIEW_HISTORY_JSON=$(echo "$STATE_DIFF" | jq -c '.next_state.history // []' 2>/dev/null || echo "[]"); export REVIEW_HISTORY_JSON
        if REVIEW_STATE_MARKER=$(echo "$STATE_DIFF" | jq -c '.next_state' 2>/dev/null | bash "$SCRIPT_DIR/review-state.sh" encode 2>/dev/null) && [ -n "$REVIEW_STATE_MARKER" ]; then
            export REVIEW_STATE_MARKER
        fi
    fi
fi

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
