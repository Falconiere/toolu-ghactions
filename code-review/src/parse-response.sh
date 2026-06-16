#!/usr/bin/env bash
# parse-response.sh — validate the OpenRouter JSON response, extract the
# verdict and findings from choices[0].message.content.
#
# Reads the OpenRouter API response from stdin.
# Outputs to stdout: a clean JSON object {verdict, findings[], other_checks, top_must_fix[]}
# Exits non-zero if the response is unparseable even after fallback.
set -euo pipefail

INPUT=$(cat)

# Try extracting content from an OpenRouter API response format.
CONTENT=""
if echo "$INPUT" | jq -e . >/dev/null 2>&1; then
    CONTENT=$(echo "$INPUT" | jq -r '.choices[0].message.content // ""')
fi

if [ -z "$CONTENT" ] || [ "$CONTENT" = "null" ]; then
    echo '{"error":"No content in OpenRouter response — model may have returned empty"}' >&2
    exit 1
fi

# Try parsing as JSON (the expected path with json_schema response_format).
if echo "$CONTENT" | jq -e . >/dev/null 2>&1; then
    PARSED=$(echo "$CONTENT" | jq -c '{
        review_plan: (.review_plan // ""),
        verdict: (.verdict // "changes"),
        findings: (.findings // []),
        other_checks: (.other_checks // ""),
        top_must_fix: (.top_must_fix // [])
    }')

    # Validate required fields.
    VERDICT=$(echo "$PARSED" | jq -r '.verdict')
    if [ "$VERDICT" != "approved" ] && [ "$VERDICT" != "changes" ]; then
        echo "{\"error\":\"Invalid verdict in response: $VERDICT\",\"raw\":$(echo "$CONTENT" | jq -Rc .)}" >&2
        exit 1
    fi

    echo "$PARSED"
    exit 0
fi

# Fallback: the model didn't return valid JSON. Try regex extraction.
echo "{\"warning\":\"LLM did not return valid JSON — attempting regex fallback\"}" >&2

FINDINGS_JSON="[]"
VERDICT="changes"

# Extract findings lines matching `path:line`: severity: text
while IFS= read -r line; do
    if [[ "$line" =~ ^\`([^\`]+)\`:\ (blocker|high|medium|low|nit):\ (.*)$ ]]; then
        raw_path="${BASH_REMATCH[1]}"
        sev="${BASH_REMATCH[2]}"
        text="${BASH_REMATCH[3]}"
        path="$raw_path"
        ln=""
        if [[ "$raw_path" =~ ^(.+):([0-9]+)$ ]]; then
            path="${BASH_REMATCH[1]}"
            ln="${BASH_REMATCH[2]}"
        fi
        obj=$(jq -nc --arg path "$path" --arg line "$ln" --arg severity "$sev" --arg text "$text" \
            '{path:$path, line:(if $line=="" then null else ($line|tonumber) end), severity:$severity, text:$text}')
        FINDINGS_JSON=$(echo "$FINDINGS_JSON" | jq -c --argjson o "$obj" '. + [$o]')
    fi
done <<< "$CONTENT"

# Check for approval signals in raw text.
if echo "$CONTENT" | grep -qiE 'agent-merge-approved|\*\*Approved\*\*|verdict.*approved'; then
    VERDICT="approved"
elif echo "$CONTENT" | grep -qiE 'agent-request-changes|\*\*Changes requested\*\*|verdict.*changes'; then
    VERDICT="changes"
fi

OTHER_CHECKS=""
TOP_MUST_FIX="[]"

jq -nc \
    --arg plan "" \
    --arg verdict "$VERDICT" \
    --argjson findings "$FINDINGS_JSON" \
    --arg other "$OTHER_CHECKS" \
    --argjson top "$TOP_MUST_FIX" \
    '{review_plan:$plan, verdict:$verdict, findings:$findings, other_checks:$other, top_must_fix:$top}'
