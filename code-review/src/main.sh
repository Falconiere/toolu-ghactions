#!/usr/bin/env bash
# main.sh — entrypoint for the AI Code Review GitHub Action.
#
# Orchestrates: fetch-diff → build-prompt → call-openrouter → parse-response
# → format-verdict → post-comment. Catches errors at each phase and posts
# a failure comment if possible.
#
# Sets GitHub Actions outputs: verdict, findings-count, comment-url.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GITHUB_OUTPUT="${GITHUB_OUTPUT:-/dev/stdout}"

# Record start time for duration reporting.
REVIEW_START_TIME=$(date +%s)
export REVIEW_START_TIME

# --- Helper: post an error comment and exit ---
fail() {
    local message="$1"
    echo "[ERROR] $message" >&2

    # Try to post an error comment, but don't fail if we can't.
    if [ -f "$SCRIPT_DIR/post-comment.sh" ] && [ -n "${GITHUB_TOKEN:-}" ]; then
        ERROR_BODY="**AI Code Review failed** —— [View job](${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-unknown}/actions/runs/${GITHUB_RUN_ID:-?})

---
### Code Review — error

- [x] Read repository context and PR diff
- [ ] Review changed files
- [ ] Analyze correctness, security, performance
- [ ] Post findings

**Error:** $message

\`agent-merge-changes-requested\`
"
        COMMENT_URL=$(echo "$ERROR_BODY" | bash "$SCRIPT_DIR/post-comment.sh" 2>/dev/null || echo "")
        if [ -n "$COMMENT_URL" ]; then
            echo "comment-url=$COMMENT_URL" >> "$GITHUB_OUTPUT"
        fi
    fi

    echo "verdict=error" >> "$GITHUB_OUTPUT"
    echo "findings-count=0" >> "$GITHUB_OUTPUT"
    exit 1
}

# --- Phase 1: Validate environment ---
if [ -z "${OPENROUTER_API_KEY:-}" ]; then
    fail "OPENROUTER_API_KEY is not set"
fi

if [ -z "${GITHUB_TOKEN:-}" ]; then
    fail "GITHUB_TOKEN is not set"
fi

# --- Phase 2: Fetch diff ---
echo "[1/5] Fetching PR diff..." >&2
DIFF_DATA=$(bash "$SCRIPT_DIR/fetch-diff.sh" 2>/dev/null) || {
    fail "Failed to fetch PR diff (merge-base resolution failed)"
}

# Check for file limit skip.
SKIP_ERROR=$(echo "$DIFF_DATA" | jq -r '.error // ""' 2>/dev/null || true)
if [ -n "$SKIP_ERROR" ]; then
    echo "[SKIP] $SKIP_ERROR" >&2
    echo "verdict=skip" >> "$GITHUB_OUTPUT"
    echo "findings-count=0" >> "$GITHUB_OUTPUT"
    # Post a skip comment if we can.
    if [ -f "$SCRIPT_DIR/post-comment.sh" ]; then
        SKIP_BODY="**AI Code Review skipped** —— [View job](${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-unknown}/actions/runs/${GITHUB_RUN_ID:-?})

---
### Code Review — skipped

- [x] Read repository context and PR diff
- [ ] Review changed files
- [ ] Analyze correctness, security, performance
- [ ] Post findings

**Skipped:** $SKIP_ERROR
"
        SKIP_URL=$(echo "$SKIP_BODY" | bash "$SCRIPT_DIR/post-comment.sh" 2>/dev/null || echo "")
        [ -n "$SKIP_URL" ] && echo "comment-url=$SKIP_URL" >> "$GITHUB_OUTPUT"
    fi
    exit 0
fi

TOTAL_FILES=$(echo "$DIFF_DATA" | jq -r '.total_files // 0')

if [ "$TOTAL_FILES" -eq 0 ]; then
    # No changes to review.
    echo "[SKIP] No file changes to review" >&2
    echo "verdict=skip" >> "$GITHUB_OUTPUT"
    echo "findings-count=0" >> "$GITHUB_OUTPUT"

    NOOP_BODY="**AI Code Review finished** —— [View job](${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-unknown}/actions/runs/${GITHUB_RUN_ID:-?})

---
### Code Review — \`${GITHUB_HEAD_REF:-unknown}\`

- [x] Read repository context and PR diff
- [x] Review changed files
- [x] Analyze correctness, security, performance
- [x] Post findings
- [x] Set verdict label (\`agent-merge-approved\`)

**No file changes to review.** 🎉

\`agent-merge-approved\`
"
    NOOP_URL=$(echo "$NOOP_BODY" | bash "$SCRIPT_DIR/post-comment.sh" 2>/dev/null || echo "")
    [ -n "$NOOP_URL" ] && echo "comment-url=$NOOP_URL" >> "$GITHUB_OUTPUT"
    exit 0
fi

echo "  Files: $TOTAL_FILES, Lines: $(echo "$DIFF_DATA" | jq -r '.total_lines')" >&2

# --- Phase 3: Build prompt ---
echo "[2/5] Building review prompt..." >&2
REQUEST_BODY=$(echo "$DIFF_DATA" | bash "$SCRIPT_DIR/build-prompt.sh" 2>/dev/null) || {
    fail "Failed to build review prompt"
}

# --- Phase 4: Call OpenRouter ---
echo "[3/5] Calling OpenRouter API..." >&2
API_RESPONSE=$(echo "$REQUEST_BODY" | bash "$SCRIPT_DIR/call-openrouter.sh" 2>/dev/null) || {
    fail "OpenRouter API call failed — check API key and model availability"
}

# Check for API-level errors in the response.
API_ERROR=$(echo "$API_RESPONSE" | jq -r '.error // ""' 2>/dev/null || true)
if [ -n "$API_ERROR" ] && [ "$API_ERROR" != "null" ]; then
    fail "OpenRouter returned an error: $API_ERROR"
fi

echo "  Done." >&2

# --- Phase 5: Parse response ---
echo "[4/5] Parsing review response..." >&2
PARSED=$(echo "$API_RESPONSE" | bash "$SCRIPT_DIR/parse-response.sh" 2>/dev/null) || {
    fail "Failed to parse review response — LLM output was not valid JSON and regex fallback failed"
}

VERDICT=$(echo "$PARSED" | jq -r '.verdict // "changes"')
FINDINGS_COUNT=$(echo "$PARSED" | jq '.findings | length')
echo "  Verdict: $VERDICT, Findings: $FINDINGS_COUNT" >&2

# --- Phase 6: Format and post verdict ---
echo "[5/5] Posting verdict comment..." >&2
COMMENT_BODY=$(echo "$PARSED" | bash "$SCRIPT_DIR/format-verdict.sh" 2>/dev/null) || {
    fail "Failed to format verdict comment"
}

COMMENT_URL=$(echo "$COMMENT_BODY" | bash "$SCRIPT_DIR/post-comment.sh" 2>/dev/null) || {
    fail "Failed to post verdict comment"
}

# --- Write outputs ---
echo "verdict=$VERDICT" >> "$GITHUB_OUTPUT"
echo "findings-count=$FINDINGS_COUNT" >> "$GITHUB_OUTPUT"
echo "comment-url=$COMMENT_URL" >> "$GITHUB_OUTPUT"

echo "" >&2
echo "============================================" >&2
echo "  Review complete: $VERDICT" >&2
echo "  Findings: $FINDINGS_COUNT" >&2
echo "  Comment: $COMMENT_URL" >&2
echo "============================================" >&2

exit 0
