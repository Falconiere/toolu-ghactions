#!/usr/bin/env bash
# start.sh — boot a Cloudflare Tunnel and emit outputs.
#
# Mode selection:
#   - INPUT_TUNNEL_TOKEN unset/empty  → quick tunnel (`--url http://localhost:$PORT`)
#   - INPUT_TUNNEL_TOKEN set          → named tunnel (`--token $TUNNEL_TOKEN`),
#                                       optional INPUT_TUNNEL_CONFIG written to
#                                       /etc/cloudflared/config.yml
#
# Inputs (env, mapped from action.yml):
#   INPUT_NAME              instance name (slugified for tmpfile paths)
#   INPUT_HOST              local host for quick mode (default localhost)
#   INPUT_PORT              local port for quick mode (default 3000)
#   INPUT_TUNNEL_TOKEN      named-tunnel token (optional)
#   INPUT_TUNNEL_CONFIG     path to user-supplied config.yml (named mode only)
#   INPUT_START_TIMEOUT     seconds to wait for URL/ID before failing (default 30)
#
# Outputs (written to $GITHUB_OUTPUT):
#   tunnel-url    public URL (quick mode; empty in named mode)
#   tunnel-id     tunnel UUID (named mode; empty in quick mode)
#   tunnel-pid    PID of the cloudflared process
#   tunnel-name   slugified instance name
#
# Exit codes:
#   0  success (URL/ID captured within timeout; probe failures are warnings only)
#   1  install / mode-setup failure, or URL/ID never seen within timeout
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

NAME="${INPUT_NAME:-}"
SLUG=$(slugify "$NAME")
NAME_FOR_OUTPUT="$SLUG"
HOST="${INPUT_HOST:-localhost}"
PORT="${INPUT_PORT:-3000}"
TUNNEL_TOKEN="${INPUT_TUNNEL_TOKEN:-}"
TUNNEL_CONFIG="${INPUT_TUNNEL_CONFIG:-}"
START_TIMEOUT="${INPUT_START_TIMEOUT:-30}"
PROTOCOL="${INPUT_PROTOCOL:-}"

PID_FILE=$(pid_path "$SLUG")
URL_FILE=$(url_path "$SLUG")
LOG_FILE=$(log_path "$SLUG")

GITHUB_OUTPUT="${GITHUB_OUTPUT:-/dev/stdout}"

# --- Phase 1: install cloudflared ---
bash "$SCRIPT_DIR/install-cloudflared.sh"

# --- Phase 2: assemble cloudflared arguments ---
CLOUDFLARED_ARGS=(--no-autoupdate)

if [ -n "$TUNNEL_TOKEN" ]; then
    # Named-tunnel mode: requires a token, optional config.
    CLOUDFLARED_ARGS+=(tunnel run --token "$TUNNEL_TOKEN")
    if [ -n "$TUNNEL_CONFIG" ]; then
        if [ ! -f "$TUNNEL_CONFIG" ]; then
            fail "tunnel config not found: $TUNNEL_CONFIG"
        fi
        mkdir -p /etc/cloudflared
        cp "$TUNNEL_CONFIG" /etc/cloudflared/config.yml
        CLOUDFLARED_ARGS+=(--config /etc/cloudflared/config.yml)
    fi
    OUTPUT_FIELD="tunnel-id"
else
    # Quick-tunnel mode: ephemeral URL, no auth needed. HOST:PORT resolves on
    # the runner host (composite action), so it reaches the app under test.
    CLOUDFLARED_ARGS+=(tunnel --url "http://${HOST}:${PORT}")
    OUTPUT_FIELD="tunnel-url"
fi

# Optional transport override. Quick tunnels default to QUIC (UDP 7844); on
# networks that block/throttle outbound UDP, cloudflared retries QUIC for ~5min
# before falling back to http2 — long past any sane start-timeout, so the tunnel
# never registers. Setting protocol=http2 (TCP 443) avoids that stall. Empty
# leaves cloudflared's default (quick tunnels force QUIC).
if [ -n "$PROTOCOL" ]; then
    CLOUDFLARED_ARGS+=(--protocol "$PROTOCOL")
fi

# --- Phase 3: spawn cloudflared, detached so it outlives this step ---
# nohup + </dev/null detaches from the step's controlling shell: when the
# composite step's bash exits, cloudflared is reparented to init and keeps
# running, so later steps (and other jobs, via the public URL) can use the
# tunnel. Portable to bash 3.2 (macOS) — no setsid/disown.
log "Starting cloudflared (mode: $([ -n "$TUNNEL_TOKEN" ] && echo named || echo quick))..."
: > "$LOG_FILE"
nohup cloudflared "${CLOUDFLARED_ARGS[@]}" >>"$LOG_FILE" 2>&1 </dev/null &
PID=$!
echo "$PID" > "$PID_FILE"
log "Spawned cloudflared pid=$PID, log=$LOG_FILE"

