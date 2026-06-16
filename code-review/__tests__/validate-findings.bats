#!/usr/bin/env bash
# validate-findings.bats — tests for validate-findings.sh (deterministic gate).
# The script prints a diagnostic to stderr on success, so capture stdout directly
# (bats `run` would merge the streams).

load helpers

# A diff touching src/a.ts lines 10,11,12 and src/b.ts line 5.
FILES='[{"path":"src/a.ts","changed_lines":[10,11,12]},{"path":"src/b.ts","changed_lines":[5]}]'

@test "validate-findings: drops a finding whose line is not in the diff (hallucinated)" {
    input=$(jq -nc --argjson files "$FILES" '{
        files: $files,
        findings: [
            {path:"src/a.ts", line:999, severity:"high", confidence:"high", text:"not in diff"},
            {path:"src/a.ts", line:11,  severity:"high", confidence:"high", text:"real"}
        ]
    }')
    out=$(bash "$SRC_DIR/validate-findings.sh" <<< "$input" 2>/dev/null)
    [ "$(echo "$out" | jq '.findings | length')" -eq 1 ]
    [ "$(echo "$out" | jq -r '.findings[0].text')" = "real" ]
}

@test "validate-findings: drops medium-confidence low-severity under MIN_CONFIDENCE=high" {
    input=$(jq -nc --argjson files "$FILES" '{
        files: $files,
        findings: [
            {path:"src/a.ts", line:10, severity:"low",     confidence:"medium", text:"weak"},
            {path:"src/a.ts", line:12, severity:"blocker", confidence:"medium", text:"strong"}
        ]
    }')
    out=$(INPUT_MIN_CONFIDENCE=high bash "$SRC_DIR/validate-findings.sh" <<< "$input" 2>/dev/null)
    # The blocker survives (severity overrides), the low/medium is dropped.
    [ "$(echo "$out" | jq '.findings | length')" -eq 1 ]
    [ "$(echo "$out" | jq -r '.findings[0].text')" = "strong" ]
}

@test "validate-findings: MIN_CONFIDENCE=medium keeps medium but drops low/unknown" {
    input=$(jq -nc --argjson files "$FILES" '{
        files: $files,
        findings: [
            {path:"src/a.ts", line:10, severity:"low", confidence:"medium", text:"keep medium"},
            {path:"src/a.ts", line:11, severity:"low", confidence:"low",    text:"drop low"},
            {path:"src/a.ts", line:12, severity:"low",                       text:"drop unknown"}
        ]
    }')
    out=$(INPUT_MIN_CONFIDENCE=medium bash "$SRC_DIR/validate-findings.sh" <<< "$input" 2>/dev/null)
    [ "$(echo "$out" | jq '.findings | length')" -eq 1 ]
    [ "$(echo "$out" | jq -r '.findings[0].text')" = "keep medium" ]
}

@test "validate-findings: keeps suggestion only when high-confidence and span anchored" {
    input=$(jq -nc --argjson files "$FILES" '{
        files: $files,
        findings: [
            {path:"src/a.ts", line:10, end_line:11, severity:"high", confidence:"high",   suggestion:"fixed()", text:"keep sugg"},
            {path:"src/b.ts", line:5,                severity:"high", confidence:"medium", suggestion:"nope()",   text:"strip sugg"}
        ]
    }')
    out=$(bash "$SRC_DIR/validate-findings.sh" <<< "$input" 2>/dev/null)
    [ "$(echo "$out" | jq -r '[.findings[] | select(.text=="keep sugg")][0].suggestion')" = "fixed()" ]
    [ "$(echo "$out" | jq '[.findings[] | select(.text=="strip sugg")][0] | has("suggestion")')" = "false" ]
}

@test "validate-findings: strips suggestion whose span runs outside the diff" {
    input=$(jq -nc --argjson files "$FILES" '{
        files: $files,
        findings: [
            {path:"src/a.ts", line:11, end_line:20, severity:"high", confidence:"high", suggestion:"spans too far", text:"span"}
        ]
    }')
    out=$(bash "$SRC_DIR/validate-findings.sh" <<< "$input" 2>/dev/null)
    [ "$(echo "$out" | jq '.findings | length')" -eq 1 ]
    [ "$(echo "$out" | jq '.findings[0] | has("suggestion")')" = "false" ]
}
