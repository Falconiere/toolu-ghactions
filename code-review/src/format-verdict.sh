#!/usr/bin/env bash
# format-verdict.sh — render the markdown verdict comment from the structured
# review output of parse-response.sh.
#
# Reads parse-response.sh JSON from stdin.
# Reads GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_HEAD_REF from env.
# Outputs to stdout: the complete markdown comment body.
set -euo pipefail

INPUT=$(cat)

REVIEW_PLAN=$(echo "$INPUT" | jq -r '.review_plan // ""')
VERDICT=$(echo "$INPUT" | jq -r '.verdict // ""')
FINDINGS=$(echo "$INPUT" | jq -c '.findings // []')
OTHER_CHECKS=$(echo "$INPUT" | jq -r '.other_checks // ""')
TOP_MUST_FIX=$(echo "$INPUT" | jq -c '.top_must_fix // []')
FINDINGS_COUNT=$(echo "$FINDINGS" | jq 'length')

# Default verdict to approved if there are no findings and verdict is not explicitly set.
if [ -z "$VERDICT" ] || [ "$VERDICT" = "null" ]; then
    if [ "$FINDINGS_COUNT" -eq 0 ]; then
        VERDICT="approved"
    else
        VERDICT="changes"
    fi
fi

# Build the job URL.
JOB_URL="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-unknown}/actions/runs/${GITHUB_RUN_ID:-?}"
BRANCH="${GITHUB_HEAD_REF:-unknown}"

# Compute duration if timing info is available.
DURATION=""
if [ -n "${REVIEW_START_TIME:-}" ]; then
    NOW=$(date +%s)
    ELAPSED=$((NOW - REVIEW_START_TIME))
    if [ "$ELAPSED" -lt 60 ]; then
        DURATION="${ELAPSED}s"
    else
        MINS=$((ELAPSED / 60))
        SECS=$((ELAPSED % 60))
        DURATION="${MINS}m ${SECS}s"
    fi
fi

# Determine verdict label and severity summary.
if [ "$VERDICT" = "approved" ]; then
    VERDICT_LABEL='`agent-merge-approved`'
    VERDICT_BADGE="✅ Approved"
else
    VERDICT_LABEL='`agent-request-changes`'
    VERDICT_BADGE="⚠️ Changes requested"
fi

# Count by severity.
BLOCKER_COUNT=$(echo "$FINDINGS" | jq '[.[] | select(.severity == "blocker")] | length')
HIGH_COUNT=$(echo "$FINDINGS" | jq '[.[] | select(.severity == "high")] | length')
MEDIUM_COUNT=$(echo "$FINDINGS" | jq '[.[] | select(.severity == "medium")] | length')
LOW_COUNT=$(echo "$FINDINGS" | jq '[.[] | select(.severity == "low")] | length')
NIT_COUNT=$(echo "$FINDINGS" | jq '[.[] | select(.severity == "nit")] | length')

# Build the header line.
if [ -n "$DURATION" ]; then
    HEADER="**AI Code Review finished in ${DURATION}**"
else
    HEADER="**AI Code Review finished**"
fi
HEADER="${HEADER} —— [View job](${JOB_URL})"

# Build findings section.
build_findings_section() {
    if [ "$FINDINGS_COUNT" -eq 0 ]; then
        echo "_No findings._"
        return
    fi

    # Category/confidence are appended AFTER the text so the line still matches
    # parse-verdict.sh's `path:line`: severity: text regex (text just carries the
    # suffix). Both fields are optional — older single-call output omits them.
    echo "$FINDINGS" | jq -r '
        .[]
        | "`" + .path + (if .line then ":" + (.line|tostring) else "" end) + "`: "
          + .severity + ": " + .text
          + ( [ (.category // empty), (.confidence // empty) ]
              | if length > 0 then " _(" + join(" · ") + ")_" else "" end )'
}

# Build top must-fix section.
build_top_must_fix_section() {
    local top_json="$1"
    local count
    count=$(echo "$top_json" | jq 'length')

    if [ "$count" -eq 0 ]; then
        # Auto-generate from highest-severity findings if not provided.
        local blockers
        blockers=$(echo "$FINDINGS" | jq -r '.[] | select(.severity == "blocker" or .severity == "high") | "**`\(.path)\(if .line then \":\" + (.line|tostring) else \"\" end)`** — \(.text)"' 2>/dev/null || true)
        if [ -n "$blockers" ]; then
            echo "$blockers"
        elif [ "$FINDINGS_COUNT" -gt 0 ]; then
            echo "$FINDINGS" | jq -r '.[0:3] | to_entries | .[] | "**`\(.value.path)\(if .value.line then \":\" + (.value.line|tostring) else \"\" end)`** — \(.value.text)"'
        else
            echo "_None._"
        fi
    else
        echo "$top_json" | jq -r '.[]'
    fi
}

# Build severity summary line.
build_severity_summary() {
    local parts=()
    [ "$BLOCKER_COUNT" -gt 0 ] && parts+=("🔴 $BLOCKER_COUNT blocker")
    [ "$HIGH_COUNT" -gt 0 ] && parts+=("🟠 $HIGH_COUNT high")
    [ "$MEDIUM_COUNT" -gt 0 ] && parts+=("🟡 $MEDIUM_COUNT medium")
    [ "$LOW_COUNT" -gt 0 ] && parts+=("🔵 $LOW_COUNT low")
    [ "$NIT_COUNT" -gt 0 ] && parts+=("⚪ $NIT_COUNT nit")

    if [ ${#parts[@]} -gt 0 ]; then
        printf '%s\n' "${parts[@]}" | paste -sd ' ' -
        echo
    fi
}

# Render the full comment.
cat <<MARKDOWN
${HEADER}

---
### Code Review — \`${BRANCH}\`

- [x] Read repository context and PR diff
- [x] Review changed files
- [x] Analyze correctness, security, performance
- [x] Post findings
- [x] Set verdict label (${VERDICT_LABEL})

**Verdict:** ${VERDICT_BADGE}   $(build_severity_summary)

### Review Plan
$( [ -n "$REVIEW_PLAN" ] && echo "$REVIEW_PLAN" || echo "_No review plan provided._" )

### Findings ($FINDINGS_COUNT)

$(build_findings_section)

### Other checks
$( [ -n "$OTHER_CHECKS" ] && echo "$OTHER_CHECKS" || echo "_No additional checks performed._" )

### Top-N must-fix
$(build_top_must_fix_section "$TOP_MUST_FIX")

${VERDICT_LABEL}
MARKDOWN
