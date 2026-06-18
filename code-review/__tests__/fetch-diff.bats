#!/usr/bin/env bash
# fetch-diff.bats — tests for fetch-diff.sh

load helpers

# Helper: create a temp git repo with an initial commit.
setup_git_repo() {
    TMPDIR=$(mktemp -d)
    cd "$TMPDIR"
    git init --initial-branch=main --quiet
    git config user.email "test@test.com"
    git config user.name "Test"
    echo "initial" > README.md
    git add README.md
    git commit -m "initial commit" --quiet
}

teardown_git_repo() {
    cd /
    rm -rf "${TMPDIR:-/tmp/nonexistent}"
}

@test "fetch-diff: outputs JSON with expected fields" {
    setup_git_repo

    # Make a change so there's a diff.
    echo "changed" > newfile.ts
    git add newfile.ts

    export INPUT_MAX_FILES=100
    export INPUT_MAX_DIFF_LINES=8000
    export INPUT_BASE_BRANCH=main
    export GITHUB_BASE_REF=main

    run bash "$SRC_DIR/fetch-diff.sh"
    [ "$status" -eq 0 ]

    result=$(echo "$output" | jq -c '.')
    [ "$(echo "$result" | jq -r '.total_files')" -ge 0 ]
    echo "$result" | jq -e '.changed_files | type == "array"'
    echo "$result" | jq -e '.binary_files | type == "array"'
    echo "$result" | jq -e '.truncated | type == "boolean"'
    echo "$result" | jq -e '.diff | type == "string"'

    teardown_git_repo
}

@test "fetch-diff: emits base_sha (base-branch tip)" {
    setup_git_repo

    # Commit on a feature branch so HEAD is genuinely ahead of main (a real diff).
    git checkout -b feature --quiet
    echo "changed" > newfile.ts
    git add newfile.ts
    git commit -m "add newfile" --quiet

    export INPUT_MAX_FILES=100
    export INPUT_MAX_DIFF_LINES=8000
    export INPUT_BASE_BRANCH=main
    export GITHUB_BASE_REF=main

    run bash "$SRC_DIR/fetch-diff.sh"
    [ "$status" -eq 0 ]

    # base_sha is the base-branch tip (no origin in the fixture -> falls back to
    # the local `main` branch). Must be a 40-hex equal to that tip.
    base_sha=$(echo "$output" | jq -r '.base_sha')
    [[ "$base_sha" =~ ^[0-9a-f]{40}$ ]]
    [ "$base_sha" = "$(git rev-parse main)" ]

    teardown_git_repo
}

@test "fetch-diff: binary file detection" {
    setup_git_repo

    # Create a feature branch off main.
    git checkout -b feature --quiet

    echo "text content" > text.txt
    dd if=/dev/urandom of=binary.bin bs=32 count=1 2>/dev/null
    printf '\x00' >> binary.bin  # Ensure git detects it as binary
    git add text.txt binary.bin
    git commit -m "add text and binary" --quiet

    # Now HEAD (feature) has changes relative to main.
    export INPUT_MAX_FILES=100
    export INPUT_MAX_DIFF_LINES=8000
    export INPUT_BASE_BRANCH=main
    export GITHUB_BASE_REF=main

    run bash "$SRC_DIR/fetch-diff.sh"

    # binary_files should contain binary.bin (it's a new file in this diff)
    echo "$output" | jq -e '.binary_files | index("binary.bin") != null'

    # changed_files should contain text.txt
    echo "$output" | jq -e '.changed_files | index("text.txt") != null'

    teardown_git_repo
}

@test "fetch-diff: line-primes the diff and records changed_lines" {
    setup_git_repo
    git checkout -b feature --quiet
    printf 'line one\nline two\nline three\n' > app.ts
    git add app.ts
    git commit -m "add app.ts" --quiet

    export INPUT_MAX_FILES=100 INPUT_MAX_DIFF_LINES=8000 INPUT_BASE_BRANCH=main GITHUB_BASE_REF=main

    run bash "$SRC_DIR/fetch-diff.sh"
    [ "$status" -eq 0 ]

    # Diff body lines are prefixed with their new-file line number.
    echo "$output" | jq -r '.diff' | grep -qE '^L[0-9]+: \+line one'
    # files[] carries the anchorable line set.
    echo "$output" | jq -e '.files | type == "array"'
    echo "$output" | jq -e '[.files[] | select(.path == "app.ts")] | .[0].changed_lines | length >= 3'

    teardown_git_repo
}

