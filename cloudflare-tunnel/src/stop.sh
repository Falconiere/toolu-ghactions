#!/usr/bin/env bash
# stop.sh — terminate a cloudflared tunnel started by start.sh.
#
# Inputs (env):
#   INPUT_NAME          instance name (must match the start step)
#   INPUT_STOP_TIMEOUT  seconds between SIGTERM and SIGKILL (default 5)
#
# Behavior:
#   1. Read PID from /tmp/cf-tunnel-<slug>.pid
#   2. SIGTERM the PID, wait INPUT_STOP_TIMEOUT, SIGKILL if still alive
#   3. pkill -f cloudflared as final fallback (catches PID-file mismatches)
#   4. Idempotent: missing PID file → exit 0
#
# Exit codes:
#   0  tunnel stopped (or was never running — idempotent)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

NAME="${INPUT_NAME:-}"
SLUG=$(slugify "$NAME")
STOP_TIMEOUT="${INPUT_STOP_TIMEOUT:-5}"

PID_FILE=$(pid_path "$SLUG")

# Idempotence: nothing to do.
if [ ! -f "$PID_FILE" ]; then
    log "No PID file at $PID_FILE — tunnel already stopped or never started"
    pkill -f cloudflared 2>/dev/null || true
    exit 0
fi

PID=$(cat "$PID_FILE")

# If the PID is no longer alive, clean up the file and exit clean.
if ! kill -0 "$PID" 2>/dev/null; then
    log "PID $PID not alive — removing stale PID file"
    rm -f "$PID_FILE"
    pkill -f cloudflared 2>/dev/null || true
    exit 0
fi

# Phase 1: graceful SIGTERM
log "Sending SIGTERM to cloudflared pid=$PID"
kill -TERM "$PID" 2>/dev/null || true

# Wait up to STOP_TIMEOUT for the process to exit.
WAITED=0
while [ "$WAITED" -lt "$STOP_TIMEOUT" ]; do
    if ! kill -0 "$PID" 2>/dev/null; then
        log "cloudflared exited after SIGTERM (waited ${WAITED}s)"
        rm -f "$PID_FILE"
        exit 0
    fi
    sleep 1
    WAITED=$((WAITED + 1))
done

# Phase 2: SIGKILL if still alive
log "PID $PID did not exit within ${STOP_TIMEOUT}s — sending SIGKILL"
kill -KILL "$PID" 2>/dev/null || true
sleep 1

# Phase 3: pkill fallback (handles PID reuse or stale file mismatches)
if kill -0 "$PID" 2>/dev/null; then
    log "PID $PID still alive — falling back to pkill -f cloudflared"
    pkill -f cloudflared 2>/dev/null || true
fi

rm -f "$PID_FILE"
log "Stop complete"
