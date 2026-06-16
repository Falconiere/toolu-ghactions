#!/usr/bin/env bash
# validate-findings.sh — deterministic finding gate (no LLM).
#
# Drops findings that cannot be anchored to a changed line in the diff (the model
# hallucinated the location), drops findings below MIN_CONFIDENCE unless they are
# blocker/high severity, and strips a suggestion when it isn't safe to apply
# (confidence not high, or the line..end_line span isn't fully in the diff).
#
# stdin : { files: [{path, changed_lines:[int]}], findings: [ {...} ] }
# stdout: { findings: [ {...} ] }   (filtered)
# stderr: a one-line kept/dropped count (never silent).
set -euo pipefail

MIN_CONFIDENCE="${INPUT_MIN_CONFIDENCE:-high}"
INPUT=$(cat)

RESULT=$(echo "$INPUT" | jq -c --arg minconf "$MIN_CONFIDENCE" '
    def lines_for($files; $p): [ $files[] | select(.path == $p) | .changed_lines ] | add // [];
    (.files // []) as $files
    | { findings: [
        (.findings // [])[]
        | . as $f
        | (lines_for($files; $f.path)) as $cl
        # Anchored: the cited line must be a real changed line in the diff.
        | select(($f.line != null) and (($cl | index($f.line)) != null))
        # Confidence gate: keep if severity is blocker/high, else require the
        # finding confidence to meet MIN_CONFIDENCE (high floor keeps high only;
        # medium floor keeps high or medium). Unknown/low confidence is below medium.
        | ($f.confidence // "low") as $c
        | select(
            $f.severity == "blocker" or $f.severity == "high"
            or ($minconf == "high" and $c == "high")
            or ($minconf == "medium" and ($c == "high" or $c == "medium"))
          )
        # Keep a suggestion only when high-confidence AND the whole span is in the diff.
        | if ($f.confidence == "high"
              and ([range($f.line; (($f.end_line // $f.line) + 1))] - $cl | length) == 0)
          then $f else ($f | del(.suggestion)) end
      ] }
')

TOTAL=$(echo "$INPUT" | jq '(.findings // []) | length')
KEPT=$(echo "$RESULT" | jq '.findings | length')
echo "validate-findings: kept ${KEPT}/${TOTAL} findings ($((TOTAL - KEPT)) dropped: unanchored or below confidence)" >&2

echo "$RESULT"
