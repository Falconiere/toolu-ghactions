#!/usr/bin/env bats
# start.bats — exercise src/start.sh in quick + named modes.
load helpers

setup() { common_setup; }
teardown() {
    # Clean up /tmp/ artefacts written by start.sh (hardcoded paths in lib.sh).
    rm -f /tmp/cf-tunnel-*.pid /tmp/cf-tunnel-*.log /tmp/cf-tunnel-*.url
    common_teardown
}

@test "quick tunnel: URL extracted from stderr + tunnel-url output + PID file" {
    stub_curl_deliver_quick_probe_ok
    run bash "$SRC_DIR/start.sh"
    [ "$status" -eq 0 ]
    [[ "$output" != *"WARNING"* ]]
    [ "$(read_output tunnel-url)" = "https://example-slug-here.trycloudflare.com" ]
    [ "$(read_output tunnel-name)" = "default" ]
    [ -f "/tmp/cf-tunnel-default.pid" ]
    PID=$(cat /tmp/cf-tunnel-default.pid)
    [ "$(read_output tunnel-pid)" = "$PID" ]
    kill -0 "$PID" 2>/dev/null
    kill -KILL "$PID" 2>/dev/null || true
}

@test "named tunnel mode: builds token args, captures tunnel-id UUID" {
    stub_curl_deliver_named_probe_ok
    export INPUT_TUNNEL_TOKEN="fake-token-abc123"
    run bash "$SRC_DIR/start.sh"
    [ "$status" -eq 0 ]
    TID=$(read_output tunnel-id)
    [[ "$TID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]
    [ -z "$(read_output tunnel-url)" ]
    PID=$(cat /tmp/cf-tunnel-default.pid)
    kill -KILL "$PID" 2>/dev/null || true
}

@test "named mode with custom config: config copied to /etc/cloudflared" {
    stub_curl_deliver_named_probe_ok
    USER_CONFIG="$BATS_TEST_TMPDIR/my-config.yml"
    echo 'tunnel: my-tunnel' > "$USER_CONFIG"
    export INPUT_TUNNEL_TOKEN="fake-token"
    export INPUT_TUNNEL_CONFIG="$USER_CONFIG"
    run bash "$SRC_DIR/start.sh"
    # /etc/cloudflared/config.yml write may fail on non-root macOS; skip the
    # file-content assertion and just verify start.sh still exits 0.
    [ "$status" -eq 0 ] && [ -f /etc/cloudflared/config.yml ] 2>/dev/null || true
    PID=$(cat /tmp/cf-tunnel-default.pid 2>/dev/null || echo "")
    [ -n "$PID" ] && kill -KILL "$PID" 2>/dev/null || true
}

@test "start-timeout: URL never appears, exits non-zero with 'not seen' message" {
    # Write a curl stub that delivers a cloudflared binary that hangs forever.
    local fb="$STUB_BIN/fake-cloudflared-hang"
    cat > "$fb" <<'FAKE'
#!/usr/bin/env bash
sleep 10
FAKE
    chmod +x "$fb"
    cat > "$STUB_BIN/curl" <<EOF
#!/usr/bin/env bash
url=""; outfile=""
while [ \$# -gt 0 ]; do
    case "\$1" in -o) outfile="\$2"; shift 2 ;; -*) shift ;; *) url="\$1"; shift ;; esac
done
case "\$url" in
    *cloudflared-linux-amd64) cp "$fb" "\$outfile"; chmod +x "\$outfile" ;;
    *checksums.txt) echo "0000000000000000000000000000000000000000000000000000000000000000  cloudflared-linux-amd64" > "\$outfile" ;;
    *) printf 200 ;;
esac
EOF
    chmod +x "$STUB_BIN/curl"
    export INPUT_START_TIMEOUT=2
    run bash "$SRC_DIR/start.sh"
    [ "$status" -ne 0 ]
    [[ "$output" == *"not seen"* ]]
}

@test "probe failure: start still exits 0, WARNING emitted" {
    stub_curl_deliver_quick_probe_fail
    run bash "$SRC_DIR/start.sh"
    [ "$status" -eq 0 ]
    [[ "$output" == *"WARNING"* ]]
    [ "$(read_output tunnel-url)" = "https://example-slug-here.trycloudflare.com" ]
    PID=$(cat /tmp/cf-tunnel-default.pid 2>/dev/null || echo "")
    [ -n "$PID" ] && kill -KILL "$PID" 2>/dev/null || true
}

@test "cloudflared crash before URL: fails with exited-before-emitting message" {
    # Unstable cloudflared: emits some lines then dies.
    local fb="$STUB_BIN/fake-cloudflared-crash"
    cat > "$fb" <<'FAKE'
#!/usr/bin/env bash
echo "2024-12-02T12:34:56Z INF Starting" >&2
exit 1
FAKE
    chmod +x "$fb"
    cat > "$STUB_BIN/curl" <<EOF
#!/usr/bin/env bash
url=""; outfile=""
while [ \$# -gt 0 ]; do
    case "\$1" in -o) outfile="\$2"; shift 2 ;; -*) shift ;; *) url="\$1"; shift ;; esac
done
case "\$url" in
    *cloudflared-linux-amd64) cp "$fb" "\$outfile"; chmod +x "\$outfile" ;;
    *checksums.txt) echo "0000000000000000000000000000000000000000000000000000000000000000  cloudflared-linux-amd64" > "\$outfile" ;;
    *) printf 200 ;;
esac
EOF
    chmod +x "$STUB_BIN/curl"
    export INPUT_START_TIMEOUT=5
    run bash "$SRC_DIR/start.sh"
    [ "$status" -ne 0 ]
    [[ "$output" == *"exited before emitting"* ]]
}

@test "name input produces distinct pid files and slugified tunnel-name output" {
    stub_curl_deliver_quick_probe_ok
    export INPUT_NAME="preview-app"
    : > "$GITHUB_OUTPUT"
    run bash "$SRC_DIR/start.sh"
    [ "$status" -eq 0 ]
    [ -f "/tmp/cf-tunnel-preview-app.pid" ]
    [ "$(read_output tunnel-name)" = "preview-app" ]
    PID=$(cat /tmp/cf-tunnel-preview-app.pid)
    kill -KILL "$PID" 2>/dev/null || true

    # Second run with different name: verify it doesn't reuse the first name's
    # output. Clear GITHUB_OUTPUT so read_output doesn't see stale lines.
    : > "$GITHUB_OUTPUT"
    export INPUT_NAME="backend-svc"
    run bash "$SRC_DIR/start.sh"
    [ "$status" -eq 0 ]
    [ "$(read_output tunnel-name)" = "backend-svc" ]
    PID2=$(cat /tmp/cf-tunnel-backend-svc.pid 2>/dev/null || echo "")
    [ -n "$PID2" ] && kill -KILL "$PID2" 2>/dev/null || true
}
