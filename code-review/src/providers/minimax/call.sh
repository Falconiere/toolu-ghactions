#!/usr/bin/env bash
# providers/minimax/call.sh — POST to minimax (api.minimax.io, OpenAI-compat). Bearer auth, retry, redact.
set -euo pipefail

API_KEY="${API_KEY:-}"
TIMEOUT_SEC="${MINIMAX_TIMEOUT:-180}"
CONNECT_TIMEOUT="${MINIMAX_CONNECT_TIMEOUT:-15}"
MAX_ATTEMPTS="${MINIMAX_MAX_ATTEMPTS:-3}"
ENDPOINT="https://api.minimax.io/v1/chat/completions"

[ -n "$API_KEY" ] || { jq -nc '{error:"API_KEY is not set"}' >&2; exit 1; }

REQUEST_BODY=$(cat)
[ -n "$REQUEST_BODY" ] && [ "$REQUEST_BODY" != "null" ] || { jq -nc '{error:"Empty request body"}' >&2; exit 1; }

TMP_BODY=$(mktemp); TMP_RESPONSE=$(mktemp); TMP_HEADERS=$(mktemp)
trap 'rm -f "$TMP_BODY" "$TMP_RESPONSE" "$TMP_HEADERS"' EXIT
printf '%s' "$REQUEST_BODY" > "$TMP_BODY"

safe_body() { head -c 800 "$TMP_RESPONSE" | sed -E 's/(Bearer )[A-Za-z0-9._-]+/\1[REDACTED]/g; s/sk-[A-Za-z0-9._-]{6,}/[REDACTED]/g' | head -c 200 | jq -Rsc . 2>/dev/null || echo '""'; }

attempt=1; HTTP_CODE="000"
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
    : > "$TMP_RESPONSE"; : > "$TMP_HEADERS"
    HTTP_CODE=$(curl -s -o "$TMP_RESPONSE" -D "$TMP_HEADERS" -w '%{http_code}' \
        --connect-timeout "$CONNECT_TIMEOUT" --max-time "$TIMEOUT_SEC" \
        -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
        --data-binary @"$TMP_BODY" "$ENDPOINT" 2>/dev/null || echo "000")

    case "$HTTP_CODE" in
        200|201)
            if ! jq -e . "$TMP_RESPONSE" >/dev/null 2>&1; then
                jq -nc --argjson hc "$HTTP_CODE" '{error:"minimax returned non-JSON", http_code:$hc}' >&2; exit 1
            fi
            EMBEDDED=$(jq -r '.error.message // empty' "$TMP_RESPONSE" 2>/dev/null || true)
            if [ -n "$EMBEDDED" ] && [ "$EMBEDDED" != "null" ] \
                && ! echo "$EMBEDDED" | grep -qiE 'rate.?limit|context|temporarily|overloaded|timeout'; then
                jq -nc --arg e "$EMBEDDED" '{error:"minimax returned an embedded error", detail:$e}' >&2; exit 1
            fi
            [ -z "$EMBEDDED" ] || [ "$EMBEDDED" = "null" ] && { cat "$TMP_RESPONSE"; exit 0; }
            ;;
        401|403) jq -nc --argjson hc "$HTTP_CODE" '{error:"minimax authentication failed", http_code:$hc}' >&2; exit 1 ;;
        400|402|404|408|422) jq -nc --argjson hc "$HTTP_CODE" --argjson b "$(safe_body)" '{error:"minimax request error", http_code:$hc, body:$b}' >&2; exit 1 ;;
        429|5*|000) : ;;
        *) jq -nc --argjson hc "$HTTP_CODE" --argjson b "$(safe_body)" '{error:"minimax API error", http_code:$hc, body:$b}' >&2; exit 1 ;;
    esac

    [ "$attempt" -ge "$MAX_ATTEMPTS" ] && { jq -nc --argjson hc "$HTTP_CODE" --argjson b "$(safe_body)" '{error:"minimax request failed", http_code:$hc, body:$b}' >&2; exit 1; }
    RETRY_AFTER=$(grep -i '^retry-after:' "$TMP_HEADERS" 2>/dev/null | awk '{print $2}' | tr -d '\r' | head -1 || true)
    if [ -n "${RETRY_AFTER:-}" ] && [ "$RETRY_AFTER" -eq "$RETRY_AFTER" ] 2>/dev/null; then SLEEP="$RETRY_AFTER"; else SLEEP="$((5 * attempt))"; fi
    [ "$SLEEP" -gt 0 ] && sleep "$SLEEP"
    attempt=$((attempt + 1))
done
