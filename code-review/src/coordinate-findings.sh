#!/usr/bin/env bash
# coordinate-findings.sh — coordinator pass. Sends the validated finding union to
# the coordinator LLM (prompts/coordinator.txt) to deduplicate, filter for
# reasonableness, set the verdict, and write the review plan + top must-fix list.
#
# stdin : { findings: [ ... ] }   (validated union from validate-findings.sh)
# stdout: { review_plan, verdict, findings, other_checks, top_must_fix }
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MODEL="${INPUT_MODEL:-minimax/minimax-m3}"
FALLBACK_MODEL="${INPUT_FALLBACK_MODEL:-anthropic/claude-sonnet-4-5}"
MAX_TOKENS="${INPUT_MAX_TOKENS:-4096}"

UNION=$(cat)

# No findings → approved without spending a coordinator call.
N=$(printf '%s' "$UNION" | jq '(.findings // []) | length')
if [ "$N" -eq 0 ]; then
    jq -nc '{review_plan:"No findings from any dimension.", verdict:"approved", findings:[], other_checks:"", top_must_fix:[]}'
    exit 0
fi

COORD=""
for p in "/action/prompts/coordinator.txt" "$SCRIPT_DIR/../prompts/coordinator.txt" "code-review/prompts/coordinator.txt"; do
    [ -f "$p" ] && { COORD="$p"; break; }
done
if [ -z "$COORD" ]; then
    jq -nc '{error:"coordinator.txt not found in image"}' >&2
    exit 1
fi

SYS=$(cat "$COORD")
USERMSG=$(printf '%s' "$UNION" | jq -c '{findings: (.findings // [])}')
SYS_ESC=$(printf '%s' "$SYS" | jq -Rs .)
USER_ESC=$(printf '%s' "$USERMSG" | jq -Rs .)

BODY=$(jq -nc \
    --arg model "$MODEL" --arg fb "$FALLBACK_MODEL" --argjson maxtok "$MAX_TOKENS" \
    --argjson sys "$SYS_ESC" --argjson user "$USER_ESC" \
    '{model:$model, models:[$model,$fb], messages:[{role:"system",content:$sys},{role:"user",content:$user}], temperature:0.1, max_tokens:$maxtok}')

RESPONSE=$(printf '%s' "$BODY" | bash "$SCRIPT_DIR/call-openrouter.sh")
printf '%s' "$RESPONSE" | bash "$SCRIPT_DIR/parse-response.sh"
