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

# git fetch with a wall-clock cap when the platform provides `timeout` (CI/Alpine
# does), so a slow or unreachable origin can't hang the job until GitHub's job
# timeout. Falls back to a plain fetch where `timeout` is absent (e.g. macOS).
git_fetch() {
    if command -v timeout >/dev/null 2>&1; then
        timeout 120 git fetch "$@"
    else
        git fetch "$@"
    fi
}

BASE_BRANCH="${INPUT_BASE_BRANCH:-main}"
# 0 (the default) means unlimited: review any number of files / diff lines.
# The only real ceiling is the OpenRouter billing balance + model context. A
# positive value opts back into a hard file-count skip / diff-line truncation.
MAX_FILES="${INPUT_MAX_FILES:-0}"
MAX_DIFF_LINES="${INPUT_MAX_DIFF_LINES:-0}"

# Prefer the PR base ref when the caller left the default.
if [ -n "${GITHUB_BASE_REF:-}" ] && [ "$BASE_BRANCH" = "main" ]; then
    BASE_BRANCH="$GITHUB_BASE_REF"
fi

REMOTE_BASE="origin/${BASE_BRANCH}"
if ! git rev-parse --verify "$REMOTE_BASE" >/dev/null 2>&1; then
    if git remote get-url origin >/dev/null 2>&1; then
        echo "  Fetching ${BASE_BRANCH}..." >&2
        git_fetch origin "${BASE_BRANCH}" --depth=1 >/dev/null 2>&1 || true
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

# actions/checkout defaults to fetch-depth: 1, so both HEAD and the base tip are
# grafted shallow and share no visible ancestor — merge-base comes back empty.
# Progressively deepen the shallow history until they reconnect, then unshallow
# as a last resort. Skipped for full clones (deepen is a no-op there anyway).
if [ -z "$MERGE_BASE" ] \
    && [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = "true" ] \
    && git remote get-url origin >/dev/null 2>&1; then
    echo "  Deepening shallow history to find merge-base..." >&2
    for depth in 100 500 2000; do
        git_fetch origin --deepen="$depth" >/dev/null 2>&1 || true
        MERGE_BASE=$(git merge-base HEAD "$REMOTE_BASE" 2>/dev/null || true)
        [ -n "$MERGE_BASE" ] && break
    done
    if [ -z "$MERGE_BASE" ]; then
        git_fetch origin --unshallow >/dev/null 2>&1 || true
        MERGE_BASE=$(git merge-base HEAD "$REMOTE_BASE" 2>/dev/null || true)
    fi
fi

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

# Enforce the file-count limit before doing expensive diff work (opt-in:
# MAX_FILES > 0). Emit on stdout (not stderr): main.sh reads `.error` from this
# script's stdout to detect a skip and post the skip comment. Writing it to
# stderr left stdout empty, so main saw no skip, fed "" downstream, and crashed
# in jq --argjson.
if [ "$MAX_FILES" -gt 0 ] && [ "$TOTAL_FILES" -gt "$MAX_FILES" ]; then
    jq -nc --argjson total "$TOTAL_FILES" --argjson max "$MAX_FILES" \
        '{error: "PR exceeds file limit (\($total) changed files > \($max) max). Raise MAX_FILES to review it.", total_files: $total, max_files: $max}'
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
# is reached, so a hunk is never cut mid-line. Opt-in: MAX_DIFF_LINES > 0.
TRUNCATED=false
if [ "$MAX_DIFF_LINES" -gt 0 ] && [ "$DIFF_LINES" -gt "$MAX_DIFF_LINES" ]; then
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

# The diff and per-file line map both scale with the PR and overflow ARG_MAX
# ("jq: Argument list too long") if passed via --argjson on the command line.
# Route them through temp files: --rawfile reads the diff verbatim as a JSON
# string; --slurpfile wraps the files array in a one-element array (hence [0]).
DIFF_FILE=$(mktemp)
FILES_FILE=$(mktemp)
trap 'rm -f "$DIFF_FILE" "$FILES_FILE"' EXIT
printf '%s' "$DIFF" > "$DIFF_FILE"
printf '%s' "$FILES_JSON" > "$FILES_FILE"

jq -nc \
    --rawfile diff "$DIFF_FILE" \
    --slurpfile files "$FILES_FILE" \
    --argjson changed "$CHANGED_JSON" \
    --argjson binary "$BINARY_JSON" \
    --argjson dropped "$DROPPED_JSON" \
    --argjson lines "$DIFF_LINES" \
    --argjson total "$TOTAL_FILES" \
    --argjson truncated "$TRUNCATED" \
    '{
        diff: $diff,
        files: $files[0],
        changed_files: $changed,
        binary_files: $binary,
        dropped_files: $dropped,
        total_lines: $lines,
        total_files: $total,
        truncated: $truncated
    }'
