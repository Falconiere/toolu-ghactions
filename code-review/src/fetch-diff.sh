#!/usr/bin/env bash
# fetch-diff.sh — resolve merge-base, compute the git diff, classify files
# (binary / noise / text), line-prime the text diff, and optionally truncate.
#
# Reads INPUT_BASE_BRANCH, INPUT_MAX_FILES, INPUT_MAX_DIFF_LINES from env.
# Outputs to stdout a JSON object:
#   { diff, files:[{path,changed_lines}], changed_files[], binary_files[],
#     dropped_files:[{path,reason}], total_lines, total_files, truncated }
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# GitHub Actions mounts the host workspace; container runs as root but host
# files are owned by the runner user — newer git rejects this as dubious.
git config --global --add safe.directory /github/workspace 2>/dev/null || true

BASE_BRANCH="${INPUT_BASE_BRANCH:-main}"
MAX_FILES="${INPUT_MAX_FILES:-100}"
MAX_DIFF_LINES="${INPUT_MAX_DIFF_LINES:-8000}"

# Prefer the PR base ref when the caller left the default.
if [ -n "${GITHUB_BASE_REF:-}" ] && [ "$BASE_BRANCH" = "main" ]; then
    BASE_BRANCH="$GITHUB_BASE_REF"
fi

REMOTE_BASE="origin/${BASE_BRANCH}"
if ! git rev-parse --verify "$REMOTE_BASE" >/dev/null 2>&1; then
    if git remote get-url origin >/dev/null 2>&1; then
        echo "  Fetching ${BASE_BRANCH}..." >&2
        git fetch origin "${BASE_BRANCH}" --depth=1 >/dev/null 2>&1 || true
    fi
    if ! git rev-parse --verify "$REMOTE_BASE" >/dev/null 2>&1; then
        if ! git rev-parse --verify "$BASE_BRANCH" >/dev/null 2>&1; then
            jq -nc --arg base "$BASE_BRANCH" '{error: "Cannot resolve base branch", base_branch: $base}' >&2
            exit 1
        fi
        REMOTE_BASE="$BASE_BRANCH"
    fi
fi

MERGE_BASE=$(git merge-base HEAD "$REMOTE_BASE" 2>/dev/null || true)
if [ -z "$MERGE_BASE" ]; then
    jq -nc --arg base "$BASE_BRANCH" '{error: "Cannot compute merge-base", base_branch: $base}' >&2
    exit 1
fi

# Count changed files.
CHANGED_FILES=$(git diff --name-only "$MERGE_BASE" HEAD 2>/dev/null || true)
if [ -z "${CHANGED_FILES//[[:space:]]/}" ]; then
    TOTAL_FILES=0
else
    TOTAL_FILES=$(printf '%s\n' "$CHANGED_FILES" | grep -c .)
fi

if [ "$TOTAL_FILES" -eq 0 ]; then
    jq -nc '{diff:"", files:[], changed_files:[], binary_files:[], dropped_files:[], total_lines:0, total_files:0, truncated:false}'
    exit 0
fi

# Enforce the file-count limit before doing expensive diff work.
if [ "$TOTAL_FILES" -gt "$MAX_FILES" ]; then
    jq -nc --argjson total "$TOTAL_FILES" --argjson max "$MAX_FILES" \
        '{error: "PR exceeds file limit", total_files: $total, max_files: $max}' >&2
    exit 0  # Not a failure — main posts a skip comment.
fi

# Is a path noise (lockfile / minified / sourcemap / generated)? Echoes a
# reason and returns 0 when noise, returns 1 otherwise.
noise_reason() {
    local path="$1"
    case "$path" in
        *.lock|*-lock.json|pnpm-lock.yaml|bun.lockb) echo "lockfile"; return 0 ;;
        *.min.js|*.min.css) echo "minified"; return 0 ;;
        *.map) echo "sourcemap"; return 0 ;;
    esac
    # Generated-file marker in the first lines of the new content.
    if git show "HEAD:$path" 2>/dev/null | head -20 | grep -qE '@generated|DO NOT EDIT'; then
        echo "generated"
        return 0
    fi
    return 1
}

# Classify each changed file using numstat (binary files show "-\t-\tpath").
BINARY_FILES=()
TEXT_CHANGED_FILES=()
DROPPED_JSON="[]"
NUMSTAT=$(git diff --numstat "$MERGE_BASE" HEAD 2>/dev/null || true)

while IFS=$'\t' read -r added removed path; do
    [ -z "$path" ] && continue
    if [ "$added" = "-" ] && [ "$removed" = "-" ]; then
        BINARY_FILES+=("$path")
        continue
    fi
    if reason=$(noise_reason "$path"); then
        DROPPED_JSON=$(jq -c --arg p "$path" --arg r "$reason" '. + [{path:$p, reason:$r}]' <<< "$DROPPED_JSON")
        continue
    fi
    TEXT_CHANGED_FILES+=("$path")
done <<< "$NUMSTAT"

# Build the line-primed diff + per-file changed_lines for the text files.
DIFF=""
FILES_JSON="[]"
if [ ${#TEXT_CHANGED_FILES[@]} -gt 0 ]; then
    RAW_DIFF=$(git diff "$MERGE_BASE" HEAD -- "${TEXT_CHANGED_FILES[@]}" 2>/dev/null || true)
    SHAPED=$(printf '%s\n' "$RAW_DIFF" | bash "$SCRIPT_DIR/shape-diff.sh")
    DIFF=$(jq -r '.diff' <<< "$SHAPED")
    FILES_JSON=$(jq -c '.files' <<< "$SHAPED")
fi

# Count primed lines (printf avoids the trailing-newline off-by-one).
if [ -z "$DIFF" ]; then
    DIFF_LINES=0
else
    DIFF_LINES=$(printf '%s' "$DIFF" | grep -c '' )
fi

# Hunk-boundary truncation: stop at the next file/hunk boundary once the budget
# is reached, so a hunk is never cut mid-line.
TRUNCATED=false
if [ "$DIFF_LINES" -gt "$MAX_DIFF_LINES" ]; then
    DIFF=$(printf '%s\n' "$DIFF" | awk -v max="$MAX_DIFF_LINES" '
        (/^diff --git / || /^@@ /) && n >= max { stop = 1 }
        stop { next }
        { print; n++ }
    ')
    TRUNCATED=true
    if [ -z "$DIFF" ]; then DIFF_LINES=0; else DIFF_LINES=$(printf '%s' "$DIFF" | grep -c ''); fi
fi

# changed_files = text files (the ones actually present in the diff).
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

DIFF_ESCAPED=$(printf '%s' "$DIFF" | jq -Rs .)

jq -nc \
    --argjson diff "$DIFF_ESCAPED" \
    --argjson files "$FILES_JSON" \
    --argjson changed "$CHANGED_JSON" \
    --argjson binary "$BINARY_JSON" \
    --argjson dropped "$DROPPED_JSON" \
    --argjson lines "$DIFF_LINES" \
    --argjson total "$TOTAL_FILES" \
    --argjson truncated "$TRUNCATED" \
    '{
        diff: $diff,
        files: $files,
        changed_files: $changed,
        binary_files: $binary,
        dropped_files: $dropped,
        total_lines: $lines,
        total_files: $total,
        truncated: $truncated
    }'
