#!/usr/bin/env bash
# build-prompt.bats — tests for build-prompt.sh

load helpers

@test "build-prompt: produces valid OpenRouter request JSON" {
    diff_data=$(cat "$FIXTURES_DIR/sample-diff.txt" | jq -Rsc '{diff: ., changed_files: ["src/auth/login.ts","src/utils/format.ts"], binary_files: [], total_lines: 30, total_files: 4, truncated: false}')

    run bash "$SRC_DIR/build-prompt.sh" <<< "$diff_data"
    [ "$status" -eq 0 ]

    # Validate JSON structure.
    echo "$output" | jq -e '.model == "anthropic/claude-sonnet-4"'
    echo "$output" | jq -e '.messages | length == 2'
    echo "$output" | jq -e '.messages[0].role == "system"'
    echo "$output" | jq -e '.messages[1].role == "user"'
    echo "$output" | jq -e '.temperature == 0.1'
    echo "$output" | jq -e '.response_format.type == "json_schema"'
    echo "$output" | jq -e '.response_format.json_schema.schema.required | contains(["review_plan"])'
}

@test "build-prompt: system prompt includes review dimensions from checklist" {
    diff_data=$(cat "$FIXTURES_DIR/sample-diff.txt" | jq -Rsc '{diff: ., changed_files: ["src/auth/login.ts"], binary_files: [], total_lines: 10, total_files: 1, truncated: false}')

    run bash "$SRC_DIR/build-prompt.sh" <<< "$diff_data"
    [ "$status" -eq 0 ]

    # System content must reference key dimensions.
    sys=$(echo "$output" | jq -r '.messages[0].content')
    [[ "$sys" == *"CORRECTNESS"* ]]
    [[ "$sys" == *"SECURITY"* ]]
    [[ "$sys" == *"PERFORMANCE"* ]]
}

@test "build-prompt: uses custom review-prompt when provided" {
    INPUT_REVIEW_PROMPT="Only check for SQL injection patterns." \
        diff_data=$(cat "$FIXTURES_DIR/sample-diff.txt" | jq -Rsc '{diff: ., changed_files: ["src/auth/login.ts"], binary_files: [], total_lines: 10, total_files: 1, truncated: false}') \
        run bash "$SRC_DIR/build-prompt.sh" <<< "$diff_data"

    [ "$status" -eq 0 ]
    sys=$(echo "$output" | jq -r '.messages[0].content')
    [[ "$sys" == *"SQL injection"* ]]
    [[ "$sys" != *"CORRECTNESS"* ]]
}

@test "build-prompt: truncation notice appears when truncated=true" {
    diff_data=$(cat "$FIXTURES_DIR/sample-diff-truncated.txt" | jq -Rsc '{diff: ., changed_files: ["src/auth/login.ts"], binary_files: [], total_lines: 5, total_files: 1, truncated: true}')

    run bash "$SRC_DIR/build-prompt.sh" <<< "$diff_data"
    [ "$status" -eq 0 ]

    user=$(echo "$output" | jq -r '.messages[1].content')
    [[ "$user" == *"truncated"* ]]
}

@test "build-prompt: codebase overview injected into user prompt" {
    INPUT_CODEBASE_OVERVIEW="React + Express monorepo with TypeScript" \
        diff_data=$(echo "test diff" | jq -Rsc '{diff: ., changed_files: ["a.ts"], binary_files: [], total_lines: 1, total_files: 1, truncated: false}') \
        run bash "$SRC_DIR/build-prompt.sh" <<< "$diff_data"

    [ "$status" -eq 0 ]
    user=$(echo "$output" | jq -r '.messages[1].content')
    [[ "$user" == *"React + Express"* ]]
}

@test "build-prompt: binary files listed in user prompt" {
    diff_data=$(echo "" | jq -Rsc '{diff: ., changed_files: ["a.ts"], binary_files: ["icon.png","app.wasm"], total_lines: 0, total_files: 3, truncated: false}')

    run bash "$SRC_DIR/build-prompt.sh" <<< "$diff_data"
    [ "$status" -eq 0 ]

    user=$(echo "$output" | jq -r '.messages[1].content')
    [[ "$user" == *"Binary Files"* ]]
    [[ "$user" == *"icon.png"* ]]
    [[ "$user" == *"app.wasm"* ]]
}
