#!/usr/bin/env bash
# wait.sh — poll a URL until it responds with the expected status.
#
# Inputs (env):
#   INPUT_URL              URL to probe (typically ${{ steps.start.outputs.tunnel-url }})
#   INPUT_WAIT_TIMEOUT     seconds before giving up (default 60)
#   INPUT_EXPECTED_STATUS  status filter (default "2"):
#                           - single digit "2" → any 2xx
#                           - single digit "3" → any 3xx
#                           - exact "200" / "404" → that exact code
#
# Exit codes:
#   0  URL returned a matching status within timeout
#   1  timeout, URL never resolved, or status never matched
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

URL="${INPUT_URL:-}"
WAIT_TIMEOUT="${INPUT_WAIT_TIMEOUT:-60}"
EXPECTED="${INPUT_EXPECTED_STATUS:-2}"

if [ -z "$URL" ]; then
    fail "INPUT_URL is required"
fi

log "Waiting up to ${WAIT_TIMEOUT}s for $URL (status ~${EXPECTED})"

DEADLINE=$(( $(date +%s) + WAIT_TIMEOUT ))
SLEEP=1
LAST_STATUS=""
LAST_ERROR=""

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    # Capture status code; tolerate network errors (treat as transient).
    if STATUS=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --connect-timeout 5 "$URL" 2>/dev/null); then
        LAST_STATUS="$STATUS"
        if [ "${#EXPECTED}" -eq 1 ]; then
            # Prefix match: 2 matches 200, 201, 204, etc.
            if [ "${STATUS:0:1}" = "$EXPECTED" ]; then
                log "URL responded $STATUS (matches prefix $EXPECTED)"
                exit 0
            fi
        else
            if [ "$STATUS" = "$EXPECTED" ]; then
                log "URL responded $STATUS (exact match)"
                exit 0
            fi
        fi
    else
        LAST_ERROR="curl exit non-zero (DNS/connect error or timeout)"
    fi

    sleep "$SLEEP"
    # Exponential backoff, capped at 10s.
    SLEEP=$(( SLEEP * 2 ))
    [ "$SLEEP" -gt 10 ] && SLEEP=10
done

# Timeout.
{
    echo "ERROR: $URL did not respond with status ~${EXPECTED} within ${WAIT_TIMEOUT}s"
    [ -n "$LAST_STATUS" ] && echo "  last status: $LAST_STATUS"
    [ -n "$LAST_ERROR" ]  && echo "  last error:  $LAST_ERROR"
} >&2
exit 1
