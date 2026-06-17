#!/usr/bin/env bash
# format-verdict.bats — tests for format-verdict.sh

load helpers

@test "format-verdict: renders approved comment with findings" {
    # Parse the approved response first.
    parsed=$(bash "$SRC_DIR/parse-response.sh" < "$FIXTURES_DIR/sample-openrouter-response-approved.json")

    run bash "$SRC_DIR/format-verdict.sh" <<< "$parsed"
    [ "$status" -eq 0 ]

    # Check required markers.
    [[ "$output" == *"### Code Review"* ]]
    [[ "$output" == *'`feat/add-login`'* ]]
    [[ "$output" == *"### Review Plan"* ]]
    [[ "$output" == *"Reviewing 4 files"* ]]
    [[ "$output" == *"agent-merge-approved"* ]]
    [[ "$output" == *"### Findings"* ]]
    [[ "$output" == *"### Other checks"* ]]
    [[ "$output" == *"### Top-N must-fix"* ]]
    [[ "$output" == *"View job"* ]]
    [[ "$output" == *"actions/runs/1234567890"* ]]

    # Checkbox checklist should be fully checked.
    [[ "$output" == *"- [x] Read repository context and PR diff"* ]]
    [[ "$output" == *"- [x] Post findings"* ]]
    [[ "$output" == *"- [x] Set verdict label"* ]]

    # Findings should appear.
    [[ "$output" == *'src/utils/format.ts:17'* ]]
    [[ "$output" == *'Temporary workaround'* ]]
}

@test "format-verdict: renders changes-requested comment with blocker" {
    parsed=$(bash "$SRC_DIR/parse-response.sh" < "$FIXTURES_DIR/sample-openrouter-response-changes.json")

    run bash "$SRC_DIR/format-verdict.sh" <<< "$parsed"
    [ "$status" -eq 0 ]

    [[ "$output" == *"Changes requested"* ]]
    [[ "$output" == *"agent-request-changes"* ]]
    [[ "$output" == *"🔴"*"blocker"* ]]  # Blocker badge.
    [[ "$output" == *"src/auth/login.ts:42"* ]]
    [[ "$output" == *"SQL injection"* ]]
}

@test "format-verdict: includes View job link with run ID" {
    parsed=$(bash "$SRC_DIR/parse-response.sh" < "$FIXTURES_DIR/sample-openrouter-response-approved.json")

    run bash "$SRC_DIR/format-verdict.sh" <<< "$parsed"
    [ "$status" -eq 0 ]

    [[ "$output" == *"https://github.com/test-org/test-repo/actions/runs/1234567890"* ]]
}

@test "format-verdict: parse-verdict.sh compatibility — markers present" {
    parsed=$(bash "$SRC_DIR/parse-response.sh" < "$FIXTURES_DIR/sample-openrouter-response-approved.json")
    comment=$(bash "$SRC_DIR/format-verdict.sh" <<< "$parsed")

    # The comment must contain markers parse-verdict.sh looks for.
    [[ "$comment" == *"### Code Review"* ]]
    [[ "$comment" == *'`agent-'* ]]  # Backtick-wrapped verdict label.
    [[ "$comment" == *"View job"* ]]
}

@test "format-verdict: renders category and confidence when present" {
    review='{"review_plan":"plan","verdict":"changes","other_checks":"","top_must_fix":[],"findings":[{"path":"src/a.ts","line":12,"severity":"high","category":"security","confidence":"high","text":"Unsanitized input reaches the query."}]}'

    run bash "$SRC_DIR/format-verdict.sh" <<< "$review"
    [ "$status" -eq 0 ]
    [[ "$output" == *"src/a.ts:12"* ]]
    [[ "$output" == *"_(security · high)_"* ]]

    # Still parse-verdict.sh-compatible: the finding line parses to one finding.
    n=$(printf '%s\n' "$output" | bash "$REPO_ROOT/scripts/parse-verdict.sh" | jq '.findings | length')
    [ "$n" -eq 1 ]
}

@test "format-verdict: tolerates findings missing category/confidence" {
    review='{"review_plan":"","verdict":"approved","other_checks":"","top_must_fix":[],"findings":[{"path":"src/b.ts","line":3,"severity":"low","text":"Minor nit."}]}'

    run bash "$SRC_DIR/format-verdict.sh" <<< "$review"
    [ "$status" -eq 0 ]
    [[ "$output" == *"src/b.ts:3"* ]]
    [[ "$output" != *"_("* ]]
}

@test "format-verdict: no findings produces zero-count message" {
    # Construct a review with zero findings.
    review='{"review_plan":"","verdict":"approved","findings":[],"other_checks":"","top_must_fix":[]}'

    run bash "$SRC_DIR/format-verdict.sh" <<< "$review"
    [ "$status" -eq 0 ]

    [[ "$output" == *"Findings (0)"* ]]
}

