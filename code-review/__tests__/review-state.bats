#!/usr/bin/env bash
# review-state.bats — tests for cross-push review memory (real coordinator output, no mocks).

load helpers

STATE_DIR="$FIXTURES_DIR/state"

# Extract the REAL findings array from the sample coordinator response fixture.
# The fixture is a raw OpenRouter response; .findings lives in a fenced JSON block
# inside .choices[0].message.content (the same content parse-response.sh consumes).
current_findings() {
    jq -r '.choices[0].message.content' "$FIXTURES_DIR/sample-coordinator-response.json" \
        | sed -e 's/^```json$//' -e 's/^```$//' \
        | jq -c '.findings'
}

@test "review-state: encode|decode roundtrip reproduces the state" {
    state=$(cat "$STATE_DIR/prior-state.json")
    marker=$(printf '%s' "$state" | bash "$SRC_DIR/review-state.sh" encode)
    # Marker is exactly one physical line.
    [ "$(printf '%s' "$marker" | grep -c '^')" -le 1 ]
    echo "$marker" | grep -q '^<!-- toolu-review-state:v1 .* -->$'

    decoded=$(printf '%s' "$marker" | bash "$SRC_DIR/review-state.sh" decode)
    # Compare jq-normalized (sorted keys) so formatting differences don't matter.
    [ "$(printf '%s' "$decoded" | jq -S .)" = "$(printf '%s' "$state" | jq -S .)" ]
}

@test "review-state: encode|decode roundtrip when marker is embedded in a larger comment body" {
    state=$(cat "$STATE_DIR/prior-state.json")
    marker=$(printf '%s' "$state" | bash "$SRC_DIR/review-state.sh" encode)
    body=$(printf '## Review\n\nSome findings here.\n\n%s\n' "$marker")
    decoded=$(printf '%s' "$body" | bash "$SRC_DIR/review-state.sh" decode)
    [ "$(printf '%s' "$decoded" | jq -S .)" = "$(printf '%s' "$state" | jq -S .)" ]
}

@test "review-state: fingerprint excludes line — same path+text at different lines yields same fp" {
    cur=$(current_findings)
    cur_fp=$(printf '%s' "$cur" | jq -c '.[0]' | bash "$SRC_DIR/review-state.sh" fingerprint)
    [ -n "$cur_fp" ]
    # Prior fixture's first two findings are the same path+text at lines 42 and 17.
    p0=$(jq -c '.findings[0]' "$STATE_DIR/prior-state.json" | bash "$SRC_DIR/review-state.sh" fingerprint)
    p1=$(jq -c '.findings[1]' "$STATE_DIR/prior-state.json" | bash "$SRC_DIR/review-state.sh" fingerprint)
    [ "$p0" = "$p1" ]
    # And both equal the current finding's fp (the static fixture fps are correct).
    [ "$p0" = "$cur_fp" ]
}

@test "review-state: diff full_review=true partitions new/open/resolved correctly" {
    cur=$(current_findings)
    prior=$(cat "$STATE_DIR/prior-state.json")
    input=$(jq -nc --argjson cur "$cur" --argjson prior "$prior" '{
        prior: $prior,
        current_findings: $cur,
        scope: { in_scope_paths: ["src/auth/login.ts", "src/utils/format.ts"], full_review: true },
        head_sha: "abcdef1234567890",
        verdict: "changes"
    }')
    run bash "$SRC_DIR/review-state.sh" diff <<< "$input"
    [ "$status" -eq 0 ]

    # The single current finding is OPEN (matched both the same-line and line-drift prior copies).
    echo "$output" | jq -e '.open | length == 1'
    echo "$output" | jq -e '.open[0].path == "src/auth/login.ts"'
    echo "$output" | jq -e '.new | length == 0'

    # RESOLVED = prior findings not in current, in-scope, full review.
    # src/utils/format.ts is in-scope -> resolved. src/legacy/old.ts is OUT of scope -> NOT resolved.
    echo "$output" | jq -e '.resolved | length == 1'
    echo "$output" | jq -e '.resolved[0].path == "src/utils/format.ts"'
    echo "$output" | jq -e '[.resolved[].path] | index("src/legacy/old.ts") == null'

    # Counts and total.
    echo "$output" | jq -e '.counts == {new:0, open:1, resolved:1, total:1}'

    # Each current finding carried into next_state has an fp + display fields.
    echo "$output" | jq -e '.next_state.findings | length == 1'
    echo "$output" | jq -e '.next_state.findings[0] | has("fp") and has("path") and has("line") and has("severity") and has("category") and has("text")'
    echo "$output" | jq -e '.next_state.schema == "toolu-review-state" and .next_state.version == 1'

    # history_entry uses 7-char sha and the verdict.
    echo "$output" | jq -e '.history_entry.sha == "abcdef1"'
    echo "$output" | jq -e '.history_entry.verdict == "changes"'
    echo "$output" | jq -e '.history_entry.counts == {new:0, open:1, resolved:1, total:1}'
}

