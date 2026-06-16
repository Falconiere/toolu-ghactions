#!/usr/bin/env bash
# providers/minimax/build-request.sh — OpenAI-compat, response_format: json_object (free-form).
set -euo pipefail

ENVELOPE=$(cat)
SYSTEM=$(echo "$ENVELOPE" | jq -r '.system')
USER=$(echo "$ENVELOPE" | jq -r '.user')
MAX_TOKENS=$(echo "$ENVELOPE" | jq -r '.max_tokens')
ENFORCE=$(echo "$ENVELOPE" | jq -r '.enforce_json_schema')

SYS_ESC=$(echo "$SYSTEM" | jq -Rs .)
USER_ESC=$(echo "$USER" | jq -Rs .)

BODY=$(jq -nc \
    --arg model "${INPUT_MODEL:-minimax/minimax-m3}" \
    --argjson maxtok "$MAX_TOKENS" \
    --argjson system "$SYS_ESC" \
    --argjson user "$USER_ESC" \
    '{model: $model, messages: [{role:"system", content:$system}, {role:"user", content:$user}], temperature: 0.1, max_tokens: $maxtok}')

if [ "$ENFORCE" = "true" ]; then
    BODY=$(echo "$BODY" | jq -c '. + {response_format: {type: "json_object"}}')
fi

echo "$BODY"
