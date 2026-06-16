#!/usr/bin/env bash
# call-openrouter.sh — POST the request body to OpenRouter chat completions API.
#
# Reads OPENROUTER_API_KEY from env.
# Reads request body from stdin (JSON from build-prompt.sh).
# Outputs to stdout: the OpenRouter JSON response.
# Exits non-zero on failure (auth error, timeout, non-200).
set -euo pipefail

API_KEY="${OPENROUTER_API_KEY:-}"
TIMEOUT_SEC="${OPENROUTER_TIMEOUT:-180}"
ENDPOINT="https://openrouter.ai/api/v1/chat/completions"

if [ -z "$API_KEY" ]; then
    echo '{"error":"OPENROUTER_API_KEY is not set"}' >&2
    exit 1
fi

REQUEST_BODY=$(cat)

# Validate that we have a non-empty request.
if [ -z "$REQUEST_BODY" ] || [ "$REQUEST_BODY" = "null" ]; then
    echo '{"error":"Empty request body — build-prompt.sh may have failed"}' >&2
    exit 1
fi

TMP_RESPONSE=$(mktemp)
TMP_HTTP_CODE=$(mktemp)

# Make the API call.
HTTP_CODE=$(curl -s -w '%{http_code}' -o "$TMP_RESPONSE" \
    --max-time "$TIMEOUT_SEC" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "$REQUEST_BODY" \
    "$ENDPOINT" 2>/dev/null || echo "000")

RESPONSE_BODY=$(cat "$TMP_RESPONSE")
rm -f "$TMP_RESPONSE" "$TMP_HTTP_CODE"

# Handle errors by HTTP status code.
case "$HTTP_CODE" in
    200|201)
        # Success — validate it's JSON.
        if ! echo "$RESPONSE_BODY" | jq -e . >/dev/null 2>&1; then
            echo "{\"error\":\"OpenRouter returned non-JSON response\",\"http_code\":$HTTP_CODE}" >&2
            exit 1
        fi
        echo "$RESPONSE_BODY"
        ;;
    401|403)
        echo "{\"error\":\"OpenRouter authentication failed\",\"http_code\":$HTTP_CODE}" >&2
        exit 1
        ;;
    429)
        echo "{\"error\":\"OpenRouter rate limited\",\"http_code\":$HTTP_CODE}" >&2
        exit 1
        ;;
    000)
        echo '{"error":"OpenRouter request timed out or connection failed"}' >&2
        exit 1
        ;;
    *)
        echo "{\"error\":\"OpenRouter API error\",\"http_code\":$HTTP_CODE,\"body\":\"$(echo "$RESPONSE_BODY" | jq -Rc .)\"}" >&2
        exit 1
        ;;
esac
