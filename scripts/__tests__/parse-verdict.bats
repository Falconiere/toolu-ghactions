#!/usr/bin/env bats
# parse-verdict.bats — parse REAL verdict-comment bodies (the exact markdown the
# reviewer renders, copied from code-review/src/review/findings.ts's output) into
# the JSON the babysit loop acts on. No mocks: the script runs as CI runs it, and
# jq parses its output.
#
# The comment layout and this parser are one contract; its other half is tested
# from the renderer's side in code-review/src/review/__tests__/findings.test.ts.

setup() {
    REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    SCRIPT="$REPO_ROOT/scripts/parse-verdict.sh"
}

# Wrap a findings section in the surrounding comment the reviewer posts.
comment() {
    cat <<EOF
<img src="https://example.com/logo.png" width="20" align="left"> **Toolu — Code Review**

**AI Code Review finished in 1m 38s** —— [View job](https://github.com/o/r/actions/runs/123)

---
### Code Review — \`feature-branch\`

- [x] Reviewed 4-file diff — verdict set

**Verdict:** ⚠️ Changes requested   🔴 1 blocker 🟡 1 medium

$(cat)

### Other checks

Tests look adequate.

\`agent-request-changes\`
EOF
}

@test "grouped layout: every finding comes back with path, line, severity and text" {
    body=$(comment <<'EOF'
### Findings (2)

#### 🔴 Blocker · 1

**1.** `apps/api/src/auth.ts` **L75**
<sub>security · high confidence</sub>

The allowlist pattern `:name` matches exactly one non-empty segment.

#### 🟡 Medium · 1

**2.** `apps/console/src/hooks/use-delete-repos.ts` **L58**
<sub>correctness · high confidence</sub>

The deleteInTurn function uses recursion instead of a loop.
EOF
)
    run bash -c "printf '%s' \"\$1\" | '$SCRIPT'" _ "$body"
    [ "$status" -eq 0 ]
    [ "$(jq -r '.verdict' <<<"$output")" = "changes" ]
    [ "$(jq -r '.complete' <<<"$output")" = "true" ]
    [ "$(jq -r '.findings | length' <<<"$output")" = "2" ]
    [ "$(jq -r '.findings[0].path' <<<"$output")" = "apps/api/src/auth.ts" ]
    [ "$(jq -r '.findings[0].line' <<<"$output")" = "75" ]
    [ "$(jq -r '.findings[0].severity' <<<"$output")" = "blocker" ]
    [ "$(jq -r '.findings[0].text' <<<"$output")" = 'The allowlist pattern `:name` matches exactly one non-empty segment.' ]
    [ "$(jq -r '.findings[1].severity' <<<"$output")" = "medium" ]
    [ "$(jq -r '.findings[1].line' <<<"$output")" = "58" ]
}

@test "grouped layout: a finding with no line anchor parses with line null" {
    body=$(comment <<'EOF'
### Findings (1)

#### 🔵 Low · 1

**1.** `docs/readme.md`
<sub>doc/comment accuracy</sub>

Stale link to the old runbook.
EOF
)
    run bash -c "printf '%s' \"\$1\" | '$SCRIPT'" _ "$body"
    [ "$status" -eq 0 ]
    [ "$(jq -r '.findings | length' <<<"$output")" = "1" ]
    [ "$(jq -r '.findings[0].line' <<<"$output")" = "null" ]
    [ "$(jq -r '.findings[0].severity' <<<"$output")" = "low" ]
}

@test "grouped layout: the size-guard truncation note is not read as a finding" {
    body=$(comment <<'EOF'
### Findings (40)

#### 🔴 Blocker · 1

**1.** `src/a.ts` **L1**
<sub>correctness · high confidence</sub>

Only the worst finding survived the size cap.

_… 39 more findings — see the [job log](https://ci.example/job/1)_
EOF
)
    run bash -c "printf '%s' \"\$1\" | '$SCRIPT'" _ "$body"
    [ "$status" -eq 0 ]
    [ "$(jq -r '.findings | length' <<<"$output")" = "1" ]
    [ "$(jq -r '.findings[0].path' <<<"$output")" = "src/a.ts" ]
}

@test "old one-line layout still parses (comments written by an earlier bot)" {
    body=$(comment <<'EOF'
### Findings (2)
`src/utils/format.ts:17`: low: Comment says 'Temporary workaround' with no removal date.
`src/login.ts`: high: Token compared with ==.
EOF
)
    run bash -c "printf '%s' \"\$1\" | '$SCRIPT'" _ "$body"
    [ "$status" -eq 0 ]
    [ "$(jq -r '.findings | length' <<<"$output")" = "2" ]
    [ "$(jq -r '.findings[0].path' <<<"$output")" = "src/utils/format.ts" ]
    [ "$(jq -r '.findings[0].line' <<<"$output")" = "17" ]
    [ "$(jq -r '.findings[1].line' <<<"$output")" = "null" ]
    [ "$(jq -r '.findings[1].severity' <<<"$output")" = "high" ]
}

@test "sections after the findings block are never read as findings" {
    body=$(comment <<'EOF'
### Findings (1)

#### 🟡 Medium · 1

**1.** `src/a.ts` **L4**
<sub>correctness</sub>

Real finding.

### Unanchored findings (1)

- `src/hidden.ts:9`: high: Not part of the Findings block.
EOF
)
    run bash -c "printf '%s' \"\$1\" | '$SCRIPT'" _ "$body"
    [ "$status" -eq 0 ]
    [ "$(jq -r '.findings | length' <<<"$output")" = "1" ]
    [ "$(jq -r '.findings[0].path' <<<"$output")" = "src/a.ts" ]
}

@test "a non-review comment yields no findings and no verdict" {
    run bash -c "printf '%s' 'just a normal PR comment about #### High hopes' | '$SCRIPT'"
    [ "$status" -eq 0 ]
    [ "$(jq -r '.is_review_comment' <<<"$output")" = "false" ]
    [ "$(jq -r '.findings | length' <<<"$output")" = "0" ]
}
