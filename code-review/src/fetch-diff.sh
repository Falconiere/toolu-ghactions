#!/usr/bin/env bash
# fetch-diff.sh — resolve merge-base, compute git diff, count files/lines,
# detect binary files, and optionally truncate large diffs.
#
# Reads INPUT_BASE_BRANCH, INPUT_MAX_FILES, INPUT_MAX_DIFF_LINES from env.
# Outputs to stdout: a JSON object with diff, changed_files[], binary_files[],
# total_lines, truncated (bool).
set -euo pipefail

# GitHub Actions mounts the host workspace; container runs as root but host
# files are owned by the runner user — newer git rejects this as dubious.
git config --global --add safe.directory /github/workspace 2>/dev/null || true

BASE_BRANCH="${INPUT_BASE_BRANCH:-main}"
MAX_FILES="${INPUT_MAX_FILES:-100}"
MAX_DIFF_LINES="${INPUT_MAX_DIFF_LINES:-8000}"

# Determine the merge base. Prefer the PR base ref if available, fall back to
# origin/<base-branch>, then the input default.
if [ -n "${GITHUB_BASE_REF:-}" ] && [ "$BASE_BRANCH" = "main" ]; then
    BASE_BRANCH="$GITHUB_BASE_REF"
fi

REMOTE_BASE="origin/${BASE_BRANCH}"
if ! git rev-parse --verify "$REMOTE_BASE" >/dev/null 2>&1; then
    # Shallow clone may not have the remote ref — try to fetch it.
    if git remote get-url origin >/dev/null 2>&1; then
        echo "  Fetching ${BASE_BRANCH}..." >&2
        git fetch origin "${BASE_BRANCH}" --depth=1 >/dev/null 2>&1 || true
    fi
    # Re-check after fetch attempt.
    if ! git rev-parse --verify "$REMOTE_BASE" >/dev/null 2>&1; then
        # Try local branch name as last resort.
        if ! git rev-parse --verify "$BASE_BRANCH" >/dev/null 2>&1; then
            echo '{"error":"Cannot resolve base branch","base_branch":"'"$BASE_BRANCH"'"}' >&2
            exit 1
        fi
        REMOTE_BASE="$BASE_BRANCH"
    fi
fi

MERGE_BASE=$(git merge-base HEAD "$REMOTE_BASE" 2>/dev/null || true)
if [ -z "$MERGE_BASE" ]; then
    echo '{"error":"Cannot compute merge-base","base_branch":"'"$BASE_BRANCH"'"}' >&2
    exit 1
fi

# Collect changed files.
CHANGED_FILES=$(git diff --name-only "$MERGE_BASE" HEAD 2>/dev/null || true)
TOTAL_FILES=$(echo "$CHANGED_FILES" | grep -c . 2>/dev/null || echo 0)
TOTAL_FILES="${TOTAL_FILES//[^0-9]/}"
[ -z "$TOTAL_FILES" ] && TOTAL_FILES=0

if [ "$TOTAL_FILES" -eq 0 ]; then
    # No file changes — empty diff.
    jq -nc '{diff:"",changed_files:[],binary_files:[],total_lines:0,truncated:false,total_files:0}'
    exit 0
fi

# Separate text files from binary files.
# git diff --stat shows "Bin" for binary files (both new and modified).
STAT=$(git diff --stat "$MERGE_BASE" HEAD 2>/dev/null || true)
NUMSTAT=$(git diff --numstat "$MERGE_BASE" HEAD 2>/dev/null || true)

BINARY_FILES=()
TEXT_CHANGED_FILES=()

while IFS=$'\t' read -r added removed path; do
    [ -z "$path" ] && continue
    # Check if the --stat output marks this file as binary.
    if echo "$STAT" | grep -qE "^[[:space:]]*$(echo "$path" | sed 's/[.[\*^$()+?{|]/\\&/g')[[:space:]]+\|[[:space:]]+Bin"; then
        BINARY_FILES+=("$path")
    elif [ "$added" = "-" ] && [ "$removed" = "-" ]; then
        # Fallback: numstat -/- markers (modified binary, rare edge case).
        BINARY_FILES+=("$path")
    else
        TEXT_CHANGED_FILES+=("$path")
    fi
done <<< "$NUMSTAT"

# Check file count limit.
if [ "$TOTAL_FILES" -gt "$MAX_FILES" ] 2>/dev/null; then
    echo "{\"error\":\"PR exceeds file limit\",\"total_files\":$TOTAL_FILES,\"max_files\":$MAX_FILES}" >&2
    exit 0  # Not a failure — action will post a skip comment.
fi

# Generate the unified diff (text files only).
DIFF=""
if [ ${#TEXT_CHANGED_FILES[@]} -gt 0 ]; then
    DIFF=$(git diff "$MERGE_BASE" HEAD -- "${TEXT_CHANGED_FILES[@]}" 2>/dev/null || true)
fi

DIFF_LINES=$(echo "$DIFF" | wc -l | tr -d ' ')
DIFF_LINES="${DIFF_LINES//[^0-9]/}"
[ -z "$DIFF_LINES" ] && DIFF_LINES=0

TRUNCATED=false
if [ "$DIFF_LINES" -gt "$MAX_DIFF_LINES" ]; then
    DIFF=$(echo "$DIFF" | head -n "$MAX_DIFF_LINES")
    TRUNCATED=true
    DIFF_LINES=$MAX_DIFF_LINES
fi

# Escape the diff for JSON embedding.
DIFF_ESCAPED=$(echo "$DIFF" | jq -Rs .)

# Build JSON arrays for changed_files and binary_files.
if [ ${#TEXT_CHANGED_FILES[@]} -gt 0 ]; then
    CHANGED_JSON=$(printf '%s\n' "${TEXT_CHANGED_FILES[@]}" | jq -R . | jq -s .)
else
    CHANGED_JSON="[]"
fi
if [ ${#BINARY_FILES[@]} -gt 0 ]; then
    BINARY_JSON=$(printf '%s\n' "${BINARY_FILES[@]}" | jq -R . | jq -s .)
else
    BINARY_JSON="[]"
fi

jq -nc \
    --argjson diff "$DIFF_ESCAPED" \
    --argjson changed "$CHANGED_JSON" \
    --argjson binary "$BINARY_JSON" \
    --argjson lines "$DIFF_LINES" \
    --argjson files "$TOTAL_FILES" \
    --argjson truncated "$TRUNCATED" \
    '{
        diff: $diff,
        changed_files: $changed,
        binary_files: $binary,
        total_lines: $lines,
        total_files: $files,
        truncated: $truncated
    }'
