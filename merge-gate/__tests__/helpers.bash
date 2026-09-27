#!/usr/bin/env bash
# helpers.bash — bats setup for merge-gate tests.
#
# Strategy: stub `gh` on PATH (the network boundary) and replay REAL API
# responses recorded from Falconiere/comemory pull requests into fixtures/:
#   labels-comemory-<pr>.json   gh api repos/Falconiere/comemory/issues/<pr>/labels?per_page=100
#   threads-comemory-<pr>.json  gh api graphql --paginate --slurp (the query in src/merge-gate.sh)
#   labels-404.{stdout,stderr}  the same labels call against a PR that does not exist
# comemory#307 (issue #123's motivating PR: `request-changes`, all 64 threads answered)
# was recorded 2026-09-27 with the same two calls.
# The script under test runs exactly as CI runs it; only `gh` is replayed.
common_setup() {
    BATS_TEST_TMPDIR="${BATS_TEST_TMPDIR:-$(mktemp -d)}"
    export BATS_TEST_TMPDIR
    ORIG_PATH="$PATH"
    STUB_BIN="$BATS_TEST_TMPDIR/bin"
    mkdir -p "$STUB_BIN"
    export PATH="$STUB_BIN:$PATH"

    export FIXTURES_DIR="${BATS_TEST_DIRNAME}/fixtures"
    export SCRIPT
    SCRIPT="$(cd "${BATS_TEST_DIRNAME}/../src" && pwd)/merge-gate.sh"
    export GH_LOG="$BATS_TEST_TMPDIR/gh.log"
    export GITHUB_STEP_SUMMARY="$BATS_TEST_TMPDIR/summary.md"
    : > "$GITHUB_STEP_SUMMARY"
    export GH_TOKEN="unused-by-the-stub"
    export REPO="Falconiere/comemory"
}

common_teardown() {
    [ -n "${ORIG_PATH:-}" ] && export PATH="$ORIG_PATH"
}

# Replay recorded pull request <pr>: its labels and its review threads.
stub_gh_pr() {
    local pr="$1"
    cat > "$STUB_BIN/gh" <<STUB
#!/usr/bin/env bash
echo "\$*" >> "$GH_LOG"
case "\$2" in
  graphql) cat "$FIXTURES_DIR/threads-comemory-$pr.json" ;;
  */labels*) cat "$FIXTURES_DIR/labels-comemory-$pr.json" ;;
  *) echo "gh stub: unexpected call: \$*" >&2; exit 99 ;;
esac
STUB
    chmod +x "$STUB_BIN/gh"
}

# Replay the recorded 404 for the labels call (gh exits 1).
stub_gh_labels_404() {
    cat > "$STUB_BIN/gh" <<STUB
#!/usr/bin/env bash
echo "\$*" >> "$GH_LOG"
cat "$FIXTURES_DIR/labels-404.stdout"
cat "$FIXTURES_DIR/labels-404.stderr" >&2
exit 1
STUB
    chmod +x "$STUB_BIN/gh"
}

# URL of the opening comment of thread <index> in recorded PR <pr>.
first_comment_url() {
    jq -r ".[0].data.repository.pullRequest.reviewThreads.nodes[$2].comments.nodes[0].url" \
        "$FIXTURES_DIR/threads-comemory-$1.json"
}
