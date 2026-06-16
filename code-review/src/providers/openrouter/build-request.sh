#!/usr/bin/env bash
# providers/openrouter/build-request.sh — wrap the envelope in OpenRouter's chat-completions body.
#
# Reads the envelope JSON (from build-prompt.sh) on stdin.
# Reads INPUT_MODEL (the OpenRouter model id) and INPUT_PROVIDER from env.
# Writes the OpenRouter request body JSON to stdout.
#
# Wire format: POST https://openrouter.ai/api/v1/chat/completions
# Schema strictness: response_format.json_schema when enforce_json_schema=true.
set -euo pipefail

ENVELOPE=$(cat)

SYSTEM=$(echo "$ENVELOPE" | jq -r '.system')
USER=$(echo "$ENVELOPE" | jq -r '.user')
MAX_TOKENS=$(echo "$ENVELOPE" | jq -r '.max_tokens')
ENFORCE=$(echo "$ENVELOPE" | jq -r '.enforce_json_schema')

# Review finding item schema (shared across providers).
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

SYS_ESC=$(echo "$SYSTEM" | jq -Rs .)
USER_ESC=$(echo "$USER" | jq -Rs .)

BODY=$(jq -nc \
    --arg model "${INPUT_MODEL:-minimax/minimax-m3}" \
    --argjson maxtok "$MAX_TOKENS" \
    --argjson system "$SYS_ESC" \
    --argjson user "$USER_ESC" \
    '{
        model: $model,
        messages: [
            {role: "system", content: $system},
            {role: "user", content: $user}
        ],
        temperature: 0.1,
        max_tokens: $maxtok
    }')

if [ "$ENFORCE" = "true" ]; then
    BODY=$(echo "$BODY" | jq -c --argjson schema "$SCHEMA" \
        '. + {response_format: {type: "json_schema", json_schema: $schema}, provider: {require_parameters: true}}')
fi

echo "$BODY"
