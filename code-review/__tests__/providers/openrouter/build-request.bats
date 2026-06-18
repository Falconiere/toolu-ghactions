#!/usr/bin/env bash
# build-request.bats — tests for providers/openrouter/build-request.sh

load ../../helpers

# helpers.bash resolves SRC_DIR for tests directly under __tests__/; these
# provider tests sit two levels deeper, so derive the script path from this
# file's own location instead.
setup() {
    BR="$(cd "$(dirname "$BATS_TEST_FILENAME")/../../.." && pwd)/src/providers/openrouter/build-request.sh"
    export INPUT_MODEL="deepseek/deepseek-v4-flash"
}

# Minimal envelope as produced by build-prompt.sh.
envelope() {
    jq -nc --argjson enforce "${1:-true}" \
        '{system: "sys prompt", user: "review this diff", max_tokens: 4096, enforce_json_schema: $enforce}'
}

@test "openrouter build-request: disables reasoning so max_tokens is not burned on the think phase" {
    run bash -c "echo '$(envelope true)' | bash '$BR'"
    [ "$status" -eq 0 ]
    # The reasoning-burn fix: reasoning.effort must be "none".
    echo "$output" | jq -e '.reasoning.effort == "none"'
}

@test "openrouter build-request: reasoning is disabled regardless of schema enforcement" {
    run bash -c "echo '$(envelope false)' | bash '$BR'"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.reasoning.effort == "none"'
    # No json_schema when enforcement is off.
    echo "$output" | jq -e '.response_format == null'
}

@test "openrouter build-request: carries model, max_tokens, messages, and temperature" {
    run bash -c "echo '$(envelope true)' | bash '$BR'"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.model == "deepseek/deepseek-v4-flash"'
    echo "$output" | jq -e '.max_tokens == 4096'
    echo "$output" | jq -e '.temperature == 0.1'
    echo "$output" | jq -e '(.messages | length) == 2'
    echo "$output" | jq -e '.messages[0].role == "system" and .messages[1].role == "user"'
}

@test "openrouter build-request: enforce_json_schema=true adds json_schema + require_parameters" {
    run bash -c "echo '$(envelope true)' | bash '$BR'"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.response_format.type == "json_schema"'
    echo "$output" | jq -e '.response_format.json_schema.name == "code_review_verdict"'
    echo "$output" | jq -e '.provider.require_parameters == true'
}

@test "openrouter build-request: output is a single valid JSON object" {
    run bash -c "echo '$(envelope true)' | bash '$BR'"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e 'type == "object"'
}
