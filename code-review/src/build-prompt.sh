#!/usr/bin/env bash
# build-prompt.sh — assemble the OpenRouter chat-completions request body.
#
# Two modes:
#   - dimension mode (INPUT_DIMENSION set): a narrowly-scoped sub-reviewer prompt
#     built from prompts/dimension-base.txt + that dimension's focus.
#   - single mode (default): the combined 7-dimension checklist (legacy), or a
#     caller-supplied INPUT_REVIEW_PROMPT_FILE.
#
# Reads INPUT_MODEL, INPUT_FALLBACK_MODEL, INPUT_MAX_TOKENS,
# INPUT_ENFORCE_JSON_SCHEMA, INPUT_DIMENSION, INPUT_REVIEW_PROMPT_FILE,
# INPUT_CODEBASE_OVERVIEW from env; diff JSON (fetch-diff.sh) from stdin.
# Outputs the complete JSON request body to stdout.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

MODEL="${INPUT_MODEL:-minimax/minimax-m3}"
FALLBACK_MODEL="${INPUT_FALLBACK_MODEL:-anthropic/claude-sonnet-4-5}"
MAX_TOKENS="${INPUT_MAX_TOKENS:-4096}"
ENFORCE_SCHEMA="${INPUT_ENFORCE_JSON_SCHEMA:-true}"
DIMENSION="${INPUT_DIMENSION:-}"
PROMPT_FILE="${INPUT_REVIEW_PROMPT_FILE:-}"
OVERVIEW="${INPUT_CODEBASE_OVERVIEW:-}"

# Resolve a prompts file by name across the Docker path, the repo layout, and CWD.
prompt_path() {
    local name="$1"
    if [ -f "/action/prompts/$name" ]; then echo "/action/prompts/$name"
    elif [ -f "$SCRIPT_DIR/../prompts/$name" ]; then echo "$SCRIPT_DIR/../prompts/$name"
    elif [ -f "code-review/prompts/$name" ]; then echo "code-review/prompts/$name"
    else echo ""; fi
}

# Per-dimension focus appended to the shared sub-reviewer base prompt.
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

# --- Determine the system prompt + the output schema for this mode ---
if [ -n "$PROMPT_FILE" ]; then
    if [[ "$PROMPT_FILE" == /* ]]; then PROMPT_PATH="$PROMPT_FILE"; else PROMPT_PATH="${GITHUB_WORKSPACE:-/github/workspace}/${PROMPT_FILE}"; fi
    if [ -f "$PROMPT_PATH" ]; then
        SYSTEM_PROMPT=$(cat "$PROMPT_PATH")
    else
        jq -nc --arg f "$PROMPT_FILE" '{error: ("Custom review prompt file not found: " + $f)}' >&2
        exit 1
    fi
    MODE="single"
elif [ -n "$DIMENSION" ]; then
    BASE=$(prompt_path "dimension-base.txt")
    if [ -z "$BASE" ]; then
        jq -nc '{error: "dimension-base.txt not found in image"}' >&2
        exit 1
    fi
    SYSTEM_PROMPT="$(cat "$BASE")

## Your dimension: ${DIMENSION}
$(dimension_focus "$DIMENSION")"
    MODE="dimension"
else
    CHECKLIST=$(prompt_path "review-checklist.txt")
    if [ -z "$CHECKLIST" ]; then
        jq -nc '{error: "No review prompt available — set INPUT_REVIEW_PROMPT_FILE or ship review-checklist.txt"}' >&2
        exit 1
    fi
    SYSTEM_PROMPT=$(cat "$CHECKLIST")
    MODE="single"
fi

# --- Build the user prompt from the diff data ---
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

# --- Output schema (shared finding item; mode-specific envelope) ---
FINDING_ITEM=$(jq -nc '{
    type: "object",
    required: ["path", "line", "severity", "text"],
    properties: {
        path: {type: "string"},
        line: {type: "integer"},
        end_line: {type: "integer"},
        severity: {type: "string", enum: ["blocker", "high", "medium", "low", "nit"]},
        category: {type: "string"},
        confidence: {type: "string", enum: ["high", "medium"]},
        quoted_line: {type: "string"},
        suggestion: {type: "string"},
        text: {type: "string"}
    }
}')

if [ "$MODE" = "dimension" ]; then
    SCHEMA=$(jq -nc --argjson item "$FINDING_ITEM" '{
        name: "code_review_dimension",
        schema: {
            type: "object",
            required: ["reasoning", "verdict", "findings"],
            properties: {
                reasoning: {type: "string"},
                verdict: {type: "string", enum: ["approved", "changes"]},
                findings: {type: "array", items: $item}
            }
        }
    }')
else
    SCHEMA=$(jq -nc --argjson item "$FINDING_ITEM" '{
        name: "code_review_verdict",
        schema: {
            type: "object",
            required: ["review_plan", "verdict", "findings", "other_checks", "top_must_fix"],
            properties: {
                review_plan: {type: "string"},
                verdict: {type: "string", enum: ["approved", "changes"]},
                findings: {type: "array", items: $item},
                other_checks: {type: "string"},
                top_must_fix: {type: "array", items: {type: "string"}}
            }
        }
    }')
fi

# The user prompt embeds the full diff and overflows ARG_MAX ("jq: Argument
# list too long") if passed via --argjson. Route both messages through temp
# files: --rawfile reads each verbatim as a JSON string (replacing `jq -Rs .`).
SYSTEM_FILE=$(mktemp)
USER_FILE=$(mktemp)
trap 'rm -f "$SYSTEM_FILE" "$USER_FILE"' EXIT
printf '%s\n' "$SYSTEM_PROMPT" > "$SYSTEM_FILE"
printf '%s\n' "$USER_PROMPT" > "$USER_FILE"

# Base body: model + fallback array + token cap (always — omitting max_tokens makes
# OpenRouter reserve the model's full output capacity against the credit budget).
BODY=$(jq -nc \
    --arg model "$MODEL" \
    --arg fallback "$FALLBACK_MODEL" \
    --argjson maxtok "$MAX_TOKENS" \
    --rawfile system "$SYSTEM_FILE" \
    --rawfile user "$USER_FILE" \
    '{
        model: $model,
        models: [$model, $fallback],
        messages: [
            {role: "system", content: $system},
            {role: "user", content: $user}
        ],
        temperature: 0.1,
        max_tokens: $maxtok
    }')

# Structured output: route only to providers that support it (require_parameters),
# unless the caller opted out.
if [ "$ENFORCE_SCHEMA" != "false" ]; then
    BODY=$(echo "$BODY" | jq -c --argjson schema "$SCHEMA" '
        . + {
            response_format: {type: "json_schema", json_schema: $schema},
            provider: {require_parameters: true, allow_fallbacks: true}
        }')
fi

echo "$BODY"