# --- Branding header (always present, even with no memory env) ---

@test "format-verdict: branding header present with NO memory env" {
    review='{"review_plan":"","verdict":"approved","findings":[],"other_checks":"","top_must_fix":[]}'

    run bash "$SRC_DIR/format-verdict.sh" <<< "$review"
    [ "$status" -eq 0 ]

    # First body line is the branding header (default name + logo img).
    [[ "$output" == *'width="20" align="left"'* ]]
    [[ "$output" == *'**Toolu — Code Review**'* ]]
    [[ "$output" == *"code-review/assets/logo.png"* ]]
    # The legacy header must survive unchanged for the dedup fallback.
    [[ "$output" == *"### Code Review"* ]]
    # No memory blocks when no memory env is set.
    [[ "$output" != *"Changes since last review"* ]]
    [[ "$output" != *"Review history"* ]]
    [[ "$output" != *"toolu-review-state"* ]]
}

@test "format-verdict: branding header honors INPUT_BOT_NAME / INPUT_BOT_LOGO_URL" {
    review='{"review_plan":"","verdict":"approved","findings":[],"other_checks":"","top_must_fix":[]}'

    run env INPUT_BOT_NAME="Acme Reviewer" INPUT_BOT_LOGO_URL="https://example.com/x.png" \
        bash "$SRC_DIR/format-verdict.sh" <<< "$review"
    [ "$status" -eq 0 ]
    [[ "$output" == *'**Acme Reviewer**'* ]]
    [[ "$output" == *'src="https://example.com/x.png"'* ]]
}

# --- Recap (changes since last review) ---

@test "format-verdict: recap section present with REVIEW_RECAP_JSON (resolved/open/new)" {
    review='{"review_plan":"","verdict":"changes","other_checks":"","top_must_fix":[],"findings":[{"path":"src/new/file.ts","line":9,"severity":"blocker","text":"Hardcoded secret token in source."}]}'
    recap=$(cat "$FIXTURES_DIR/state/recap-full.json")

    run env REVIEW_RECAP_JSON="$recap" FULL_REVIEW=true \
        bash "$SRC_DIR/format-verdict.sh" <<< "$review"
    [ "$status" -eq 0 ]

    [[ "$output" == *"### Changes since last review"* ]]
    # Counts from the fixture: resolved 2, open 1, new 1.
    [[ "$output" == *"✅ Resolved (2)"* ]]
    [[ "$output" == *"🔁 Still open (1)"* ]]
    [[ "$output" == *"⚠️ New (1)"* ]]
    # Items are rendered with `path:line` — text.
    [[ "$output" == *'`src/auth/login.ts:42`'* ]]
    [[ "$output" == *'`src/utils/format.ts:17`'* ]]
}

@test "format-verdict: NO recap section on first run (no REVIEW_RECAP_JSON)" {
    review='{"review_plan":"","verdict":"changes","other_checks":"","top_must_fix":[],"findings":[{"path":"a.ts","line":1,"severity":"high","text":"x"}]}'

    run bash "$SRC_DIR/format-verdict.sh" <<< "$review"
    [ "$status" -eq 0 ]
    [[ "$output" != *"Changes since last review"* ]]
}

@test "format-verdict: FULL_REVIEW=false => scoped note and no resolved list" {
    review='{"review_plan":"","verdict":"changes","other_checks":"","top_must_fix":[],"findings":[{"path":"src/auth/login.ts","line":42,"severity":"high","text":"SQL injection."}]}'
    recap=$(cat "$FIXTURES_DIR/state/recap-full.json")

    run env REVIEW_RECAP_JSON="$recap" FULL_REVIEW=false \
        bash "$SRC_DIR/format-verdict.sh" <<< "$review"
    [ "$status" -eq 0 ]

    [[ "$output" == *"### Changes since last review"* ]]
    [[ "$output" == *"_scoped review — resolutions not recomputed_"* ]]
    [[ "$output" == *"🔁 Still open"* ]]
    # No Resolved bucket in scoped mode.
    [[ "$output" != *"✅ Resolved"* ]]
}

# --- History ---

@test "format-verdict: history <details> table rendered from REVIEW_HISTORY_JSON" {
    review='{"review_plan":"","verdict":"changes","other_checks":"","top_must_fix":[],"findings":[{"path":"a.ts","line":1,"severity":"high","text":"x"}]}'
    history=$(cat "$FIXTURES_DIR/state/history-2pass.json")

    run env REVIEW_HISTORY_JSON="$history" \
        bash "$SRC_DIR/format-verdict.sh" <<< "$review"
    [ "$status" -eq 0 ]

    [[ "$output" == *"<details><summary>📜 Review history (2 passes)</summary>"* ]]
    [[ "$output" == *"| Pass | Commit | Verdict | New | Open | Resolved |"* ]]
    [[ "$output" == *'`aaa1111`'* ]]
    [[ "$output" == *'`bbb2222`'* ]]
    [[ "$output" == *"</details>"* ]]
}

