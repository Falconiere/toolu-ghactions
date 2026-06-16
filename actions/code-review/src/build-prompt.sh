#!/usr/bin/env bash
# build-prompt.sh — assemble the system + user prompt into a valid JSON
# request body for the OpenRouter chat completions API.
#
# Reads INPUT_MODEL, INPUT_REVIEW_PROMPT, INPUT_CODEBASE_OVERVIEW from env.
# Reads diff data from stdin (JSON from fetch-diff.sh).
# Outputs to stdout: complete JSON request body.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

MODEL="${INPUT_MODEL:-anthropic/claude-sonnet-4}"
CUSTOM_PROMPT="${INPUT_REVIEW_PROMPT:-}"
OVERVIEW="${INPUT_CODEBASE_OVERVIEW:-}"
# Resolve checklist path: try Docker path first, then relative to script dir.
if [ -f "/action/prompts/review-checklist.txt" ]; then
    CHECKLIST_FILE="/action/prompts/review-checklist.txt"
elif [ -f "$SCRIPT_DIR/../prompts/review-checklist.txt" ]; then
    CHECKLIST_FILE="$SCRIPT_DIR/../prompts/review-checklist.txt"
elif [ -f "actions/code-review/prompts/review-checklist.txt" ]; then
    CHECKLIST_FILE="actions/code-review/prompts/review-checklist.txt"
else
    CHECKLIST_FILE=""
fi

# Read diff data.
DIFF_DATA=$(cat)

# Determine system prompt.
if [ -n "$CUSTOM_PROMPT" ]; then
    SYSTEM_PROMPT="$CUSTOM_PROMPT"
elif [ -f "$CHECKLIST_FILE" ]; then
    SYSTEM_PROMPT=$(cat "$CHECKLIST_FILE")
else
    echo '{"error":"No review prompt available — provide review-prompt input or ensure review-checklist.txt is in the image"}' >&2
    exit 1
fi

# Extract fields from diff data.
DIFF_TEXT=$(echo "$DIFF_DATA" | jq -r '.diff // ""')
CHANGED_FILES=$(echo "$DIFF_DATA" | jq -r '.changed_files | join(", ") // "none"')
BINARY_FILES=$(echo "$DIFF_DATA" | jq -r '.binary_files[]? // empty' || true)
TRUNCATED=$(echo "$DIFF_DATA" | jq -r '.truncated // false')
TOTAL_LINES=$(echo "$DIFF_DATA" | jq -r '.total_lines // 0')
TOTAL_FILES=$(echo "$DIFF_DATA" | jq -r '.total_files // 0')

# Build the user prompt.
USER_PROMPT="Review the following pull request diff."

if [ -n "$OVERVIEW" ]; then
    USER_PROMPT+="

## Codebase Overview
$OVERVIEW"
fi

USER_PROMPT+="

## Changed Files ($TOTAL_FILES total)
$CHANGED_FILES"

if [ -n "$BINARY_FILES" ]; then
    USER_PROMPT+="

## Binary Files (not reviewed)
$(echo "$BINARY_FILES" | while read -r f; do echo "- $f"; done)"
fi

if [ "$TRUNCATED" = "true" ]; then
    USER_PROMPT+="

[Diff truncated at $TOTAL_LINES lines; some files omitted. Review what is shown.]"
fi

USER_PROMPT+="

## Diff
\`\`\`diff
$DIFF_TEXT
\`\`\`"

# Escape for JSON.
SYSTEM_ESCAPED=$(echo "$SYSTEM_PROMPT" | jq -Rs .)
USER_ESCAPED=$(echo "$USER_PROMPT" | jq -Rs .)

jq -nc \
    --arg model "$MODEL" \
    --argjson system "$SYSTEM_ESCAPED" \
    --argjson user "$USER_ESCAPED" \
    '{
        model: $model,
        messages: [
            {role: "system", content: $system},
            {role: "user", content: $user}
        ],
        temperature: 0.1,
        response_format: {
            type: "json_schema",
            json_schema: {
                name: "code_review_verdict",
                schema: {
                    type: "object",
                    required: ["review_plan", "verdict", "findings", "other_checks", "top_must_fix"],
                    properties: {
                        review_plan: {type: "string"},
                        verdict: {type: "string", enum: ["approved", "changes"]},
                        findings: {
                            type: "array",
                            items: {
                                type: "object",
                                required: ["path", "severity", "text"],
                                properties: {
                                    path: {type: "string"},
                                    line: {type: "integer"},
                                    severity: {type: "string", enum: ["blocker", "high", "medium", "low", "nit"]},
                                    text: {type: "string"}
                                }
                            }
                        },
                        other_checks: {type: "string"},
                        top_must_fix: {
                            type: "array",
                            items: {type: "string"}
                        }
                    }
                }
            }
        }
    }'
