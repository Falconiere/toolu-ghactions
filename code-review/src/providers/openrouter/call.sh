#!/usr/bin/env bash
# providers/openrouter/call.sh — POST the request body to OpenRouter chat completions.
#
# Reads $API_KEY (Bearer token), the request body JSON from stdin.
# Writes the OpenRouter JSON response to stdout; exits non-zero on failure.
# Retry with backoff on 429/5xx/000; redact Authorization tokens in error bodies.
set -euo pipefail

API_KEY="${API_KEY:-}"
TIMEOUT_SEC="${OPENROUTER_TIMEOUT:-180}"
CONNECT_TIMEOUT="${OPENROUTER_CONNECT_TIMEOUT:-15}"
BACKOFF_BASE="${BACKOFF_BASE:-5}"
MAX_ATTEMPTS="${OPENROUTER_MAX_ATTEMPTS:-3}"
ENDPOINT="https://openrouter.ai/api/v1/chat/completions"

if [ -z "$API_KEY" ]; then
    jq -nc '{error:"API_KEY is not set (run-provider.sh should set this from the entry)"}' >&2
    exit 1
fi

REQUEST_BODY=$(cat)
if [ -z "$REQUEST_BODY" ] || [ "$REQUEST_BODY" = "null" ]; then
    jq -nc '{error:"Empty request body — build-prompt.sh or build-request.sh may have failed"}' >&2
    exit 1
fi

TMP_BODY=$(mktemp)
TMP_RESPONSE=$(mktemp)
TMP_HEADERS=$(mktemp)
trap 'rm -f "$TMP_BODY" "$TMP_RESPONSE" "$TMP_HEADERS"' EXIT
printf '%s' "$REQUEST_BODY" > "$TMP_BODY"

safe_body() {
    head -c 800 "$TMP_RESPONSE" \
        | sed -E 's/(Bearer )[A-Za-z0-9._-]+/\1[REDACTED]/g; s/sk-[A-Za-z0-9._-]{6,}/[REDACTED]/g' \
        | head -c 200 \
        | jq -Rsc . 2>/dev/null || echo '""'
}

attempt=1
HTTP_CODE="000"
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
    : > "$TMP_RESPONSE"; : > "$TMP_HEADERS"
    HTTP_CODE=$(curl -s -o "$TMP_RESPONSE" -D "$TMP_HEADERS" -w '%{http_code}' \
        --connect-timeout "$CONNECT_TIMEOUT" --max-time "$TIMEOUT_SEC" \
        -H "Authorization: Bearer $API_KEY" \
        -H "Content-Type: application/json" \
        --data-binary @"$TMP_BODY" \
        "$ENDPOINT" 2>/dev/null || echo "000")

    case "$HTTP_CODE" in
        200|201)
            if ! jq -e . "$TMP_RESPONSE" >/dev/null 2>&1; then
                jq -nc --argjson hc "$HTTP_CODE" '{error:"OpenRouter returned non-JSON response", http_code:$hc}' >&2
                exit 1
            fi
            EMBEDDED=$(jq -r '.error.message // (.error | strings) // empty' "$TMP_RESPONSE" 2>/dev/null || true)
            if [ -n "$EMBEDDED" ] && [ "$EMBEDDED" != "null" ]; then
                if echo "$EMBEDDED" | grep -qiE 'rate.?limit|context|temporarily|overloaded|timeout'; then
                    : # transient — retry
                else
                    jq -nc --arg e "$EMBEDDED" '{error:"OpenRouter returned an embedded error", detail:$e}' >&2
                    exit 1
                fi
            else
                cat "$TMP_RESPONSE"
                exit 0
            fi
            ;;
        401|403)
            jq -nc --argjson hc "$HTTP_CODE" '{error:"OpenRouter authentication failed", http_code:$hc}' >&2
            exit 1 ;;
        400|402|404|408|422)
            jq -nc --argjson hc "$HTTP_CODE" --argjson b "$(safe_body)" '{error:"OpenRouter request error", http_code:$hc, body:$b}' >&2
            exit 1 ;;
        429|5*|000) : ;;  # retry
        *)
            jq -nc --argjson hc "$HTTP_CODE" --argjson b "$(safe_body)" '{error:"OpenRouter API error", http_code:$hc, body:$b}' >&2
            exit 1 ;;
    esac

    if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
        jq -nc --argjson hc "$HTTP_CODE" --argjson b "$(safe_body)" --argjson ma "$MAX_ATTEMPTS" \
            '{error:"OpenRouter request failed after attempts", http_code:$hc, body:$b, attempts:$ma}' >&2
        exit 1
    fi

    RETRY_AFTER=$(grep -i '^retry-after:' "$TMP_HEADERS" 2>/dev/null | awk '{print $2}' | tr -d '\r' | head -1 || true)
    if [ -n "${RETRY_AFTER:-}" ] && [ "$RETRY_AFTER" -eq "$RETRY_AFTER" ] 2>/dev/null; then
        SLEEP="$RETRY_AFTER"
    else
        SLEEP="$((BACKOFF_BASE * attempt))"
    fi
    [ "$SLEEP" -gt 0 ] && sleep "$SLEEP"
    attempt=$((attempt + 1))
done