# --- Memory disabled ---

@test "format-verdict: INPUT_REVIEW_MEMORY=false => no recap/history/marker" {
    review='{"review_plan":"","verdict":"changes","other_checks":"","top_must_fix":[],"findings":[{"path":"a.ts","line":1,"severity":"high","text":"x"}]}'
    recap=$(cat "$FIXTURES_DIR/state/recap-full.json")
    history=$(cat "$FIXTURES_DIR/state/history-2pass.json")
    marker='<!-- toolu-review-state:v1 PAYLOAD -->'

    run env INPUT_REVIEW_MEMORY=false REVIEW_RECAP_JSON="$recap" \
        REVIEW_HISTORY_JSON="$history" REVIEW_STATE_MARKER="$marker" \
        bash "$SRC_DIR/format-verdict.sh" <<< "$review"
    [ "$status" -eq 0 ]

    [[ "$output" != *"Changes since last review"* ]]
    [[ "$output" != *"Review history"* ]]
    [[ "$output" != *"toolu-review-state"* ]]
    # Branding still present (it is not gated by memory).
    [[ "$output" == *'**Toolu — Code Review**'* ]]
}

# --- Marker ---

@test "format-verdict: marker appended as last line when REVIEW_STATE_MARKER set" {
    review='{"review_plan":"","verdict":"approved","findings":[],"other_checks":"","top_must_fix":[]}'
    marker='<!-- toolu-review-state:v1 H4sIDEADBEEF -->'

    run env REVIEW_STATE_MARKER="$marker" \
        bash "$SRC_DIR/format-verdict.sh" <<< "$review"
    [ "$status" -eq 0 ]

    [[ "$output" == *"$marker"* ]]
    # Marker is the very last line of the body.
    last=$(printf '%s\n' "$output" | tail -1)
    [ "$last" = "$marker" ]
}

# --- Body-size guard ---

@test "format-verdict: body-size guard => body <=65536 and marker survives" {
    # Build a huge findings input (>65k) cycling severities so truncation must
    # keep the highest-severity (blocker) findings first.
    big=$(jq -nc '{
        review_plan:"p", verdict:"changes", other_checks:"",
        top_must_fix:["**must fix**"],
        findings:[ range(0;900) as $i
            | { path:("src/file"+($i|tostring)+".ts"),
                line:$i,
                severity:(["blocker","high","medium","low","nit"][$i%5]),
                text:("A reasonably long finding description that repeats to inflate the body size well past the GitHub comment limit for finding number "+($i|tostring)+" with extra padding text here to make each line count.") } ]
    }')
    marker='<!-- toolu-review-state:v1 MUSTSURVIVE -->'

    run env REVIEW_STATE_MARKER="$marker" \
        bash "$SRC_DIR/format-verdict.sh" <<< "$big"
    [ "$status" -eq 0 ]

    # GitHub's hard limit is 65536; the assembled body must be at or under it.
    [ "${#output}" -le 65536 ]
    # The marker must ALWAYS survive truncation and remain the last line.
    [[ "$output" == *"$marker"* ]]
    last=$(printf '%s\n' "$output" | tail -1)
    [ "$last" = "$marker" ]
    # Truncation note points at the job log.
    [[ "$output" == *"more findings — see the [job log]"* ]]
    # Highest severity kept first: a blocker finding survives.
    [[ "$output" == *"blocker:"* ]]
}

@test "format-verdict: auto-generates top must-fix from blocker/high findings when none provided" {
    # Regression: the auto-generate jq previously used invalid \":\" escaping and
    # silently produced nothing. With an empty top_must_fix and a blocker finding,
    # the must-fix line must now render the path and text.
    input=$(jq -nc '{
        verdict: "changes",
        review_plan: "rp",
        other_checks: "",
        top_must_fix: [],
        findings: [
            { path: "src/auth.ts", line: 12, severity: "blocker", text: "Hardcoded secret in source" },
            { path: "src/util.ts", severity: "low", text: "minor nit" }
        ]
    }')

    run bash "$SRC_DIR/format-verdict.sh" <<< "$input"
    [ "$status" -eq 0 ]
    [[ "$output" == *"### Top-N must-fix"* ]]
    # The blocker is auto-promoted with path:line and its text (no jq error swallow).
    [[ "$output" == *'src/auth.ts:12'* ]]
    [[ "$output" == *"Hardcoded secret in source"* ]]
}