# --- Phase 4: wait for URL/ID to appear in log ---
TUNNEL_URL=""
TUNNEL_ID=""
DEADLINE=$(( $(date +%s) + START_TIMEOUT ))

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    if ! kill -0 "$PID" 2>/dev/null; then
        fail "cloudflared exited before emitting tunnel info" "$(tail -50 "$LOG_FILE")"
    fi

    if [ "$OUTPUT_FIELD" = "tunnel-url" ]; then
        TUNNEL_URL=$(grep -oE "$TUNNEL_URL_REGEX" "$LOG_FILE" | head -1 || true)
        if [ -n "$TUNNEL_URL" ]; then
            break
        fi
    else
        TUNNEL_ID=$(grep -oE "$TUNNEL_ID_REGEX" "$LOG_FILE" | head -1 || true)
        if [ -n "$TUNNEL_ID" ]; then
            break
        fi
    fi

    sleep 0.5
done

if [ "$OUTPUT_FIELD" = "tunnel-url" ] && [ -z "$TUNNEL_URL" ]; then
    kill -KILL "$PID" 2>/dev/null || true
    fail "tunnel URL not seen within ${START_TIMEOUT}s" "$(tail -50 "$LOG_FILE")"
fi
if [ "$OUTPUT_FIELD" = "tunnel-id" ] && [ -z "$TUNNEL_ID" ]; then
    kill -KILL "$PID" 2>/dev/null || true
    fail "tunnel ID not seen within ${START_TIMEOUT}s" "$(tail -50 "$LOG_FILE")"
fi

# --- Phase 4b: wait for edge-connection registration ---
# The URL/ID above appears before the tunnel actually connects to the Cloudflare
# edge. Returning now would publish a not-yet-live URL and let the Phase 5 probe
# resolve an unpublished hostname — poisoning the resolver with a cached NXDOMAIN
# that lingers through a downstream `wait` step's whole window. Block until the
# first "Registered tunnel connection" so readiness means "live at the edge".
REGISTERED=""
REG_DEADLINE=$(( $(date +%s) + START_TIMEOUT ))
while [ "$(date +%s)" -lt "$REG_DEADLINE" ]; do
    if ! kill -0 "$PID" 2>/dev/null; then
        fail "cloudflared exited before registering a tunnel connection" "$(tail -50 "$LOG_FILE")"
    fi
    if grep -qE "$TUNNEL_REGISTERED_REGEX" "$LOG_FILE"; then
        REGISTERED=1
        break
    fi
    sleep 0.5
done
if [ -z "$REGISTERED" ]; then
    kill -KILL "$PID" 2>/dev/null || true
    fail "tunnel connection not registered within ${START_TIMEOUT}s" "$(tail -50 "$LOG_FILE")"
fi
log "Edge connection registered"

# --- Phase 5: persist + best-effort probe ---
[ -n "$TUNNEL_URL" ] && printf '%s\n' "$TUNNEL_URL" > "$URL_FILE"
log "Captured $OUTPUT_FIELD=$( [ "$OUTPUT_FIELD" = "tunnel-url" ] && echo "$TUNNEL_URL" || echo "$TUNNEL_ID" )"

if [ "$OUTPUT_FIELD" = "tunnel-url" ] && [ -n "$TUNNEL_URL" ]; then
    # Non-fatal probe: confirms tunnel is reachable from inside the container.
    # Failure here means the cloudflared process may have died or DNS/routing
    # is broken — surface as warning, not failure (user steps can still try).
    # Capture curl exit code for diagnostics: 1=protocol, 3=malformed URL,
    # 6=can't resolve host, 7=connect refused, 28=timeout, 22=4xx/5xx.
    if ! curl -fsS --max-time 5 -o /dev/null "$TUNNEL_URL"; then
        rc=$?
        log "WARNING: probe of $TUNNEL_URL failed (curl exit $rc — see $LOG_FILE)"
    fi
fi

# --- Phase 6: emit outputs ---
{
    echo "tunnel-url=${TUNNEL_URL}"
    echo "tunnel-id=${TUNNEL_ID}"
    echo "tunnel-pid=${PID}"
    echo "tunnel-name=${NAME_FOR_OUTPUT}"
} >> "$GITHUB_OUTPUT"

log "Done. tunnel-name=$NAME_FOR_OUTPUT tunnel-pid=$PID"
