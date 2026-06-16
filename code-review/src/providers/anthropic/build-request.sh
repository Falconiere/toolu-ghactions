#!/usr/bin/env bash
# providers/anthropic/build-request.sh — wrap envelope in Anthropic messages body.
#
# Structural differences from OpenAI-compat:
#   - system prompt is top-level, NOT in messages[]
#   - messages[] contains only user/assistant turns
#   - max_tokens is REQUIRED (always set)
#   - tool-use for structured output when enforce_json_schema=true
set -euo pipefail

ENVELOPE=$(cat)
SYSTEM=$(echo "$ENVELOPE" | jq -r '.system')
USER=$(echo "$ENVELOPE" | jq -r '.user')
MAX_TOKENS=$(echo "$ENVELOPE" | jq -r '.max_tokens')
ENFORCE=$(echo "$ENVELOPE" | jq -r '.enforce_json_schema')

SYS_ESC=$(echo "$SYSTEM" | jq -Rs .)
USER_ESC=$(echo "$USER" | jq -Rs .)

# Tool-use input schema (matches the review verdict envelope).
FINDING_ITEM=$(jq -nc '{
    type: "object", required: ["path", "line", "severity", "text"],
    properties: {
        path: {type: "string"}, line: {type: "integer"}, end_line: {type: "integer"},
        severity: {type: "string", enum: ["blocker", "high", "medium", "low", "nit"]},
        category: {type: "string"}, confidence: {type: "string", enum: ["high", "medium"]},
        quoted_line: {type: "string"}, suggestion: {type: "string"}, text: {type: "string"}
    }
}')
TOOL_SCHEMA=$(jq -nc --argjson item "$FINDING_ITEM" '{
    name: "submit_review",
    description: "Submit the structured code review verdict.",
    input_schema: {
        type: "object", required: ["review_plan", "verdict", "findings", "other_checks", "top_must_fix"],
        properties: {
            review_plan: {type: "string"},
            verdict: {type: "string", enum: ["approved", "changes"]},
            findings: {type: "array", items: $item},
            other_checks: {type: "string"},
            top_must_fix: {type: "array", items: {type: "string"}}
        }
    }
}')

BODY=$(jq -nc \
    --arg model "${INPUT_MODEL:-claude-sonnet-4-5}" \
    --argjson maxtok "$MAX_TOKENS" \
    --argjson system "$SYS_ESC" \
    --argjson user "$USER_ESC" \
    '{
        model: $model,
        system: $system,
        messages: [{role: "user", content: $user}],
        max_tokens: $maxtok,
        temperature: 0.0
    }')

if [ "$ENFORCE" = "true" ]; then
    BODY=$(echo "$BODY" | jq -c --argjson schema "$TOOL_SCHEMA" \
        '. + {tools: [$schema], tool_choice: {type: "tool", name: "submit_review"}}')
fi

echo "$BODY"
