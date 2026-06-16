#!/usr/bin/env bash
# parse-response.sh — extract and normalize the review JSON from an OpenRouter
# response. Handles three content shapes: clean JSON (schema mode), ```json-fenced
# or prose-wrapped JSON (a model that ignored the schema), and free text (regex
# fallback). Output carries both dimension-mode (`reasoning`) and coordinator-mode
# (`review_plan`/`other_checks`/`top_must_fix`) fields; each consumer reads what it needs.
set -euo pipefail

INPUT=$(cat)

CONTENT=""
if echo "$INPUT" | jq -e . >/dev/null 2>&1; then
    CONTENT=$(echo "$INPUT" | jq -r '.choices[0].message.content // ""')
fi
if [ -z "$CONTENT" ] || [ "$CONTENT" = "null" ]; then
    jq -nc '{error:"No content in OpenRouter response — model may have returned empty"}' >&2
    exit 1
fi

# Obtain a JSON object from the content: as-is, then fence-stripped, then the
# first {...last } block (tolerates a leading reasoning/<thinking> preamble).
get_json() {
    local c="$1" stripped braced
    if printf '%s' "$c" | jq -e . >/dev/null 2>&1; then printf '%s' "$c"; return 0; fi
    stripped=$(printf '%s\n' "$c" | sed -e 's/^[[:space:]]*```[a-zA-Z]*[[:space:]]*$//' -e 's/^[[:space:]]*```[[:space:]]*$//')
    if printf '%s' "$stripped" | jq -e . >/dev/null 2>&1; then printf '%s' "$stripped"; return 0; fi
    braced=$(printf '%s\n' "$c" | awk '/\{/{f=1} f{print}' | awk '{a[NR]=$0} /\}/{last=NR} END{for(i=1;i<=last;i++) print a[i]}')
    if printf '%s' "$braced" | jq -e . >/dev/null 2>&1; then printf '%s' "$braced"; return 0; fi
    return 1
}

NORMALIZE='{
    review_plan: (.review_plan // ""),
    reasoning: (.reasoning // ""),
    verdict: (if (.verdict == "approved" or .verdict == "changes") then .verdict else "changes" end),
    findings: [ (.findings // [])[] | {
        path: (.path // ""),
        line: (.line // null),
        end_line: (.end_line // .line // null),
        severity: (.severity // "low"),
        category: (.category // null),
        confidence: (.confidence // null),
        quoted_line: (.quoted_line // null),
        suggestion: (.suggestion // null),
        text: (.text // "")
    } ],
    other_checks: (.other_checks // ""),
    top_must_fix: (.top_must_fix // [])
}'

if JSON=$(get_json "$CONTENT"); then
    echo "$JSON" | jq -c "$NORMALIZE"
    exit 0
fi

# Fallback: free text. Extract `path:line`: severity: text lines; sniff verdict.
jq -nc '{warning:"LLM did not return valid JSON — using regex fallback"}' >&2
FINDINGS_JSON="[]"
while IFS= read -r line; do
    if [[ "$line" =~ ^\`([^\`]+)\`:\ (blocker|high|medium|low|nit):\ (.*)$ ]]; then
        raw_path="${BASH_REMATCH[1]}"; sev="${BASH_REMATCH[2]}"; text="${BASH_REMATCH[3]}"
        path="$raw_path"; ln=""
        if [[ "$raw_path" =~ ^(.+):([0-9]+)$ ]]; then path="${BASH_REMATCH[1]}"; ln="${BASH_REMATCH[2]}"; fi
        obj=$(jq -nc --arg path "$path" --arg line "$ln" --arg severity "$sev" --arg text "$text" \
            '{path:$path, line:(if $line=="" then null else ($line|tonumber) end), end_line:(if $line=="" then null else ($line|tonumber) end), severity:$severity, category:null, confidence:null, quoted_line:null, suggestion:null, text:$text}')
        FINDINGS_JSON=$(echo "$FINDINGS_JSON" | jq -c --argjson o "$obj" '. + [$o]')
    fi
done <<< "$CONTENT"

VERDICT="changes"
if echo "$CONTENT" | grep -qiE 'agent-merge-approved|\*\*Approved\*\*|"verdict"[[:space:]]*:[[:space:]]*"approved"'; then
    VERDICT="approved"
fi

jq -nc --argjson findings "$FINDINGS_JSON" --arg verdict "$VERDICT" \
    '{review_plan:"", reasoning:"", verdict:$verdict, findings:$findings, other_checks:"", top_must_fix:[]}'
