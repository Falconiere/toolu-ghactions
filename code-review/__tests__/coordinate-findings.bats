#!/usr/bin/env bash
# coordinate-findings.bats — tests for the multi-provider merger.

load helpers

@test "coordinate-findings: conservative — any changes wins" {
    input='{"strategy":"conservative","providers":[
        {"provider":"openrouter","verdict":"approved","findings":[]},
        {"provider":"anthropic","verdict":"changes","findings":[{"path":"a.ts","line":1,"severity":"low","text":"x"}]}
    ]}'
    run bash "$SRC_DIR/coordinate-findings.sh" <<< "$input"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.verdict == "changes"'
    echo "$output" | jq -e '.findings | length == 1'
    echo "$output" | jq -e '.review_plan | contains("conservative")'
    echo "$output" | jq -e '.other_checks | contains("openrouter=approved") and contains("anthropic=changes")'
}

@test "coordinate-findings: conservative — errored provider abstains (does not force changes)" {
    input='{"strategy":"conservative","providers":[
        {"provider":"openrouter","verdict":"approved","findings":[]},
        {"provider":"deepseek","error":"rate limited","verdict":null,"findings":[]}
    ]}'
    run bash "$SRC_DIR/coordinate-findings.sh" <<< "$input"
    [ "$status" -eq 0 ]
    # The errored provider abstains; the one real verdict (approved) stands.
    echo "$output" | jq -e '.verdict == "approved"'
    echo "$output" | jq -e '.other_checks | contains("deepseek=error")'
    echo "$output" | jq -e '.review_plan | contains("abstained")'
}

@test "coordinate-findings: conservative — all approved yields approved" {
    input='{"strategy":"conservative","providers":[
        {"provider":"openrouter","verdict":"approved","findings":[]},
        {"provider":"anthropic","verdict":"approved","findings":[]}
    ]}'
    run bash "$SRC_DIR/coordinate-findings.sh" <<< "$input"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.verdict == "approved"'
}

@test "coordinate-findings: majority — 2/3 changes wins" {
    input='{"strategy":"majority","providers":[
        {"provider":"a","verdict":"changes","findings":[]},
        {"provider":"b","verdict":"changes","findings":[]},
        {"provider":"c","verdict":"approved","findings":[]}
    ]}'
    run bash "$SRC_DIR/coordinate-findings.sh" <<< "$input"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.verdict == "changes"'
}

@test "coordinate-findings: majority — 1/2 changes is not enough (threshold = 2)" {
    input='{"strategy":"majority","providers":[
        {"provider":"a","verdict":"changes","findings":[]},
        {"provider":"b","verdict":"approved","findings":[]}
    ]}'
    run bash "$SRC_DIR/coordinate-findings.sh" <<< "$input"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.verdict == "approved"'
}

@test "coordinate-findings: majority — errored provider abstains" {
    input='{"strategy":"majority","providers":[
        {"provider":"a","verdict":"changes","findings":[]},
        {"provider":"b","error":"timeout","verdict":null,"findings":[]},
        {"provider":"c","verdict":"approved","findings":[]}
    ]}'
    run bash "$SRC_DIR/coordinate-findings.sh" <<< "$input"
    [ "$status" -eq 0 ]
    # 1 changes vs 1 approved (error abstains). Not enough changes for majority (need 2 of 3).
    echo "$output" | jq -e '.verdict == "approved"'
}

@test "coordinate-findings: all_approve — one changes forces changes" {
    input='{"strategy":"all_approve","providers":[
        {"provider":"a","verdict":"approved","findings":[]},
        {"provider":"b","verdict":"changes","findings":[]}
    ]}'
    run bash "$SRC_DIR/coordinate-findings.sh" <<< "$input"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.verdict == "changes"'
}

@test "coordinate-findings: all_approve — errored provider abstains" {
    input='{"strategy":"all_approve","providers":[
        {"provider":"a","verdict":"approved","findings":[]},
        {"provider":"b","error":"auth fail","verdict":null,"findings":[]}
    ]}'
    run bash "$SRC_DIR/coordinate-findings.sh" <<< "$input"
    [ "$status" -eq 0 ]
    # b abstains; all DECIDED providers (just a) approved -> approved.
    echo "$output" | jq -e '.verdict == "approved"'
}

@test "coordinate-findings: all_approve — all approved yields approved" {
    input='{"strategy":"all_approve","providers":[
        {"provider":"a","verdict":"approved","findings":[]},
        {"provider":"b","verdict":"approved","findings":[]},
        {"provider":"c","verdict":"approved","findings":[]}
    ]}'
    run bash "$SRC_DIR/coordinate-findings.sh" <<< "$input"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.verdict == "approved"'
}

@test "coordinate-findings: all providers errored yields an honest error verdict" {
    input='{"strategy":"conservative","providers":[
        {"provider":"a","error":"x","verdict":null,"findings":[]},
        {"provider":"b","error":"y","verdict":null,"findings":[]}
    ]}'
    run bash "$SRC_DIR/coordinate-findings.sh" <<< "$input"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.verdict == "error"'
    echo "$output" | jq -e '.other_checks | contains("a=error") and contains("b=error")'
    echo "$output" | jq -e '.review_plan | test("could not complete"; "i")'
}