@test "fetch-diff: lockfiles are dropped, not reviewed" {
    setup_git_repo
    git checkout -b feature --quiet
    echo "real code" > app.ts
    echo '{"lockfileVersion": 3}' > package-lock.json
    echo "deps = []" > bun.lock
    git add app.ts package-lock.json bun.lock
    git commit -m "add code + lockfiles" --quiet

    export INPUT_MAX_FILES=100 INPUT_MAX_DIFF_LINES=8000 INPUT_BASE_BRANCH=main GITHUB_BASE_REF=main

    run bash "$SRC_DIR/fetch-diff.sh"
    [ "$status" -eq 0 ]

    echo "$output" | jq -e '[.dropped_files[].path] | index("package-lock.json") != null'
    echo "$output" | jq -e '[.dropped_files[].path] | index("bun.lock") != null'
    echo "$output" | jq -e '.changed_files | index("app.ts") != null'
    echo "$output" | jq -e '.changed_files | index("package-lock.json") == null'
    # The lockfile content must not appear in the diff sent to the model.
    echo "$output" | jq -r '.diff' | grep -qv 'lockfileVersion' || true
    ! echo "$output" | jq -r '.diff' | grep -q 'lockfileVersion'

    teardown_git_repo
}

@test "fetch-diff: large diff truncates at a hunk boundary" {
    setup_git_repo
    git checkout -b feature --quiet
    for n in $(seq 1 40); do echo "line $n" >> big.ts; done
    echo "second file" > small.ts
    git add big.ts small.ts
    git commit -m "add big + small" --quiet

    export INPUT_MAX_FILES=100 INPUT_MAX_DIFF_LINES=8 INPUT_BASE_BRANCH=main GITHUB_BASE_REF=main

    run bash "$SRC_DIR/fetch-diff.sh"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.truncated == true'
    # No primed line is cut mid-content: every L-line still ends with real text.
    echo "$output" | jq -r '.diff' | grep -qE '^L[0-9]+: '

    teardown_git_repo
}

@test "fetch-diff: quote in base branch still yields valid JSON error" {
    setup_git_repo
    export INPUT_MAX_FILES=100 INPUT_MAX_DIFF_LINES=8000

    run bash -c "INPUT_BASE_BRANCH='ba\"d' GITHUB_BASE_REF='' bash '$SRC_DIR/fetch-diff.sh' 2>&1 1>/dev/null"
    [ "$status" -ne 0 ]
    # The final stderr line is the error object and must be valid JSON.
    echo "$output" | tail -1 | jq -e '.error'

    teardown_git_repo
}

@test "fetch-diff: recovers merge-base from a shallow clone" {
    # Origin: main = A-B-C-D, feature branches at B and adds feat.ts.
    ORIGIN=$(mktemp -d)
    (
        cd "$ORIGIN"
        git init --initial-branch=main --quiet
        git config user.email "test@test.com"; git config user.name "Test"
        echo a > f.txt; git add f.txt; git commit -m A --quiet
        echo b >> f.txt; git add f.txt; git commit -m B --quiet
        git checkout -b feature --quiet
        echo "export const x = 1" > feat.ts; git add feat.ts; git commit -m E --quiet
        git checkout main --quiet
        echo c >> f.txt; git add f.txt; git commit -m C --quiet
        echo d >> f.txt; git add f.txt; git commit -m D --quiet
    )

    # Shallow clone (depth 1) of feature with all remote-tracking refs — mirrors
    # actions/checkout's default fetch-depth: 1, so merge-base starts empty.
    TMPDIR=$(mktemp -d)
    git clone --depth=1 --no-single-branch --branch feature "file://$ORIGIN" "$TMPDIR" --quiet
    cd "$TMPDIR"
    git config user.email "test@test.com"; git config user.name "Test"

    [ "$(git rev-parse --is-shallow-repository)" = "true" ]
    [ -z "$(git merge-base HEAD origin/main 2>/dev/null || true)" ]  # empty before fix

    export INPUT_MAX_FILES=100 INPUT_MAX_DIFF_LINES=8000 INPUT_BASE_BRANCH=main GITHUB_BASE_REF=main

    run bash "$SRC_DIR/fetch-diff.sh"
    [ "$status" -eq 0 ]
    # Progress lines go to stderr; the JSON payload is the final stdout line.
    echo "$output" | tail -n1 | jq -e '.changed_files | index("feat.ts") != null'

    cd /
    rm -rf "$ORIGIN" "$TMPDIR"
}

