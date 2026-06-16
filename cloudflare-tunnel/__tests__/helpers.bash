#!/usr/bin/env bash
# helpers.bash — bats setup for cloudflare-tunnel tests.
#
# Strategy:
#   - Stub curl (intercept network) on PATH. curl handles three URL classes:
#     (a) *cloudflared-linux-amd64 → copy a pre-built fake binary to -o target
#     (b) *checksums.txt → write a synthetic checksum manifest to -o target
#     (c) anything else → return HTTP 200 (probe-success) or fail (probe-fail)
#   - Fake cloudflared binary is a bash script that cats the fixture stderr +
#     sleeps. Written at setup time; curl stub copies it.
#   - install-cloudflared.sh respects INSTALL_DEST for hermetic installs.
#   - All replay data is real cloudflared stderr from fixtures/.
common_setup() {
    BATS_TEST_TMPDIR="${BATS_TEST_TMPDIR:-$(mktemp -d)}"
    export BATS_TEST_TMPDIR
    ORIG_PATH="$PATH"
    STUB_BIN="$BATS_TEST_TMPDIR/bin"
    mkdir -p "$STUB_BIN"
    export PATH="$STUB_BIN:$PATH"

    export INSTALL_DEST="$STUB_BIN/cloudflared"

    export GITHUB_OUTPUT="$BATS_TEST_TMPDIR/output"
    : > "$GITHUB_OUTPUT"

    export INPUT_CLOUDFLARED_VERSION="${INPUT_CLOUDFLARED_VERSION:-2024.12.2}"
    export INPUT_VERIFY_CHECKSUM="${INPUT_VERIFY_CHECKSUM:-false}"
    export INPUT_START_TIMEOUT="${INPUT_START_TIMEOUT:-10}"
    export INPUT_WAIT_TIMEOUT="${INPUT_WAIT_TIMEOUT:-5}"
    export INPUT_STOP_TIMEOUT="${INPUT_STOP_TIMEOUT:-2}"

    export HELPERS_DIR="${BATS_TEST_DIRNAME}"
    export FIXTURES_DIR="${BATS_TEST_DIRNAME}/fixtures"
    export SRC_DIR="$(cd "${BATS_TEST_DIRNAME}/../src" && pwd)"
}

common_teardown() {
    [ -n "${ORIG_PATH:-}" ] && export PATH="$ORIG_PATH"
}

# Pre-write a fake cloudflared binary at a known path so the curl stub can
# `cp` it to the install destination without nested heredocs.
_write_fake_cloudflared() {
    local fixture="$1"
    local dest="$STUB_BIN/fake-cloudflared"
    cat > "$dest" <<FAKE
#!/usr/bin/env bash
cat "$fixture"
sleep 5
FAKE
    chmod +x "$dest"
    printf '%s\n' "$dest"
}

# --- curl stubs that handle *both* download and probe ---

# Curl stub: download works, probe returns HTTP 200 (success).
_stub_curl_deliver_and_probe() {
    local fake_bin="$1"
    local probe_status="$2"   # e.g. "200" or "exit 7"
    cat > "$STUB_BIN/curl" <<EOF
#!/usr/bin/env bash
url=""
outfile=""
while [ \$# -gt 0 ]; do
    case "\$1" in
        -o) outfile="\$2"; shift 2 ;;
        -*) shift ;;
        *)  url="\$1"; shift ;;
    esac
done
case "\$url" in
    *cloudflared-linux-amd64)
        cp "$fake_bin" "\$outfile"
        chmod +x "\$outfile"
        ;;
    *checksums.txt)
        echo "0000000000000000000000000000000000000000000000000000000000000000  cloudflared-linux-amd64" > "\$outfile"
        ;;
    *)
        $probe_status
        ;;
esac
EOF
    chmod +x "$STUB_BIN/curl"
}

# Download works, probe returns 200.
stub_curl_deliver_quick_probe_ok() {
    local fb; fb=$(_write_fake_cloudflared "$FIXTURES_DIR/cloudflared-stderr-quick.log")
    _stub_curl_deliver_and_probe "$fb" 'printf 200'
}

