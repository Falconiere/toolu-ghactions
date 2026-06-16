#!/usr/bin/env bash
# parse-response.bats — tests for parse-response.sh

load helpers

@test "parse-response: extracts verdict and findings from valid approved response" {
    run bash "$SRC_DIR/parse-response.sh" < "$FIXTURES_DIR/sample-openrouter-response-approved.json"
    [ "$status" -eq 0 ]

    # Should output valid JSON.
    echo "$output" | jq -e '.verdict == "approved"'
    echo "$output" | jq -e '.findings | length == 2'
    echo "$output" | jq -e '.findings[0].path == "src/utils/format.ts"'
    echo "$output" | jq -e '.findings[0].severity == "low"'
    echo "$output" | jq -e '.findings[1].path == "src/utils/__tests__/format.test.ts"'
}

@test "parse-response: extracts verdict and findings from valid changes response" {
    run bash "$SRC_DIR/parse-response.sh" < "$FIXTURES_DIR/sample-openrouter-response-changes.json"
    [ "$status" -eq 0 ]

    echo "$output" | jq -e '.verdict == "changes"'
    echo "$output" | jq -e '.findings | length == 4'
    echo "$output" | jq -e '.findings[0].severity == "blocker"'
}

@test "parse-response: carries reasoning + confidence + suggestion from a dimension response" {
    run bash "$SRC_DIR/parse-response.sh" < "$FIXTURES_DIR/sample-openrouter-response-correctness.json"
    [ "$status" -eq 0 ]

    echo "$output" | jq -e '.reasoning | length > 0'
    echo "$output" | jq -e '.findings | length >= 1'
    echo "$output" | jq -e '.findings[0] | has("confidence") and has("suggestion") and has("end_line") and has("category")'
    echo "$output" | jq -e '.findings[0].confidence == "high"'
}

@test "parse-response: strips a json code fence (coordinator response)" {
    run bash "$SRC_DIR/parse-response.sh" < "$FIXTURES_DIR/sample-coordinator-response.json"
    [ "$status" -eq 0 ]

    echo "$output" | jq -e '.review_plan | length > 0'
    echo "$output" | jq -e '.verdict == "changes"'
    echo "$output" | jq -e '.findings | length >= 1'
}

@test "parse-response: free-text response falls back without crashing" {
    run bash "$SRC_DIR/parse-response.sh" < "$FIXTURES_DIR/sample-openrouter-response-freetext.txt"
    [ "$status" -eq 0 ] || [ "$status" -eq 1 ]
    if [ "$status" -eq 0 ]; then
        echo "$output" | jq -e '.findings | type == "array"'
    fi
}

@test "parse-response: handles malformed response with regex fallback" {
    run bash "$SRC_DIR/parse-response.sh" < "$FIXTURES_DIR/sample-openrouter-response-malformed.txt"
    # May succeed with fallback or fail — either is acceptable; just check it doesn't crash.
    [ "$status" -eq 0 ] || [ "$status" -eq 1 ]
}

@test "parse-response: returns structured error on empty input (does not crash)" {
    PROVIDER=openrouter run bash "$SRC_DIR/parse-response.sh" <<< ''
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.verdict == null'
    echo "$output" | jq -e '.error | length > 0'
    echo "$output" | jq -e '.findings == []'
}

@test "parse-response: returns findings=[] on non-JSON input with no extractable findings" {
    PROVIDER=openrouter run bash "$SRC_DIR/parse-response.sh" <<< 'this is just random text with nothing parseable'
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.findings | type == "array"'
}
