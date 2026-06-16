#!/usr/bin/env bash
# run-dimension.bats — tests for run-dimension.sh (one sub-reviewer end to end).
# Mocks curl to replay a recorded dimension response.

load helpers

setup_mock_curl() {
    MOCK_DIR=$(mktemp -d)
    export FIXTURES_DIR="$FIXTURES_DIR"
    cat > "$MOCK_DIR/curl" << 'ENDSCRIPT'
#!/usr/bin/env bash
outfile=""; args=("$@")
for i in "${!args[@]}"; do [ "${args[$i]}" = "-o" ] && outfile="${args[$((i+1))]}"; done
[ -n "$outfile" ] && cat "${FIXTURES_DIR}/sample-openrouter-response-correctness.json" > "$outfile"
printf "200"
ENDSCRIPT
    chmod +x "$MOCK_DIR/curl"
    export PATH="$MOCK_DIR:$PATH"
}
teardown_mock_curl() { rm -rf "${MOCK_DIR:-/tmp/nonexistent}"; }

@test "run-dimension: runs build->call->parse and tags findings with the dimension" {
    setup_mock_curl
    export OPENROUTER_API_KEY="sk-or-test-key"

    diff_data=$(cat "$FIXTURES_DIR/sample-diff.txt" | jq -Rsc '{diff:., changed_files:["src/auth/login.ts"], binary_files:[], dropped_files:[], total_lines:10, total_files:1, truncated:false}')

    run bash -c "echo '$diff_data' | INPUT_DIMENSION=correctness bash '$SRC_DIR/run-dimension.sh'"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.dimension == "correctness"'
    echo "$output" | jq -e '.findings | length >= 1'
    echo "$output" | jq -e '.findings[0].category != null'

    teardown_mock_curl
}

@test "run-dimension: fails when INPUT_DIMENSION is unset" {
    export OPENROUTER_API_KEY="sk-or-test-key"
    run bash "$SRC_DIR/run-dimension.sh" <<< '{"diff":"x","changed_files":[],"binary_files":[]}'
    [ "$status" -ne 0 ]
}