stub_curl_deliver_named_probe_ok() {
    local fb; fb=$(_write_fake_cloudflared "$FIXTURES_DIR/cloudflared-stderr-named.log")
    _stub_curl_deliver_and_probe "$fb" 'printf 200'
}

# Download works, probe fails (network error).
stub_curl_deliver_quick_probe_fail() {
    local fb; fb=$(_write_fake_cloudflared "$FIXTURES_DIR/cloudflared-stderr-quick.log")
    _stub_curl_deliver_and_probe "$fb" 'exit 7'
}

# --- Single-purpose curl stubs (for install-cloudflared.bats, wait.bats) ---

# Curl always fails download.
stub_curl_fail_download() {
    cat > "$STUB_BIN/curl" <<'SCRIPT'
#!/usr/bin/env bash
echo "stub curl: download failed" >&2
exit 22
SCRIPT
    chmod +x "$STUB_BIN/curl"
}

# Curl delivers a corrupted binary + real checksum (mismatch → fail).
stub_curl_corrupt_binary() {
    cat > "$STUB_BIN/curl" <<'SCRIPT'
#!/usr/bin/env bash
url=""; outfile=""
while [ $# -gt 0 ]; do
    case "$1" in
        -o) outfile="$2"; shift 2 ;;
        -*) shift ;;
        *) url="$1"; shift ;;
    esac
done
case "$url" in
    *cloudflared-linux-amd64)
        echo "I am a corrupted binary" > "$outfile"
        chmod +x "$outfile"
        ;;
    *checksums.txt)
        echo "abandoned00000000000000000000000000000000000000000000000000000000  cloudflared-linux-amd64" > "$outfile"
        ;;
    *) exit 22 ;;
esac
SCRIPT
    chmod +x "$STUB_BIN/curl"
}

# Curl always returns a fixed status (for wait.sh tests).
stub_curl_status() {
    local s="$1"
    cat > "$STUB_BIN/curl" <<EOF
#!/usr/bin/env bash
printf '${s}'
EOF
    chmod +x "$STUB_BIN/curl"
}

# Curl returns statuses from a sequence (one per call, loops last).
stub_curl_sequence() {
    local statuses=("$@")
    local n="${#statuses[@]}"
    local arr="("
    for s in "${statuses[@]}"; do arr+="\"$s\" "; done
    arr+=")"
    cat > "$STUB_BIN/curl" <<EOF
#!/usr/bin/env bash
S=$arr; N=$n
COUNTER_FILE="\${COUNTER_FILE:-\$BATS_TEST_TMPDIR/curl_counter}"
i=\$(cat "\$COUNTER_FILE" 2>/dev/null || echo -1)
i=\$((i + 1))
[ "\$i" -ge "\$N" ] && i=\$((N - 1))
echo "\$i" > "\$COUNTER_FILE"
printf '%s' "\${S[\$i]}"
EOF
    chmod +x "$STUB_BIN/curl"
}

# Curl always fails with network error.
stub_curl_fail() {
    cat > "$STUB_BIN/curl" <<'SCRIPT'
#!/usr/bin/env bash
exit 7
SCRIPT
    chmod +x "$STUB_BIN/curl"
}

# Stub pkill — records invocations to a log file.
stub_pkill_recording() {
    cat > "$STUB_BIN/pkill" <<'SCRIPT'
#!/usr/bin/env bash
echo "pkill $*" >> "$BATS_TEST_TMPDIR/pkill.log"
exit 0
SCRIPT
    chmod +x "$STUB_BIN/pkill"
}

# Write a PID file at the canonical location for NAME.
fake_pidfile() {
    local name="$1" pid="$2" slug
    slug=$(printf '%s' "$name" | tr -c 'a-zA-Z0-9-' '-' | tr -s '-' | sed 's/^-//; s/-$//')
    [ -z "$slug" ] && slug="default"
    echo "$pid" > "$BATS_TEST_TMPDIR/cf-tunnel-${slug}.pid"
}

# Read a key from GITHUB_OUTPUT.
read_output() {
    local key="$1"
    grep "^${key}=" "$GITHUB_OUTPUT" 2>/dev/null | cut -d= -f2-
}
