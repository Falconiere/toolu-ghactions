#!/usr/bin/env bash
# call-openrouter.bats — tests for call-openrouter.sh
# Mocks curl by intercepting the PATH.

load helpers

setup_mock_curl() {
    MOCK_DIR=$(mktemp -d)
    cat > "$MOCK_DIR/curl" << 'ENDSCRIPT'
#!/usr/bin/env bash
# Mock curl: find -o output file, write fixture there, print 200 to stdout.
outfile=""
args=("$@")
for i in "${!args[@]}"; do
    if [ "${args[$i]}" = "-o" ]; then
        outfile="${args[$((i+1))]}"
    fi
done
if [ -n "$outfile" ]; then
    # The FIXTURES_DIR is baked into this script via env.
    cat "${FIXTURES_DIR}/sample-openrouter-response-approved.json" > "$outfile"
fi
printf "200"
ENDSCRIPT
    # Export FIXTURES_DIR so the mock can find it.
    export FIXTURES_DIR="$FIXTURES_DIR"
    chmod +x "$MOCK_DIR/curl"
    export PATH="$MOCK_DIR:$PATH"
}

teardown_mock_curl() {
    rm -rf "${MOCK_DIR:-/tmp/nonexistent}"
}

@test "call-openrouter: returns API response on success" {
    setup_mock_curl
    export OPENROUTER_API_KEY="sk-or-test-key"

    request='{"model":"test","messages":[]}'
    run bash "$SRC_DIR/call-openrouter.sh" <<< "$request"

    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.choices[0].message.content' > /dev/null

    teardown_mock_curl
}

# Sequence-driven mock: $1 = space-separated HTTP codes, one per successive call.
# Body is chosen by code (2xx→approved fixture or MOCK_200_BODY, 429→429 fixture,
# 5xx→leak fixture or MOCK_5XX_BODY). Counts calls in MOCK_DIR/n.
setup_seq_curl() {
    MOCK_DIR=$(mktemp -d)
    echo "0" > "$MOCK_DIR/n"
    export MOCK_SEQ="$1"
    export FIXTURES_DIR="$FIXTURES_DIR"
    cat > "$MOCK_DIR/curl" << 'ENDSCRIPT'
#!/usr/bin/env bash
ndir="$(dirname "$0")"
n=$(cat "$ndir/n"); n=$((n + 1)); echo "$n" > "$ndir/n"
read -ra codes <<< "$MOCK_SEQ"
idx=$((n - 1)); [ "$idx" -ge "${#codes[@]}" ] && idx=$(( ${#codes[@]} - 1 ))
code="${codes[$idx]}"
outfile=""; args=("$@")
for i in "${!args[@]}"; do [ "${args[$i]}" = "-o" ] && outfile="${args[$((i+1))]}"; done
case "$code" in
    2*)  body=$(cat "${MOCK_200_BODY:-$FIXTURES_DIR/sample-openrouter-response-approved.json}") ;;
    429) body=$(cat "$FIXTURES_DIR/sample-openrouter-429.json") ;;
    5*)  body=$(cat "${MOCK_5XX_BODY:-$FIXTURES_DIR/sample-openrouter-500-leak.txt}") ;;
    *)   body='{"error":{"message":"client error"}}' ;;
esac
[ -n "$outfile" ] && printf '%s' "$body" > "$outfile"
printf '%s' "$code"
ENDSCRIPT
    chmod +x "$MOCK_DIR/curl"
    export PATH="$MOCK_DIR:$PATH"
}

@test "call-openrouter: retries on 429 then succeeds on 200" {
    setup_seq_curl "429 200"
    export OPENROUTER_API_KEY="sk-or-test-key" BACKOFF_BASE=0

    run bash "$SRC_DIR/call-openrouter.sh" <<< '{"model":"m","messages":[]}'
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.choices[0].message.content' > /dev/null
    [ "$(cat "$MOCK_DIR/n")" -eq 2 ]   # one retry

    rm -rf "$MOCK_DIR"
}

@test "call-openrouter: gives up after 3 attempts on repeated 500" {
    setup_seq_curl "500 500 500"
    export OPENROUTER_API_KEY="sk-or-test-key" BACKOFF_BASE=0

    run bash "$SRC_DIR/call-openrouter.sh" <<< '{"model":"m","messages":[]}'
    [ "$status" -ne 0 ]
    [ "$(cat "$MOCK_DIR/n")" -eq 3 ]

    rm -rf "$MOCK_DIR"
}

@test "call-openrouter: does not retry on 401 (single attempt)" {
    setup_seq_curl "401"
    export OPENROUTER_API_KEY="sk-or-test-key" BACKOFF_BASE=0

    run bash "$SRC_DIR/call-openrouter.sh" <<< '{"model":"m","messages":[]}'
    [ "$status" -ne 0 ]
    [ "$(cat "$MOCK_DIR/n")" -eq 1 ]

    rm -rf "$MOCK_DIR"
}

@test "call-openrouter: redacts a leaked token from error output" {
    setup_seq_curl "500 500 500"
    export OPENROUTER_API_KEY="sk-or-test-key" BACKOFF_BASE=0

    run bash "$SRC_DIR/call-openrouter.sh" <<< '{"model":"m","messages":[]}'
    [ "$status" -ne 0 ]
    # The fake token from the 500 body must not survive into logs.
    [[ "$output" != *"sk-test-LEAK"* ]]

    rm -rf "$MOCK_DIR"
}

@test "call-openrouter: treats an embedded error in a 200 response as a failure" {
    setup_seq_curl "200"
    export OPENROUTER_API_KEY="sk-or-test-key" BACKOFF_BASE=0
    export MOCK_200_BODY="$FIXTURES_DIR/sample-openrouter-200-embedded-error.json"

    run bash "$SRC_DIR/call-openrouter.sh" <<< '{"model":"m","messages":[]}'
    [ "$status" -ne 0 ]
    [[ "$output" == *"embedded error"* ]]

    rm -rf "$MOCK_DIR"
}

@test "call-openrouter: fails when OPENROUTER_API_KEY is unset" {
    unset OPENROUTER_API_KEY
    run bash "$SRC_DIR/call-openrouter.sh" <<< '{}'
    [ "$status" -ne 0 ]
}

@test "call-openrouter: fails on empty request body" {
    export OPENROUTER_API_KEY="sk-or-test-key"
    run bash "$SRC_DIR/call-openrouter.sh" <<< ''
    [ "$status" -ne 0 ]
}