@test "coordinate-findings: sole provider errors -> error verdict, not bogus changes" {
    # Regression: a single openrouter provider erroring used to merge to
    # "changes" with zero findings, producing a misleading "Changes requested".
    input='{"strategy":"conservative","providers":[
        {"provider":"openrouter","error":"500 from provider","verdict":null,"findings":[]}
    ]}'
    run bash "$SRC_DIR/coordinate-findings.sh" <<< "$input"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.verdict == "error"'
    echo "$output" | jq -e '.findings | length == 0'
}

@test "coordinate-findings: dedupes findings on (path, line, end_line, text-fingerprint)" {
    input='{"strategy":"conservative","providers":[
        {"provider":"a","verdict":"changes","findings":[{"path":"x.ts","line":10,"end_line":10,"severity":"medium","text":"same finding"}]},
        {"provider":"b","verdict":"changes","findings":[{"path":"x.ts","line":10,"end_line":10,"severity":"high","text":"same finding"}]}
    ]}'
    run bash "$SRC_DIR/coordinate-findings.sh" <<< "$input"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.findings | length == 1'
    echo "$output" | jq -e '.findings[0].severity == "high"'
}

@test "coordinate-findings: different end_line means no dedupe" {
    input='{"strategy":"conservative","providers":[
        {"provider":"a","verdict":"changes","findings":[{"path":"x.ts","line":10,"end_line":10,"severity":"low","text":"single line"}]},
        {"provider":"b","verdict":"changes","findings":[{"path":"x.ts","line":10,"end_line":20,"severity":"low","text":"multi line span"}]}
    ]}'
    run bash "$SRC_DIR/coordinate-findings.sh" <<< "$input"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.findings | length == 2'
}

@test "coordinate-findings: text fingerprint collapses whitespace + case + punctuation differences" {
    input='{"strategy":"conservative","providers":[
        {"provider":"a","verdict":"changes","findings":[{"path":"x.ts","line":10,"end_line":10,"severity":"low","text":"Hello, World!"}]},
        {"provider":"b","verdict":"changes","findings":[{"path":"x.ts","line":10,"end_line":10,"severity":"low","text":"hello world"}]}
    ]}'
    run bash "$SRC_DIR/coordinate-findings.sh" <<< "$input"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.findings | length == 1'
}

@test "coordinate-findings: no cross-path dedupe" {
    input='{"strategy":"conservative","providers":[
        {"provider":"a","verdict":"changes","findings":[{"path":"a.ts","line":10,"severity":"low","text":"same text"}]},
        {"provider":"b","verdict":"changes","findings":[{"path":"b.ts","line":10,"severity":"low","text":"same text"}]}
    ]}'
    run bash "$SRC_DIR/coordinate-findings.sh" <<< "$input"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.findings | length == 2'
}

@test "coordinate-findings: category preserved from first provider; not in dedupe key" {
    input='{"strategy":"conservative","providers":[
        {"provider":"a","verdict":"changes","findings":[{"path":"x.ts","line":10,"end_line":10,"severity":"low","category":"security","text":"same"}]},
        {"provider":"b","verdict":"changes","findings":[{"path":"x.ts","line":10,"end_line":10,"severity":"low","category":"injection","text":"same"}]}
    ]}'
    run bash "$SRC_DIR/coordinate-findings.sh" <<< "$input"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.findings | length == 1'
    echo "$output" | jq -e '.findings[0].category == "security"'
}

@test "coordinate-findings: top_must_fix deduped by path, max severity, capped at 3" {
    input='{"strategy":"conservative","providers":[
        {"provider":"a","verdict":"changes","findings":[],
         "top_must_fix":["src/a.ts:1", "src/b.ts:2", "src/c.ts:3", "src/d.ts:4"]},
        {"provider":"b","verdict":"changes","findings":[],
         "top_must_fix":["src/a.ts:1", "src/b.ts:2"]}
    ]}'
    run bash "$SRC_DIR/coordinate-findings.sh" <<< "$input"
    [ "$status" -eq 0 ]
    # After unique + cap: at most 3 items.
    N=$(echo "$output" | jq '.top_must_fix | length')
    [ "$N" -le 3 ]
    [ "$N" -ge 1 ]
}

@test "coordinate-findings: empty providers list yields error verdict" {
    input='{"strategy":"conservative","providers":[]}'
    run bash "$SRC_DIR/coordinate-findings.sh" <<< "$input"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.verdict == "error"'
    echo "$output" | jq -e '.findings | length == 0'
}

@test "coordinate-findings: unknown strategy fails loud" {
    input='{"strategy":"banana","providers":[{"provider":"a","verdict":"approved","findings":[],"other_checks":"","top_must_fix":[]}]}'
    run bash "$SRC_DIR/coordinate-findings.sh" <<< "$input"
    [ "$status" -ne 0 ]
}
