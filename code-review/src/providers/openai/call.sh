#!/usr/bin/env bash
# providers/openai/call.sh — POST to OpenAI chat completions. Bearer auth, retry on 429/5xx/000, redact errors.
set -euo pipefail

API_KEY="${API_KEY:-}"
TIMEOUT_SEC="${OPENAI_TIMEOUT:-180}"
CONNECT_TIMEOUT="${OPENAI_CONNECT_TIMEOUT:-15}"
MAX_ATTEMPTS="${OPENAI_MAX_ATTEMPTS:-3}"
ENDPOINT="https://api.openai.com/v1/chat/completions"

if [ -z "$API_KEY" ]; then
    jq -nc '{error:"API_KEY is not set"}' >&2
    exit 1
fi

REQUEST_BODY=$(cat)
if [ -z "$REQUEST_BODY" ] || [ "$REQUEST_BODY" = "null" ]; then
    jq -nc '{error:"Empty request body"}' >&2
    exit 1
fi

TMP_BODY=$(mktemp); TMP_RESPONSE=$(mktemp); TMP_HEADERS=$(mktemp)
trap 'rm -f "$TMP_BODY" "$TMP_RESPONSE" "$TMP_HEADERS"' EXIT
printf '%s' "$REQUEST_BODY" > "$TMP_BODY"

safe_body() {
    head -c 800 "$TMP_RESPONSE" \
        | sed -E 's/(Bearer )[A-Za-z0-9._-]+/\1[REDACTED]/g; s/sk-[A-Za-z0-9._-]{6,}/[REDACTED]/g' \
        | head -c 200 | jq -Rsc . 2>/dev/null || echo '""'
}

attempt=1; HTTP_CODE="000"
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
    : > "$TMP_RESPONSE"; : > "$TMP_HEADERS"
    HTTP_CODE=$(curl -s -o "$TMP_RESPONSE" -D "$TMP_HEADERS" -w '%{http_code}' \
        --connect-timeout "$CONNECT_TIMEOUT" --max-time "$TIMEOUT_SEC" \
        -H "Authorization: Bearer $API_KEY" \
        -H "Content-Type: application/json" \
        --data-binary @"$TMP_BODY" "$ENDPOINT" 2>/dev/null || echo "000")

    case "$HTTP_CODE" in
        200|201)
            if ! jq -e . "$TMP_RESPONSE" >/dev/null 2>&1; then
                jq -nc --argjson hc "$HTTP_CODE" '{error:"OpenAI returned non-JSON", http_code:$hc}' >&2
                exit 1
            fi
            EMBEDDED=$(jq -r '.error.message // empty' "$TMP_RESPONSE" 2>/dev/null || true)
            if [ -n "$EMBEDDED" ] && [ "$EMBEDDED" != "null" ] \
                && ! echo "$EMBEDDED" | grep -qiE 'rate.?limit|context|temporarily|overloaded|timeout'; then
                jq -nc --arg e "$EMBEDDED" '{error:"OpenAI returned an embedded error", detail:$e}' >&2
                exit 1
            fi
            [ -z "$EMBEDDED" ] || [ "$EMBEDDED" = "null" ] && { cat "$TMP_RESPONSE"; exit 0; }
            : # transient embedded error — retry
            ;;
        401|403)
            jq -nc --argjson hc "$HTTP_CODE" '{error:"OpenAI authentication failed", http_code:$hc}' >&2
            exit 1 ;;
        400|402|404|408|422)
            jq -nc --argjson hc "$HTTP_CODE" --argjson b "$(safe_body)" '{error:"OpenAI request error", http_code:$hc, body:$b}' >&2
            exit 1 ;;
        429|5*|000) : ;;  # retry
        *)
            jq -nc --argjson hc "$HTTP_CODE" --argjson b "$(safe_body)" '{error:"OpenAI API error", http_code:$hc, body:$b}' >&2
            exit 1 ;;
    esac

    if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
        jq -nc --argjson hc "$HTTP_CODE" --argjson b "$(safe_body)" '{error:"OpenAI request failed", http_code:$hc, body:$b}' >&2
        exit 1
    fi

    RETRY_AFTER=$(grep -i '^retry-after:' "$TMP_HEADERS" 2>/dev/null | awk '{print $2}' | tr -d '\r' | head -1 || true)
    if [ -n "${RETRY_AFTER:-}" ] && [ "$RETRY_AFTER" -eq "$RETRY_AFTER" ] 2>/dev/null; then
        SLEEP="$RETRY_AFTER"
    else
        SLEEP="$((5 * attempt))"
    fi
    [ "$SLEEP" -gt 0 ] && sleep "$SLEEP"
    attempt=$((attempt + 1))
done
