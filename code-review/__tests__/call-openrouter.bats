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
