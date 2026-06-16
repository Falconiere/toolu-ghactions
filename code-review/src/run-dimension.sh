#!/usr/bin/env bash
# run-dimension.sh — run one scoped sub-reviewer end to end.
#
# Reads the diff JSON (fetch-diff.sh output) from stdin; INPUT_DIMENSION names
# the dimension (correctness|security|performance|tests). Pipes diff →
# build-prompt → call-openrouter → parse-response and emits that dimension's
# result. Exits non-zero on any stage failure so main.sh can collect per-job status.
#
# stdout: { dimension, verdict, reasoning, findings:[...] }
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIM="${INPUT_DIMENSION:-}"
if [ -z "$DIM" ]; then
    jq -nc '{error:"INPUT_DIMENSION not set"}' >&2
    exit 1
fi

DIFF_DATA=$(cat)

REQUEST=$(printf '%s' "$DIFF_DATA" | INPUT_DIMENSION="$DIM" bash "$SCRIPT_DIR/build-prompt.sh")
RESPONSE=$(printf '%s' "$REQUEST" | bash "$SCRIPT_DIR/call-openrouter.sh")
PARSED=$(printf '%s' "$RESPONSE" | bash "$SCRIPT_DIR/parse-response.sh")

# Tag each finding with the dimension (default category) for aggregation.
printf '%s' "$PARSED" | jq -c --arg dim "$DIM" '{
    dimension: $dim,
    verdict: .verdict,
    reasoning: .reasoning,
    findings: [ .findings[] | . + {category: (.category // $dim)} ]
}'