@test "review-state: diff full_review=false never claims resolutions" {
    cur=$(current_findings)
    prior=$(cat "$STATE_DIR/prior-state.json")
    input=$(jq -nc --argjson cur "$cur" --argjson prior "$prior" '{
        prior: $prior,
        current_findings: $cur,
        scope: { in_scope_paths: ["src/auth/login.ts", "src/utils/format.ts"], full_review: false },
        head_sha: "abcdef1234567890",
        verdict: "changes"
    }')
    run bash "$SRC_DIR/review-state.sh" diff <<< "$input"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.resolved == []'
    # open/new still computed normally.
    echo "$output" | jq -e '.open | length == 1'
    echo "$output" | jq -e '.counts.resolved == 0'
}

@test "review-state: diff with null prior treats all current findings as new" {
    cur=$(current_findings)
    input=$(jq -nc --argjson cur "$cur" '{
        prior: null,
        current_findings: $cur,
        scope: { in_scope_paths: ["src/auth/login.ts"], full_review: true },
        head_sha: "0000000aaaa",
        verdict: "changes"
    }')
    run bash "$SRC_DIR/review-state.sh" diff <<< "$input"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.new | length == 1'
    echo "$output" | jq -e '.open == []'
    echo "$output" | jq -e '.resolved == []'
    echo "$output" | jq -e '.counts == {new:1, open:0, resolved:0, total:1}'
}

@test "review-state: history is capped to the last 10 entries" {
    cur=$(current_findings)
    prior=$(cat "$STATE_DIR/prior-state-12-history.json")
    input=$(jq -nc --argjson cur "$cur" --argjson prior "$prior" '{
        prior: $prior,
        current_findings: $cur,
        scope: { in_scope_paths: ["src/auth/login.ts"], full_review: true },
        head_sha: "ffffff1234567",
        verdict: "approved"
    }')
    run bash "$SRC_DIR/review-state.sh" diff <<< "$input"
    [ "$status" -eq 0 ]
    # 12 prior + 1 new = 13, capped to the most recent 10.
    echo "$output" | jq -e '.next_state.history | length == 10'
    # The new entry is the last one; the oldest three (sha1,sha2,sha3) are dropped.
    echo "$output" | jq -e '.next_state.history[-1].sha == "ffffff1"'
    echo "$output" | jq -e '[.next_state.history[].sha] | index("sha3") == null'
    echo "$output" | jq -e '[.next_state.history[].sha] | index("sha4") != null'
}

@test "review-state: decode on a corrupt marker returns {} and exits 0" {
    run bash "$SRC_DIR/review-state.sh" decode <<< '<!-- toolu-review-state:v1 not-valid-base64 -->'
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq -S .)" = '{}' ]
}

@test "review-state: decode on valid base64 charset that is not gzip returns {} exit 0" {
    # 'aGVsbG8=' decodes to 'hello' (not gzip) -> fresh start.
    run bash "$SRC_DIR/review-state.sh" decode <<< '<!-- toolu-review-state:v1 aGVsbG8= -->'
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq -S .)" = '{}' ]
}

@test "review-state: decode on a body with no marker returns {} and exits 0" {
    run bash "$SRC_DIR/review-state.sh" decode <<< 'just a normal review comment, nothing hidden here'
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq -S .)" = '{}' ]
}

@test "review-state: unknown subcommand errors to stderr and exits 2" {
    run bash "$SRC_DIR/review-state.sh" bogus
    [ "$status" -eq 2 ]
    [[ "$output" == *"unknown subcommand"* ]]
}

@test "review-state: missing subcommand exits 2" {
    run bash "$SRC_DIR/review-state.sh"
    [ "$status" -eq 2 ]
    [[ "$output" == *"missing subcommand"* ]]
}
