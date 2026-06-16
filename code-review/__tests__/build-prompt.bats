#!/usr/bin/env bash
# build-prompt.bats — tests for build-prompt.sh

load helpers

@test "build-prompt: produces valid OpenRouter request JSON" {
    diff_data=$(cat "$FIXTURES_DIR/sample-diff.txt" | jq -Rsc '{diff: ., changed_files: ["src/auth/login.ts","src/utils/format.ts"], binary_files: [], total_lines: 30, total_files: 4, truncated: false}')

    run bash "$SRC_DIR/build-prompt.sh" <<< "$diff_data"
    [ "$status" -eq 0 ]

    # Validate JSON structure.
    echo "$output" | jq -e '.model == "minimax/minimax-m3"'
    echo "$output" | jq -e '.messages | length == 2'
    echo "$output" | jq -e '.messages[0].role == "system"'
    echo "$output" | jq -e '.messages[1].role == "user"'
    echo "$output" | jq -e '.temperature == 0.1'
    echo "$output" | jq -e '.response_format.type == "json_schema"'
    echo "$output" | jq -e '.response_format.json_schema.schema.required | contains(["review_plan"])'
}

@test "build-prompt: dimension mode builds a scoped prompt with models[], max_tokens, provider routing" {
    diff_data=$(cat "$FIXTURES_DIR/sample-diff.txt" | jq -Rsc '{diff: ., changed_files: ["src/auth/login.ts"], binary_files: [], dropped_files: [], total_lines: 10, total_files: 1, truncated: false}')

    INPUT_DIMENSION="security" run bash "$SRC_DIR/build-prompt.sh" <<< "$diff_data"
    [ "$status" -eq 0 ]

    sys=$(echo "$output" | jq -r '.messages[0].content')
    [[ "$sys" == *"Your dimension: security"* ]]
    [[ "$sys" == *"SECURITY"* ]]

    echo "$output" | jq -e '.max_tokens == 4096'
    echo "$output" | jq -e '.models | length == 2'
    echo "$output" | jq -e '.models[0] == "minimax/minimax-m3"'
    echo "$output" | jq -e '.models[1] == "anthropic/claude-sonnet-4-5"'
    echo "$output" | jq -e '.provider.require_parameters == true'
    # Sub-reviewer schema: reasoning first, findings carry confidence/suggestion.
    echo "$output" | jq -e '.response_format.json_schema.schema.required | contains(["reasoning"])'
    echo "$output" | jq -e '.response_format.json_schema.schema.properties.findings.items.properties | has("confidence") and has("suggestion") and has("end_line")'
}

@test "build-prompt: ENFORCE_JSON_SCHEMA=false omits response_format and provider" {
    diff_data=$(cat "$FIXTURES_DIR/sample-diff.txt" | jq -Rsc '{diff: ., changed_files: ["a.ts"], binary_files: [], dropped_files: [], total_lines: 1, total_files: 1, truncated: false}')

    INPUT_ENFORCE_JSON_SCHEMA="false" run bash "$SRC_DIR/build-prompt.sh" <<< "$diff_data"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.response_format == null'
    echo "$output" | jq -e '.provider == null'
    echo "$output" | jq -e '.max_tokens == 4096'
    echo "$output" | jq -e '.models | length == 2'
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

@test "build-prompt: uses custom review prompt from file when review-prompt-file is set" {
    # Write a custom prompt to a temp dir that simulates the workspace.
    WS=$(mktemp -d)
    echo "Only check for SQL injection patterns." > "$WS/custom-prompt.md"

    INPUT_REVIEW_PROMPT_FILE="custom-prompt.md" \
        GITHUB_WORKSPACE="$WS" \
        diff_data=$(cat "$FIXTURES_DIR/sample-diff.txt" | jq -Rsc '{diff: ., changed_files: ["src/auth/login.ts"], binary_files: [], total_lines: 10, total_files: 1, truncated: false}') \
        run bash "$SRC_DIR/build-prompt.sh" <<< "$diff_data"

    [ "$status" -eq 0 ]
    sys=$(echo "$output" | jq -r '.messages[0].content')
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
