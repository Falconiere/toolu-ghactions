#!/usr/bin/env bash
# providers/openai/build-request.sh — wrap envelope in OpenAI chat-completions body.
set -euo pipefail

ENVELOPE=$(cat)
SYSTEM=$(echo "$ENVELOPE" | jq -r '.system')
USER=$(echo "$ENVELOPE" | jq -r '.user')
MAX_TOKENS=$(echo "$ENVELOPE" | jq -r '.max_tokens')
ENFORCE=$(echo "$ENVELOPE" | jq -r '.enforce_json_schema')

FINDING_ITEM=$(jq -nc '{
    type: "object", required: ["path", "line", "severity", "text"],
    properties: {
        path: {type: "string"}, line: {type: "integer"}, end_line: {type: "integer"},
        severity: {type: "string", enum: ["blocker", "high", "medium", "low", "nit"]},
        category: {type: "string"}, confidence: {type: "string", enum: ["high", "medium"]},
        quoted_line: {type: "string"}, suggestion: {type: "string"}, text: {type: "string"}
    }
}')
SCHEMA=$(jq -nc --argjson item "$FINDING_ITEM" '{
    name: "code_review_verdict", strict: true,
    schema: {type: "object", required: ["review_plan", "verdict", "findings", "other_checks", "top_must_fix"],
        properties: {
            review_plan: {type: "string"},
            verdict: {type: "string", enum: ["approved", "changes"]},
            findings: {type: "array", items: $item},
            other_checks: {type: "string"},
            top_must_fix: {type: "array", items: {type: "string"}}
        }}
}')

SYS_ESC=$(echo "$SYSTEM" | jq -Rs .)
USER_ESC=$(echo "$USER" | jq -Rs .)

BODY=$(jq -nc \
    --arg model "${INPUT_MODEL:-gpt-4o}" \
    --argjson maxtok "$MAX_TOKENS" \
    --argjson system "$SYS_ESC" \
    --argjson user "$USER_ESC" \
    '{model: $model, messages: [{role:"system", content:$system}, {role:"user", content:$user}], temperature: 0.1, max_tokens: $maxtok}')

if [ "$ENFORCE" = "true" ]; then
    BODY=$(echo "$BODY" | jq -c --argjson schema "$SCHEMA" \
        '. + {response_format: {type: "json_schema", json_schema: $schema}}')
fi

echo "$BODY"
