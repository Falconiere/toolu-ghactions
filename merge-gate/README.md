# merge-gate

A required check that stays red until a pull request is ready to auto-merge:

1. It carries the `merge-approved` label. The [`code-review`](../code-review/README.md) action sets that label when its verdict is approved, and swaps it for `request-changes` otherwise.
2. Every review thread has a reply from someone other than the account that opened it. The reviewer posts follow-ups inside its own threads, so a bot answering itself does not count. A resolved code-scanning thread (`github-advanced-security`) is exempt: resolving it is the finding being fixed or dismissed.

Green CI and resolved threads are left to branch protection itself (required status checks and required conversation resolution). This check covers only what GitHub cannot express natively.

## Usage

Two workflows share the one `merge-gate` check. Branch protection reads the newest `merge-gate` check on the head commit, whichever workflow produced it.

**1. After the review.** Add a job to the workflow that runs `code-review`, so each push is judged only once the reviewer has posted its threads and set its label:

```yaml
jobs:
  review:
    # ... runs falconiere/toolu-ghactions/code-review ...

  merge-gate:
    needs: review
    # !cancelled(), not always(): a red or skipped review still gets a verdict,
    # but a run superseded by a newer push does not.
    if: ${{ !cancelled() && !github.event.pull_request.draft }}
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      contents: read
      pull-requests: read
    steps:
      - uses: falconiere/toolu-ghactions/merge-gate@v8
```

**2. Between pushes.** A reply on a thread, or a label changed by hand, can turn the check green without a new commit. `.github/workflows/merge-gate.yml`:

```yaml
name: Merge Gate
on:
  pull_request:
    types: [labeled, unlabeled]
  pull_request_review:
    types: [submitted, edited, dismissed]
  pull_request_review_comment:
    types: [created, edited, deleted]

permissions:
  contents: read
  pull-requests: read

concurrency:
  group: merge-gate-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  merge-gate:
    if: ${{ github.event.pull_request.base.ref == 'main' && !github.event.pull_request.draft }}
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: falconiere/toolu-ghactions/merge-gate@v8
```

Resolving a thread is not a workflow trigger, which is why resolution belongs to branch protection and not to this check: a verdict taken before the resolve could never refresh.

**3. Branch protection** on `main`:

- Required status checks: `merge-gate`, next to your CI checks and `review`.
- Require conversation resolution before merging.
- Allow auto-merge in the repository settings, then arm a PR with `gh pr merge <n> --auto --squash`.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `github-token` | no | `${{ github.token }}` | Reads the pull request's labels and review threads. Needs `pull-requests: read`. |

The action takes the pull request from the triggering event, so it runs only on `pull_request`, `pull_request_review`, and `pull_request_review_comment` events.

## Output

On success the check passes and the step summary reads `PR #<n> is ready to auto-merge`. Otherwise it fails with one error annotation per problem: the missing label, and each unanswered thread as `<path>: <link to its first comment>`. The same list goes to the step summary.

## Limits

Only a thread's first 100 comments are read. Past that cap a reply can only be missed, never invented, so the check errs toward blocking.

## Development

```bash
bats merge-gate/__tests__/*.bats
shellcheck --severity=warning merge-gate/src/*.sh
npx @action-validator/cli merge-gate/action.yml
```

The suite replays real GitHub API responses recorded from `Falconiere/comemory` pull requests (`__tests__/fixtures/`) through a `gh` stub on `PATH`. Only the network call is replayed; the verdict comes from the script's own `jq` over the recorded payloads.
