#!/usr/bin/env bash
# shape-diff.sh — line-prime a unified diff and extract per-file changed_lines.
#
# Prefixes each body line with its NEW-file absolute line number (`Lnnn: `) so
# the model cites real, anchorable line numbers; removed lines get `L---:`.
# Emits, per file, the set of new-file line numbers present in the diff
# (context + additions) — the lines an inline comment can anchor to.
#
# stdin : a unified diff (text files only, from `git diff <base> HEAD -- ...`)
# stdout: JSON { diff: "<primed diff text>", files: [ {path, changed_lines:[int]} ] }
set -euo pipefail

PRIMED=$(mktemp)
PAIRS=$(mktemp)
trap 'rm -f "$PRIMED" "$PAIRS"' EXIT

awk -v pf="$PRIMED" -v cf="$PAIRS" '
  /^diff --git / { print > pf; next }
  /^\+\+\+ / {
    path = $0
    sub(/^\+\+\+ b\//, "", path)
    sub(/^\+\+\+ /,    "", path)
    print > pf; next
  }
  /^--- / { print > pf; next }
  /^@@ / {
    # New-file start is the number after the "+" in "@@ -a,b +c,d @@".
    if (match($0, /\+[0-9]+/)) { newln = substr($0, RSTART + 1, RLENGTH - 1) + 0 }
    print > pf; next
  }
  /^\+/ { printf "L%d: %s\n", newln, $0 > pf; printf "%s\t%d\n", path, newln > cf; newln++; next }
  /^-/  { printf "L---: %s\n", $0 > pf; next }
  /^ /  { printf "L%d: %s\n", newln, $0 > pf; printf "%s\t%d\n", path, newln > cf; newln++; next }
  { print > pf }   # index/mode/rename headers, "\ No newline", blank lines
'

DIFF_JSON=$(jq -Rs . < "$PRIMED")

if [ -s "$PAIRS" ]; then
    FILES_JSON=$(jq -Rn '
        [inputs | split("\t") | {path: .[0], line: (.[1] | tonumber)}]
        | group_by(.path)
        | map({path: .[0].path, changed_lines: (map(.line) | unique)})
    ' < "$PAIRS")
else
    FILES_JSON="[]"
fi

jq -nc --argjson diff "$DIFF_JSON" --argjson files "$FILES_JSON" '{diff: $diff, files: $files}'
