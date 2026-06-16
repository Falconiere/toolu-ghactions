#!/usr/bin/env bash
# main.sh — entrypoint for the AI Code Review GitHub Action.
#
# parallel mode (default): fetch-diff → fan out one run-dimension.sh per dimension
#   group → validate-findings → coordinate-findings → format-verdict →
#   post-comment (summary) → post-review (inline, non-fatal).
# single mode: fetch-diff → build-prompt → call-openrouter → parse-response → …
#
# Sets GitHub Actions outputs: verdict, findings-count, comment-url.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GITHUB_OUTPUT="${GITHUB_OUTPUT:-/dev/stdout}"
REVIEW_MODE="${INPUT_REVIEW_MODE:-parallel}"
DIMENSIONS="correctness security performance tests"

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
    fi

    echo "verdict=error" >> "$GITHUB_OUTPUT"
    echo "findings-count=0" >> "$GITHUB_OUTPUT"
    exit 1
}

# --- Phase 1: Validate environment ---
if [ -z "${OPENROUTER_API_KEY:-}" ] && [ -n "${INPUT_OPENROUTER_API_KEY:-}" ]; then
    export OPENROUTER_API_KEY="$INPUT_OPENROUTER_API_KEY"
fi
[ -z "${OPENROUTER_API_KEY:-}" ] && fail "OPENROUTER_API_KEY is not set (pass via env: block or with: input)"
[ -z "${GITHUB_TOKEN:-}" ] && fail "GITHUB_TOKEN is not set"

# --- Phase 2: Fetch diff ---
echo "[1/5] Fetching PR diff..." >&2
DIFF_ERR=$(mktemp)
DIFF_DATA=$(bash "$SCRIPT_DIR/fetch-diff.sh" 2>"$DIFF_ERR") || fail "Failed to fetch PR diff" "$(cat "$DIFF_ERR")"

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

# --- Phase 3: Produce the final review object (PARSED) ---
if [ "$REVIEW_MODE" = "single" ]; then
    echo "[2/5] Single-pass review..." >&2
    REQ_ERR=$(mktemp)
    REQUEST_BODY=$(echo "$DIFF_DATA" | bash "$SCRIPT_DIR/build-prompt.sh" 2>"$REQ_ERR") || fail "Failed to build review prompt" "$(cat "$REQ_ERR")"
    API_ERR=$(mktemp)
    API_RESPONSE=$(echo "$REQUEST_BODY" | bash "$SCRIPT_DIR/call-openrouter.sh" 2>"$API_ERR") || fail "OpenRouter API call failed" "$(cat "$API_ERR")"
    PARSE_ERR=$(mktemp)
    PARSED=$(echo "$API_RESPONSE" | bash "$SCRIPT_DIR/parse-response.sh" 2>"$PARSE_ERR") || fail "Failed to parse review response" "$(cat "$PARSE_ERR")"
else
    echo "[2/5] Parallel sub-reviewers: $DIMENSIONS" >&2
    TMPD=$(mktemp -d)
    declare -A PID
    for dim in $DIMENSIONS; do
        ( echo "$DIFF_DATA" | INPUT_DIMENSION="$dim" bash "$SCRIPT_DIR/run-dimension.sh" > "$TMPD/$dim.json" 2> "$TMPD/$dim.err" ) &
        PID[$dim]=$!
    done

    OK=0
    UNION="[]"
    for dim in $DIMENSIONS; do
        if wait "${PID[$dim]}"; then
            OK=$((OK + 1))
            DF=$(jq -c '.findings // []' "$TMPD/$dim.json" || echo "[]")
            UNION=$(jq -cn --argjson a "$UNION" --argjson b "$DF" '$a + $b')
        else
            echo "  [warn] dimension '$dim' failed: $(cat "$TMPD/$dim.err")" >&2
        fi
    done
    [ "$OK" -eq 0 ] && fail "All dimension reviewers failed" "$(cat "$TMPD"/*.err)"
    echo "  $OK dimension(s) succeeded; $(echo "$UNION" | jq 'length') findings before validation" >&2

    FILES=$(echo "$DIFF_DATA" | jq -c '.files // []')
    AGG=$(jq -cn --argjson files "$FILES" --argjson findings "$UNION" '{files:$files, findings:$findings}')

    VAL_ERR=$(mktemp)
    VALIDATED=$(echo "$AGG" | bash "$SCRIPT_DIR/validate-findings.sh" 2>"$VAL_ERR") || fail "Failed to validate findings" "$(cat "$VAL_ERR")"
    COORD_ERR=$(mktemp)
    PARSED=$(echo "$VALIDATED" | bash "$SCRIPT_DIR/coordinate-findings.sh" 2>"$COORD_ERR") || fail "Coordinator pass failed" "$(cat "$COORD_ERR")"
fi

VERDICT=$(echo "$PARSED" | jq -r '.verdict // "changes"')
FINDINGS_COUNT=$(echo "$PARSED" | jq '.findings | length')
echo "[3/5] Verdict: $VERDICT, Findings: $FINDINGS_COUNT" >&2

# --- Phase 4: Format + post summary comment ---
echo "[4/5] Posting verdict comment..." >&2
FMT_ERR=$(mktemp)
COMMENT_BODY=$(echo "$PARSED" | bash "$SCRIPT_DIR/format-verdict.sh" 2>"$FMT_ERR") || fail "Failed to format verdict comment" "$(cat "$FMT_ERR")"
POST_ERR=$(mktemp)
COMMENT_URL=$(echo "$COMMENT_BODY" | bash "$SCRIPT_DIR/post-comment.sh" 2>"$POST_ERR") || fail "Failed to post verdict comment" "$(cat "$POST_ERR")"

# --- Phase 5: Inline review comments + suggestions (non-fatal) ---
echo "[5/5] Posting inline review comments..." >&2
echo "$PARSED" | bash "$SCRIPT_DIR/post-review.sh" || echo "  Warning: inline review step failed (summary comment still posted)" >&2

# --- Outputs ---
echo "verdict=$VERDICT" >> "$GITHUB_OUTPUT"
echo "findings-count=$FINDINGS_COUNT" >> "$GITHUB_OUTPUT"
echo "comment-url=$COMMENT_URL" >> "$GITHUB_OUTPUT"

echo "Review complete: $VERDICT ($FINDINGS_COUNT findings) — $COMMENT_URL" >&2
exit 0