@test "fetch-diff: REVIEW_HEAD diffs a non-checked-out ref, not the working HEAD" {
    # Mirrors an `@toolu review` via issue_comment: the runner checked out the
    # default branch (main) but a sibling script fetched the PR head into a
    # separate ref. The working-tree HEAD has NO changes vs main; REVIEW_HEAD
    # points at the fetched ref, which is where the real change lives.
    setup_git_repo  # HEAD = main, only README.md

    # Feature commit on a ref that is NOT checked out.
    git checkout -b feature --quiet
    echo "export const reviewed = true" > review-only.ts
    git add review-only.ts
    git commit -m "feature change" --quiet
    FEATURE_SHA=$(git rev-parse HEAD)

    # Return the working tree to main so HEAD has nothing to diff against main.
    git checkout main --quiet

    [ "$(git rev-parse --abbrev-ref HEAD)" = "main" ]
    # Sanity: HEAD vs main is empty, so a default (HEAD) run would see no files.
    [ -z "$(git diff --name-only main HEAD)" ]

    export INPUT_MAX_FILES=100 INPUT_MAX_DIFF_LINES=8000 INPUT_BASE_BRANCH=main GITHUB_BASE_REF=main
    export REVIEW_HEAD="$FEATURE_SHA"

    run bash "$SRC_DIR/fetch-diff.sh"
    [ "$status" -eq 0 ]

    # The diff reflects REVIEW_HEAD's change, not the working HEAD's (none).
    [ "$(echo "$output" | jq -r '.total_files')" -eq 1 ]
    echo "$output" | jq -e '.changed_files | index("review-only.ts") != null'
    echo "$output" | jq -r '.diff' | grep -qE '^L[0-9]+: \+export const reviewed = true'

    unset REVIEW_HEAD
    teardown_git_repo
}

@test "fetch-diff: empty repo has total_files=0" {
    setup_git_repo

    # No changes — just run against HEAD.
    export INPUT_MAX_FILES=100
    export INPUT_MAX_DIFF_LINES=8000
    export INPUT_BASE_BRANCH=main
    export GITHUB_BASE_REF=main

    run bash "$SRC_DIR/fetch-diff.sh"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.total_files')" -eq 0 ]

    teardown_git_repo
}

@test "fetch-diff: unlimited by default — many files are reviewed, not skipped" {
    setup_git_repo
    git checkout -b feature --quiet
    for i in $(seq 1 12); do echo "content $i" > "f$i.ts"; done
    git add -A
    git commit -m "twelve files" --quiet

    # No INPUT_MAX_FILES / INPUT_MAX_DIFF_LINES: both default to 0 = unlimited.
    export INPUT_BASE_BRANCH=main GITHUB_BASE_REF=main

    run bash "$SRC_DIR/fetch-diff.sh"
    [ "$status" -eq 0 ]
    # Reviewed, not skipped: real payload with no skip error.
    echo "$output" | jq -e '.error == null'
    [ "$(echo "$output" | jq -r '.total_files')" -eq 12 ]
    [ "$(echo "$output" | jq '.files | length')" -eq 12 ]
    echo "$output" | jq -e '.truncated == false'

    teardown_git_repo
}

@test "fetch-diff: a positive MAX_FILES skips via stdout (not stderr)" {
    # Regression: the skip-error must land on stdout so main.sh can detect it
    # and post a skip comment. Emitting it to stderr left stdout empty and
    # crashed downstream with "invalid JSON text passed to --argjson".
    setup_git_repo
    git checkout -b feature --quiet
    for i in $(seq 1 3); do echo "content $i" > "f$i.ts"; done
    git add -A
    git commit -m "three files" --quiet

    export INPUT_MAX_FILES=2 INPUT_BASE_BRANCH=main GITHUB_BASE_REF=main

    run bash "$SRC_DIR/fetch-diff.sh"
    [ "$status" -eq 0 ]
    # The skip error is on stdout (run captures stdout into $output).
    echo "$output" | jq -e '.error | test("exceeds file limit")'
    [ "$(echo "$output" | jq -r '.total_files')" -eq 3 ]
    [ "$(echo "$output" | jq -r '.max_files')" -eq 2 ]

    teardown_git_repo
}
