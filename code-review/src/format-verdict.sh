#!/usr/bin/env bash
# format-verdict.sh — render the markdown verdict comment from the structured
# review output of parse-response.sh.
#
# Reads parse-response.sh JSON from stdin.
# Reads GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_HEAD_REF from env.
# Cross-push memory (all optional; absent => behave like today + branding header):
#   INPUT_BOT_NAME       branding name (default `Toolu — Code Review`)
#   INPUT_BOT_LOGO_URL   branding logo URL
#   INPUT_REVIEW_MEMORY  "true" (default); when not "true", skip recap+history+marker
#   REVIEW_RECAP_JSON    review-state diff output (present only with a PRIOR review)
#   REVIEW_HISTORY_JSON  history array (present with >=1 pass)
#   REVIEW_STATE_MARKER  pre-encoded single-line marker, appended verbatim at end
#   FULL_REVIEW          "true"/"false"; recap rendering differs when "false"
# Outputs to stdout: the complete markdown comment body.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# render-recap.sh renders the recap + history markdown from the env JSON.
RENDER_RECAP="$SCRIPT_DIR/render-recap.sh"

# GitHub rejects comment bodies over 65536 chars; rebuild below this ceiling.
BODY_SIZE_LIMIT=65000

# Branding header (always present — it is body content, not metadata).
BOT_NAME="${INPUT_BOT_NAME:-Toolu — Code Review}"
BOT_LOGO_URL="${INPUT_BOT_LOGO_URL:-https://raw.githubusercontent.com/falconiere/toolu-ghactions/main/code-review/assets/logo.png}"
REVIEW_MEMORY="${INPUT_REVIEW_MEMORY:-true}"

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
        blockers=$(echo "$FINDINGS" | jq -r '.[] | select(.severity == "blocker" or .severity == "high") | "**`\(.path)\(if .line then ":" + (.line|tostring) else "" end)`** — \(.text)"' 2>/dev/null || true)
        if [ -n "$blockers" ]; then
            echo "$blockers"
        elif [ "$FINDINGS_COUNT" -gt 0 ]; then
            echo "$FINDINGS" | jq -r '.[0:3] | to_entries | .[] | "**`\(.value.path)\(if .value.line then ":" + (.value.line|tostring) else "" end)`** — \(.value.text)"'
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

# Build a findings section truncated to the highest-severity $1 findings, with a
# trailing "_… N more findings_" note pointing at the job log. Used by the
# body-size guard to shrink the body while keeping the worst findings.
SEVERITY_RANK='{"blocker":0,"high":1,"medium":2,"low":3,"nit":4}'
build_truncated_findings_section() {
    local keep="$1" ordered shown extra
    ordered=$(echo "$FINDINGS" | jq -c --argjson rank "$SEVERITY_RANK" \
        'sort_by($rank[.severity] // 5)')
    shown=$(echo "$ordered" | jq -c ".[0:$keep]")
    echo "$shown" | jq -r '
        .[]
        | "`" + .path + (if .line then ":" + (.line|tostring) else "" end) + "`: "
          + .severity + ": " + .text
          + ( [ (.category // empty), (.confidence // empty) ]
              | if length > 0 then " _(" + join(" · ") + ")_" else "" end )'
    extra=$((FINDINGS_COUNT - keep))
    if [ "$extra" -gt 0 ]; then
        printf '_… %s more findings — see the [job log](%s)_\n' "$extra" "$JOB_URL"
    fi
}

# Recap + history markdown (empty unless memory is on and the env JSON is present).
RECAP_SECTION=""
HISTORY_SECTION=""
if [ "$REVIEW_MEMORY" = "true" ]; then
    # Memory is best-effort and must never block the verdict comment: a render
    # failure (e.g. malformed recap/history JSON) degrades to an empty section
    # rather than aborting the whole body under `set -e`.
    RECAP_SECTION=$(REVIEW_RECAP_JSON="${REVIEW_RECAP_JSON:-}" FULL_REVIEW="${FULL_REVIEW:-true}" \
        bash "$RENDER_RECAP" recap || true)
    HISTORY_SECTION=$(REVIEW_HISTORY_JSON="${REVIEW_HISTORY_JSON:-}" \
        bash "$RENDER_RECAP" history || true)
fi

# Marker line, appended verbatim as the LAST line when memory is on. Never dropped.
MARKER=""
if [ "$REVIEW_MEMORY" = "true" ] && [ -n "${REVIEW_STATE_MARKER:-}" ]; then
    MARKER="$REVIEW_STATE_MARKER"
fi

# Render the full comment given a findings section. The recap, history, and
# marker are emitted unconditionally here so the size guard can only ever shrink
# the FINDINGS section, never the memory blocks.
render_body() {
    local findings_section="$1"
    printf '%s\n\n' "<img src=\"${BOT_LOGO_URL}\" width=\"20\" align=\"left\"> **${BOT_NAME}**"
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
MARKDOWN
    if [ -n "$RECAP_SECTION" ]; then
        printf '\n%s\n' "$RECAP_SECTION"
    fi
    cat <<MARKDOWN

### Review Plan
$( [ -n "$REVIEW_PLAN" ] && echo "$REVIEW_PLAN" || echo "_No review plan provided._" )

### Findings ($FINDINGS_COUNT)

${findings_section}

### Other checks
$( [ -n "$OTHER_CHECKS" ] && echo "$OTHER_CHECKS" || echo "_No additional checks performed._" )

### Top-N must-fix
$(build_top_must_fix_section "$TOP_MUST_FIX")
MARKDOWN
    if [ -n "$HISTORY_SECTION" ]; then
        printf '\n%s\n' "$HISTORY_SECTION"
    fi
    printf '\n%s\n' "${VERDICT_LABEL}"
    if [ -n "$MARKER" ]; then
        printf '\n%s\n' "$MARKER"
    fi
}

# Assemble the body, then enforce GitHub's size limit by shrinking the findings
# list (highest severity first) while the recap/history/marker always survive.
BODY=$(render_body "$(build_findings_section)")
if [ "${#BODY}" -gt "$BODY_SIZE_LIMIT" ] && [ "$FINDINGS_COUNT" -gt 0 ]; then
    keep="$FINDINGS_COUNT"
    while [ "$keep" -gt 0 ] && [ "${#BODY}" -gt "$BODY_SIZE_LIMIT" ]; do
        keep=$((keep / 2))
        BODY=$(render_body "$(build_truncated_findings_section "$keep")")
    done
fi

# The marker must always be the last line; fail loudly if the guard ever drops it.
if [ -n "$MARKER" ] && [[ "$BODY" != *"$MARKER"* ]]; then
    echo "format-verdict: body-size guard dropped the state marker" >&2
    exit 1
fi

printf '%s\n' "$BODY"
