#!/usr/bin/env bash
# capture-fixtures.sh — record REAL OpenRouter responses for the test suite.
#
# The test suite uses recorded real responses (no fabricated model output). Run
# this once with a valid key to (re)generate them:
#
#     ! bash scripts/capture-fixtures.sh
#
# It also doubles as the live MiniMax-M3 structured-output check: each dimension
# is captured with response_format json_schema first; if that errors (the model/
# provider doesn't support it) it falls back to free-text and reports which mode
# worked — that tells you whether ENFORCE_JSON_SCHEMA should default true or false.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/code-review/src"
FIX="$ROOT/code-review/__tests__/fixtures"

if [ -z "${OPENROUTER_API_KEY:-}" ]; then
    echo "capture-fixtures: set OPENROUTER_API_KEY first (you are in fish: 'set -x OPENROUTER_API_KEY ...')." >&2
    exit 1
fi

# Real diff input (the existing recorded sample diff).
diff_data=$(jq -Rsc '{
    diff: .,
    changed_files: ["src/auth/login.ts", "src/utils/format.ts"],
    binary_files: [], dropped_files: [],
    total_lines: 30, total_files: 2, truncated: false
}' < "$FIX/sample-diff.txt")

schema_ok=0; freetext_used=0

capture_dim() {
    local dim="$1"
    local out="$FIX/sample-openrouter-response-$dim.json"
    echo "Capturing dimension: $dim" >&2
    if echo "$diff_data" | INPUT_DIMENSION="$dim" bash "$SRC/build-prompt.sh" \
         | bash "$SRC/call-openrouter.sh" > "$out" 2>/dev/null && jq -e . "$out" >/dev/null 2>&1; then
        echo "  ✓ json_schema mode -> $out" >&2
        schema_ok=1
    else
        echo "  ! json_schema mode failed — falling back to free-text" >&2
        echo "$diff_data" | INPUT_DIMENSION="$dim" INPUT_ENFORCE_JSON_SCHEMA=false bash "$SRC/build-prompt.sh" \
            | bash "$SRC/call-openrouter.sh" > "$out"
        freetext_used=1
    fi
}

for d in correctness security performance tests; do capture_dim "$d"; done

echo "Capturing free-text (ENFORCE_JSON_SCHEMA=false) response" >&2
echo "$diff_data" | INPUT_ENFORCE_JSON_SCHEMA=false bash "$SRC/build-prompt.sh" \
    | bash "$SRC/call-openrouter.sh" > "$FIX/sample-openrouter-response-freetext.txt"

echo "Capturing coordinator response" >&2
union='{"findings":[
  {"path":"src/auth/login.ts","line":42,"end_line":42,"severity":"high","category":"security","confidence":"high","quoted_line":"const q = \"SELECT * FROM users WHERE name=\" + name","suggestion":"const q = db.prepare(\"SELECT * FROM users WHERE name=?\")","text":"SQL injection via string concatenation."},
  {"path":"src/auth/login.ts","line":42,"end_line":42,"severity":"high","category":"correctness","confidence":"high","text":"Unparameterized query — same line."}
]}'
coord_sys=$(cat "$ROOT/code-review/prompts/coordinator.txt")
coord_req=$(jq -nc --arg model "${INPUT_MODEL:-minimax/minimax-m3}" --arg sys "$coord_sys" --arg user "$union" \
    '{model:$model, models:[$model,"anthropic/claude-sonnet-4-5"], messages:[{role:"system",content:$sys},{role:"user",content:$user}], temperature:0.1, max_tokens:4096}')
echo "$coord_req" | bash "$SRC/call-openrouter.sh" > "$FIX/sample-coordinator-response.json"

echo "" >&2
echo "Done. Fixtures written to $FIX" >&2
if [ "$freetext_used" = "1" ]; then
    echo "NOTE: at least one dimension needed free-text mode — consider ENFORCE_JSON_SCHEMA=false as the default." >&2
elif [ "$schema_ok" = "1" ]; then
    echo "NOTE: json_schema mode worked for all dimensions — ENFORCE_JSON_SCHEMA=true is safe." >&2
fi
