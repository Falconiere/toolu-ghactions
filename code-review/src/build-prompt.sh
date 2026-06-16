#!/usr/bin/env bash
# build-prompt.sh — assemble the provider-agnostic review envelope.
#
# Reads the diff JSON (from fetch-diff.sh) on stdin, plus INPUT_* env vars:
#   INPUT_MAX_TOKENS, INPUT_ENFORCE_JSON_SCHEMA,
#   INPUT_REVIEW_PROMPT_FILE, INPUT_CODEBASE_OVERVIEW
#
# Outputs a provider-agnostic envelope JSON to stdout:
#   { system: <str>, user: <str>, max_tokens: <int>, enforce_json_schema: <bool> }
#
# Each provider's build-request.sh wraps this envelope into the vendor wire format.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

MAX_TOKENS="${INPUT_MAX_TOKENS:-4096}"
ENFORCE_SCHEMA="${INPUT_ENFORCE_JSON_SCHEMA:-true}"
PROMPT_FILE="${INPUT_REVIEW_PROMPT_FILE:-}"
OVERVIEW="${INPUT_CODEBASE_OVERVIEW:-}"

prompt_path() {
    local name="$1"
    if [ -f "/action/prompts/$name" ]; then echo "/action/prompts/$name"
    elif [ -f "$SCRIPT_DIR/../prompts/$name" ]; then echo "$SCRIPT_DIR/../prompts/$name"
    elif [ -f "code-review/prompts/$name" ]; then echo "code-review/prompts/$name"
    else echo ""; fi
}

dimension_focus() {
    case "$1" in
        correctness) echo "CORRECTNESS — logic errors, edge cases, error handling. Flag swallowed errors and @ts-ignore/eslint-disable/#[allow] that paper over real problems." ;;
        security)    echo "SECURITY — input validation, injection vectors, hardcoded secrets, unsafe file/symlink operations." ;;
        performance) echo "PERFORMANCE & MIGRATION — hot-path work (per render/hook/request), allocations or subprocess spawns in loops; and breaking changes (moved paths, removed symlinks, renamed APIs) that need actionable warnings." ;;
        tests)       echo "TESTS, ASSERTIONS & DOCS — new code paths missing a colocated real-data test; loose test assertions (suffix/partial instead of full identity); comments or docs that no longer match behavior." ;;
        *)           echo "GENERAL — review the diff for correctness and obvious defects." ;;
    esac
}

DIFF_DATA=$(cat)

if [ -n "$PROMPT_FILE" ]; then
    if [[ "$PROMPT_FILE" == /* ]]; then PROMPT_PATH="$PROMPT_FILE"; else PROMPT_PATH="${GITHUB_WORKSPACE:-/github/workspace}/${PROMPT_FILE}"; fi
    if [ -f "$PROMPT_PATH" ]; then SYSTEM_PROMPT=$(cat "$PROMPT_PATH")
    else jq -nc --arg f "$PROMPT_FILE" '{error: ("Custom review prompt file not found: " + $f)}' >&2; exit 1
    fi
else
    CHECKLIST=$(prompt_path "review-checklist.txt")
    [ -z "$CHECKLIST" ] && { jq -nc '{error: "No review prompt available — set INPUT_REVIEW_PROMPT_FILE or ship review-checklist.txt"}' >&2; exit 1; }
    SYSTEM_PROMPT=$(cat "$CHECKLIST")
fi

DIFF_TEXT=$(echo "$DIFF_DATA" | jq -r '.diff // ""')
CHANGED_FILES=$(echo "$DIFF_DATA" | jq -r '(.changed_files // []) | join(", ")')
BINARY_FILES=$(echo "$DIFF_DATA" | jq -r '[.binary_files[]?] | join("\n")')
DROPPED_FILES=$(echo "$DIFF_DATA" | jq -r '[.dropped_files[]? | .path + " (" + .reason + ")"] | join("\n")')
TRUNCATED=$(echo "$DIFF_DATA" | jq -r '.truncated // false')
TOTAL_LINES=$(echo "$DIFF_DATA" | jq -r '.total_lines // 0')
TOTAL_FILES=$(echo "$DIFF_DATA" | jq -r '.total_files // 0')

USER_PROMPT="Review the following pull request diff."
[ -n "$OVERVIEW" ] && USER_PROMPT+="

## Codebase Overview
$OVERVIEW"
USER_PROMPT+="

## Changed Files ($TOTAL_FILES total)
$CHANGED_FILES"
[ -n "$BINARY_FILES" ] && USER_PROMPT+="

## Binary Files (not reviewed)
$(echo "$BINARY_FILES" | while read -r f; do echo "- $f"; done)"
[ -n "$DROPPED_FILES" ] && USER_PROMPT+="

## Skipped Files (lockfiles/generated/minified — not reviewed)
$(echo "$DROPPED_FILES" | while read -r f; do echo "- $f"; done)"
[ "$TRUNCATED" = "true" ] && USER_PROMPT+="

[Diff truncated at $TOTAL_LINES lines; some hunks omitted. Review what is shown.]"
USER_PROMPT+="

## Diff
\`\`\`diff
$DIFF_TEXT
\`\`\`"

SYSTEM_ESCAPED=$(echo "$SYSTEM_PROMPT" | jq -Rs .)
USER_ESCAPED=$(echo "$USER_PROMPT" | jq -Rs .)

jq -nc \
    --argjson system "$SYSTEM_ESCAPED" \
    --argjson user "$USER_ESCAPED" \
    --argjson maxtok "$MAX_TOKENS" \
    --argjson enforce "$ENFORCE_SCHEMA" \
    '{ system: $system, user: $user, max_tokens: $maxtok, enforce_json_schema: $enforce }'
