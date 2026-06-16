#!/usr/bin/env bash
# build-prompt.bats — tests for build-prompt.sh (provider-agnostic envelope).

load helpers

@test "build-prompt: produces provider-agnostic envelope with system + user + max_tokens + enforce_json_schema" {
    diff_data=$(cat "$FIXTURES_DIR/sample-diff.txt" | jq -Rsc '{diff: ., changed_files: ["src/auth/login.ts","src/utils/format.ts"], binary_files: [], total_lines: 30, total_files: 4, truncated: false}')

    run bash "$SRC_DIR/build-prompt.sh" <<< "$diff_data"
    [ "$status" -eq 0 ]

    # Envelope shape — no OpenRouter/OpenAI-specific fields here.
    echo "$output" | jq -e '.system | type == "string" and length > 0'
    echo "$output" | jq -e '.user | type == "string" and length > 0'
    echo "$output" | jq -e '.max_tokens == 4096'
    echo "$output" | jq -e '.enforce_json_schema == true'

    # No legacy OpenRouter-specific fields.
    echo "$output" | jq -e '.model == null'
    echo "$output" | jq -e '.messages == null'
    echo "$output" | jq -e '.response_format == null'
    echo "$output" | jq -e '.temperature == null'
    echo "$output" | jq -e '.models == null'
    echo "$output" | jq -e '.provider == null'
}

@test "build-prompt: ENFORCE_JSON_SCHEMA=false propagates" {
    diff_data=$(cat "$FIXTURES_DIR/sample-diff.txt" | jq -Rsc '{diff: ., changed_files: ["a.ts"], binary_files: [], dropped_files: [], total_lines: 1, total_files: 1, truncated: false}')

    INPUT_ENFORCE_JSON_SCHEMA="false" run bash "$SRC_DIR/build-prompt.sh" <<< "$diff_data"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.enforce_json_schema == false'
}

@test "build-prompt: system prompt includes review dimensions from checklist" {
    diff_data=$(cat "$FIXTURES_DIR/sample-diff.txt" | jq -Rsc '{diff: ., changed_files: ["src/auth/login.ts"], binary_files: [], total_lines: 10, total_files: 1, truncated: false}')

    run bash "$SRC_DIR/build-prompt.sh" <<< "$diff_data"
    [ "$status" -eq 0 ]

    sys=$(echo "$output" | jq -r '.system')
    [[ "$sys" == *"CORRECTNESS"* ]]
    [[ "$sys" == *"SECURITY"* ]]
    [[ "$sys" == *"PERFORMANCE"* ]]
}

@test "build-prompt: uses custom review prompt from file when review-prompt-file is set" {
    WS=$(mktemp -d)
    echo "Only check for SQL injection patterns." > "$WS/custom-prompt.md"

    INPUT_REVIEW_PROMPT_FILE="custom-prompt.md" \
        GITHUB_WORKSPACE="$WS" \
        diff_data=$(cat "$FIXTURES_DIR/sample-diff.txt" | jq -Rsc '{diff: ., changed_files: ["src/auth/login.ts"], binary_files: [], total_lines: 10, total_files: 1, truncated: false}') \
        run bash "$SRC_DIR/build-prompt.sh" <<< "$diff_data"

    [ "$status" -eq 0 ]
    sys=$(echo "$output" | jq -r '.system')
    [[ "$sys" == *"SQL injection"* ]]
    [[ "$sys" != *"CORRECTNESS"* ]]

    rm -rf "$WS"
}

@test "build-prompt: fails when review-prompt-file points to nonexistent file" {
    INPUT_REVIEW_PROMPT_FILE="nonexistent/path.md" \
        GITHUB_WORKSPACE="/nonexistent" \
        diff_data=$(echo "test" | jq -Rsc '{diff: ., changed_files: ["a.ts"], binary_files: [], total_lines: 1, total_files: 1, truncated: false}') \
        run bash "$SRC_DIR/build-prompt.sh" <<< "$diff_data"

    [ "$status" -ne 0 ]
}

@test "build-prompt: truncation notice appears when truncated=true" {
    diff_data=$(cat "$FIXTURES_DIR/sample-diff-truncated.txt" | jq -Rsc '{diff: ., changed_files: ["src/auth/login.ts"], binary_files: [], total_lines: 5, total_files: 1, truncated: true}')

    run bash "$SRC_DIR/build-prompt.sh" <<< "$diff_data"
    [ "$status" -eq 0 ]

    user=$(echo "$output" | jq -r '.user')
    [[ "$user" == *"truncated"* ]]
}

@test "build-prompt: codebase overview injected into user prompt" {
    INPUT_CODEBASE_OVERVIEW="React + Express monorepo with TypeScript" \
        diff_data=$(echo "test diff" | jq -Rsc '{diff: ., changed_files: ["a.ts"], binary_files: [], total_lines: 1, total_files: 1, truncated: false}') \
        run bash "$SRC_DIR/build-prompt.sh" <<< "$diff_data"

    [ "$status" -eq 0 ]
    user=$(echo "$output" | jq -r '.user')
    [[ "$user" == *"React + Express"* ]]
}

@test "build-prompt: binary files listed in user prompt" {
    diff_data=$(echo "" | jq -Rsc '{diff: ., changed_files: ["a.ts"], binary_files: ["icon.png","app.wasm"], total_lines: 0, total_files: 3, truncated: false}')

    run bash "$SRC_DIR/build-prompt.sh" <<< "$diff_data"
    [ "$status" -eq 0 ]

    user=$(echo "$output" | jq -r '.user')
    [[ "$user" == *"Binary Files"* ]]
    [[ "$user" == *"icon.png"* ]]
    [[ "$user" == *"app.wasm"* ]]
}
