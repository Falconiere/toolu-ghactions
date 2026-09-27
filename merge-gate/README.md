# merge-gate

A required check that stays red until a pull request is ready to auto-merge:

1. It carries the `merge-approved` label. The [`code-review`](../code-review/README.md) action sets that label when its verdict is approved, and swaps it for `request-changes` otherwise. When the label is missing, the check recomputes the last review from its stored findings instead: if every blocking finding is now settled on its thread, the requirement is met without a push or a new review. See [Settled findings](#settled-findings).
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

Resolving a thread is not a workflow trigger, which is why resolution belongs to branch protection and not to this check: a verdict taken before the resolve could never refresh. A resolved finding still counts as settled the next time the check runs, and the reply you post on the thread is itself a trigger.

**3. Branch protection** on `main`:

- Required status checks: `merge-gate`, next to your CI checks and `review`.
- Require conversation resolution before merging.
- Allow auto-merge in the repository settings, then arm a PR with `gh pr merge <n> --auto --squash`.

## Settled findings

`merge-approved` only changes inside a code-review run, and a review workflow on `pull_request` runs only on a push. So when an author settles the last finding by replying on its thread, the label would keep saying `request-changes` until the next push. A manual re-run re-rolls the model's findings on the same commit.

When the label is missing, this action first runs a small read-only recompute (a nested node24 step built from code-review's own recompute, with no model call):

1. It reads the last completed review round from the code-review sticky comment's memory marker. The sticky must be posted by a bot and must not be a review in progress.
2. It drops the findings settled on the bot's own threads: resolved, answered with `@toolu dismiss`, or argued out. These are the same rules and the same permission gate the review applies.
3. If nothing blocking remains under `approve-below`, the label requirement is met. The success line then reads `every blocking finding of the last review is settled (<n> of <m> settled, no model call)`, and adds `the rest below approve-below` when advisory findings remain.

It **fails closed**: the missing-label error stays, followed by `(settled-findings recompute: <reason>)`, when:

| Reason | Meaning |
|---|---|
| `stale-head` | the PR has a newer push than the last review |
| `incomplete` / `no-completed-round` | the last review left files unreviewed or pending, or never completed |
| `not-changes` | the last review did not ask for changes (for example, it errored) |
| `still-blocking` / `nothing-settled` | a blocking finding is still open |
| `no-sticky` / `not-bot-sticky` / `in-progress` | there is no trusted, finished review comment to read |
| `no-head` / `comments-unreadable` / `bad-input` / `error` | GitHub could not be read |

The action stays read-only. It never writes the label: the code-review [settle workflow](../code-review/README.md#settling-findings-without-a-re-review) does that, if you run it. Mirror your review's `APPROVE_BELOW`, `TRIGGER_PHRASE` and `MIN_TRIGGER_PERMISSION` into the inputs below, or the gate and the review will disagree on what "settled" means. Set `settle-recompute: 'false'` to require the label itself.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `github-token` | no | `${{ github.token }}` | Reads the pull request's labels, comments, review threads, head and commenter permissions. Needs `pull-requests: read`. |
| `settle-recompute` | no | `'true'` | Recompute the last review from its stored findings when `merge-approved` is missing ([Settled findings](#settled-findings)). `'false'` requires the label itself. |
| `approve-below` | no | `nit` | Mirror of code-review [`APPROVE_BELOW`](../code-review/README.md#advisory-findings-below-a-severity-threshold). |
| `trigger-phrase` | no | `@toolu` | Mirror of code-review `TRIGGER_PHRASE` (the `<phrase> dismiss` command). |
| `min-trigger-permission` | no | `write` | Mirror of code-review `MIN_TRIGGER_PERMISSION`: the repo permission a dismissing commenter needs. |

The action takes the pull request from the triggering event, so it runs only on `pull_request`, `pull_request_review`, and `pull_request_review_comment` events.

## Output

On success the check passes and the step summary reads `PR #<n> is ready to auto-merge`, saying whether the label or the settled-findings recompute met the label requirement. Otherwise it fails with one error annotation per problem: the missing label (with the recompute's reason when it ran), and each unanswered thread as `<path>: <link to its first comment>`. The same list goes to the step summary.

## Limits

Only a thread's first 100 comments are read. Past that cap a reply can only be missed, never invented, so the check errs toward blocking.

The recompute's `$/merge-gate/recompute` step needs Actions runner 2.336.0 or later (the same requirement as code-review's nested steps). If the step fails, its outputs are empty and the check falls back to requiring the label.

## Development

```bash
bats merge-gate/__tests__/*.bats
shellcheck --severity=warning merge-gate/src/*.sh
npx @action-validator/cli merge-gate/action.yml
```

The suite replays real GitHub API responses recorded from `Falconiere/comemory` pull requests (`__tests__/fixtures/`) through a `gh` stub on `PATH`. Only the network call is replayed; the verdict comes from the script's own `jq` over the recorded payloads. The recompute outputs arrive as `SETTLE_*` env, exactly as `action.yml` maps them.

`recompute/index.cjs` is generated from code-review's sources (`code-review/src/gate/`). Never edit it by hand. Rebuild with `cd code-review && bun run build`; its tests run with code-review's suite (`bun run test`).
