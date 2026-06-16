#!/usr/bin/env bash
# coordinate-findings.bats — tests for coordinate-findings.sh (coordinator pass).
# Mocks curl to replay the recorded coordinator response.

load helpers

setup_mock_curl() {
    MOCK_DIR=$(mktemp -d)
    export FIXTURES_DIR="$FIXTURES_DIR"
    cat > "$MOCK_DIR/curl" << 'ENDSCRIPT'
#!/usr/bin/env bash
outfile=""; args=("$@")
for i in "${!args[@]}"; do [ "${args[$i]}" = "-o" ] && outfile="${args[$((i+1))]}"; done
[ -n "$outfile" ] && cat "${FIXTURES_DIR}/sample-coordinator-response.json" > "$outfile"
printf "200"
ENDSCRIPT
    chmod +x "$MOCK_DIR/curl"
    export PATH="$MOCK_DIR:$PATH"
}
teardown_mock_curl() { rm -rf "${MOCK_DIR:-/tmp/nonexistent}"; }

@test "coordinate-findings: deduplicates the union into a final verdict" {
    setup_mock_curl
    export OPENROUTER_API_KEY="sk-or-test-key"

    # Two duplicate findings on the same line from different dimensions.
    union='{"findings":[
        {"path":"src/auth/login.ts","line":42,"severity":"high","category":"security","confidence":"high","text":"SQL injection"},
        {"path":"src/auth/login.ts","line":42,"severity":"high","category":"correctness","confidence":"high","text":"Unparameterized query"}
    ]}'
    run bash "$SRC_DIR/coordinate-findings.sh" <<< "$union"
    [ "$status" -eq 0 ]
    # Coordinator merged the duplicates into one finding.
    echo "$output" | jq -e '.findings | length == 1'
    echo "$output" | jq -e '.verdict == "changes"'
    echo "$output" | jq -e '.review_plan | length > 0'
    echo "$output" | jq -e '.top_must_fix | length >= 1'

    teardown_mock_curl
}

@test "coordinate-findings: empty union short-circuits to approved (no API call)" {
    # No OPENROUTER_API_KEY on purpose — must not call the API.
    unset OPENROUTER_API_KEY || true
    run bash "$SRC_DIR/coordinate-findings.sh" <<< '{"findings":[]}'
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.verdict == "approved"'
    echo "$output" | jq -e '.findings | length == 0'
}
