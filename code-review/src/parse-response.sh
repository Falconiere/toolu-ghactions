#!/usr/bin/env bash
# parse-response.sh — normalize the provider's raw response into the standard review shape.
#
# Reads the raw provider response JSON on stdin; reads $PROVIDER and $ENFORCE_JSON_SCHEMA
# env vars to dispatch on the right JSON path.
#
# Output shape (success):
#   { provider, model, verdict, findings: [...], review_plan, other_checks, top_must_fix }
# On error / no content:
#   { provider, model, error, verdict: null, findings: [] }
#
# Dispatch:
#   openrouter | openai | deepseek | moonshot | minimax  -> .choices[0].message.content
#   anthropic + enforce_json_schema=true                  -> .content[?(@.type=="tool_use" and @.name=="submit_review")].input
#   anthropic + enforce_json_schema=false                 -> .content[?(@.type=="text")].text|[0]
# Fallback chain for anthropic: tool_use -> text-block -> regex (with warning log on each fallback).
set -euo pipefail

INPUT=$(cat)

PROVIDER="${PROVIDER:-openrouter}"
ENFORCE="${ENFORCE_JSON_SCHEMA:-true}"

# Extract the review content string per provider.
extract_content() {
    local raw="$1" provider="$2" enforce="$3"
    if ! echo "$raw" | jq -e . >/dev/null 2>&1; then
        jq -nc '{error:"raw response is not JSON"}' >&2
        return 1
    fi

    case "$provider" in
        openrouter|openai|deepseek|moonshot|minimax)
            echo "$raw" | jq -r '.choices[0].message.content // ""'
            ;;
        anthropic)
            if [ "$enforce" = "true" ]; then
                # Tool-use path: extract the input object as JSON.
                local tool_input
                tool_input=$(echo "$raw" | jq -c '.content[]? | select(.type=="tool_use" and .name=="submit_review") | .input' 2>/dev/null | head -1 || true)
                if [ -n "$tool_input" ] && [ "$tool_input" != "null" ] && [ "$tool_input" != "" ]; then
                    echo "$tool_input"
                    return 0
                fi
                echo "parse-response: anthropic tool_use absent, falling back to text-block path" >&2
            fi
            # Text-block path (also the fallback after tool_use is absent).
            local text
            text=$(echo "$raw" | jq -r '.content[]? | select(.type=="text") | .text' 2>/dev/null | head -1 || true)
            if [ -n "$text" ] && [ "$text" != "null" ]; then
                echo "$text"
                return 0
            fi
            echo "parse-response: anthropic text-block absent, falling back to regex" >&2
            return 1
            ;;
        *)
            jq -nc --arg p "$provider" '{error:("unknown provider: " + $p)}' >&2
            return 1
            ;;
    esac
}

# Get a JSON object from the content string: as-is, fence-stripped, then the first {...} block.
get_json() {
    local c="$1"
    if printf '%s' "$c" | jq -e . >/dev/null 2>&1; then printf '%s' "$c"; return 0; fi
    local stripped
    stripped=$(printf '%s\n' "$c" | sed -e 's/^[[:space:]]*```[a-zA-Z]*[[:space:]]*$//' -e 's/^[[:space:]]*```[[:space:]]*$//')
    if printf '%s' "$stripped" | jq -e . >/dev/null 2>&1; then printf '%s' "$stripped"; return 0; fi
    local braced
    braced=$(printf '%s\n' "$c" | awk '/\{/{f=1} f{print}' | awk '{a[NR]=$0} /\}/{last=NR} END{for(i=1;i<=last;i++) print a[i]}')
    if printf '%s' "$braced" | jq -e . >/dev/null 2>&1; then printf '%s' "$braced"; return 0; fi
    return 1
}

# Normalize a JSON object to the standard review shape.
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

# 1. Try to extract the content.
CONTENT=$(extract_content "$INPUT" "$PROVIDER" "$ENFORCE" 2>/dev/null || true)

if [ -z "$CONTENT" ] || [ "$CONTENT" = "null" ]; then
    jq -nc --arg p "$PROVIDER" '{error:("No content in " + $p + " response — model may have returned empty")}' >&2
    jq -nc --arg p "$PROVIDER" '{provider:$p, model:"", error:"empty content", verdict:null, findings:[]}'
    exit 0
fi

# 2. If anthropic + tool_use path, content is already a JSON object. Otherwise it's a string.
if JSON=$(get_json "$CONTENT"); then
    # Anthropic tool-use: provider/model are not in the input object; we drop them, caller stamps.
    NORMALIZED=$(echo "$JSON" | jq -c "$NORMALIZE")
    echo "$NORMALIZED"
    exit 0
fi

# 3. Regex fallback for free-text responses.
echo "parse-response: LLM did not return valid JSON — using regex fallback" >&2
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
