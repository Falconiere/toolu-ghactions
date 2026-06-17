# Marketplace Mirror Pipeline — Design

**Date:** 2026-06-16   **Status:** Approved   **Author:** Falconiere   **Topic:** Auto-mirror each monorepo action to a standalone repo so it can be listed on the GitHub Marketplace.

## Problem

`toolu-ghactions` is a monorepo: `code-review/` (a Docker action) and `cloudflare-tunnel/` (three composite sub-actions). The GitHub Marketplace lists **one action per repository, and its `action.yml` must be at the repo root** — subdirectory actions can never be listed (researched; see comemory `marketplace-monorepo-constraint`). So neither action is discoverable on the Marketplace today, even though both are usable via `owner/repo/subdir@ref`. We want Marketplace discoverability without giving up monorepo development.

## Non-Goals

1. **Fixing the `code-review` `@v2` image-tag bug.** `code-review/action.yml` at the `v2` tag pins `image: …/code-review:v1` while `release.yml` publishes the `:v2` image and never rewrites the `action.yml` `image:` line. This is a separate, tracked bug. The mirror build sidesteps it by *setting* the image tag from the release version; the monorepo's own `@v2` fix is out of scope here.
2. **Programmatic Marketplace publishing.** GitHub has no API to publish/list an action. The one-time "Publish to Marketplace" step is manual (per mirror).
3. **Rebuilding images in the mirror.** Mirrors reuse the monorepo's prebuilt GHCR image; no second build pipeline.
4. **Changing the canonical usage docs.** Monorepo paths (`falconiere/toolu-ghactions/code-review@v2`, `…/cloudflare-tunnel/start@v2`) remain the documented, recommended usage. Mirrors are the storefront; their READMEs point back to the monorepo.
5. **Mirroring history.** Mirrors are published artifacts, not development repos. A flat synced snapshot per release (with a `source-sha` trailer) is sufficient; full git history is not preserved.

## Architecture

**Chosen mechanism: build-and-sync, not `git subtree split` or a third-party split action.** The trade-off that drove this: cloudflare-tunnel needs a **path transform** (hoist `start/action.yml` to root and rewrite its script path), which subtree-split cannot do. Build-and-sync — check out the mirror, lay down a freshly-computed file tree, commit/tag/push — handles both the trivial (code-review) and the awkward (cloudflare-tunnel) case with one uniform, dependency-free mechanism we fully control.

A new **`mirror` job** is added to `.github/workflows/release.yml`, `needs: [version, publish-image]`, so it never tags a mirror before the GHCR image it references exists:

```yaml
if: ${{ !cancelled() && needs.version.result == 'success' && needs.publish-image.result == 'success' }}
```

(cloudflare-tunnel does not use the image, but waiting on `publish-image` is harmless and keeps one uniform gate.) It runs after `version` resolves `tag` (e.g. `v2.1.0`) and `major` (e.g. `2`) and after the image is pushed. A matrix runs one leg per action. Each leg calls a shared script `scripts/mirror-action.sh`, which encapsulates the per-action layout transform, commit, tag, and force-move of the floating major alias on the mirror.

**Reused / referenced existing code:**
- `.github/workflows/release.yml` — the `version` job (`tag`, `major` outputs) and the `!cancelled() && needs.version.result == 'success'` gate pattern.
- `move-major-alias` job (lines 134–165) — the `git tag -f vN <tag>; git push --force` alias pattern is replicated against the mirror remote.
- `scripts/` — new helper lives alongside `parse-verdict.sh`, `capture-fixtures.sh`; mirrors the repo's "shared shell helpers" convention.
- `code-review/` and `cloudflare-tunnel/` trees are the sync source.

**GHCR image:** the mirror's `code-review/action.yml` references the **monorepo's** image namespace, unchanged: `docker://ghcr.io/<owner>/toolu-ghactions/code-review:v<major>`. The image is built once by the monorepo `publish-image` job. The GHCR package must be **public** for a cross-repo Marketplace action to pull it (open question O1).

### Per-action mirror layout

**`toolu-code-review`** (Docker action — trivial): mirror root = contents of `code-review/`:
```
/action.yml      # image: rewritten to docker://…/toolu-ghactions/code-review:v<major>
/Dockerfile      # copied for transparency; not used at runtime (image is prebuilt)
/src/  /prompts/  /__tests__/
/README.md       # ../LICENSE → ./LICENSE, ../README.md → monorepo URL
/LICENSE         # copied from repo root
```

**`toolu-cloudflare-tunnel`** (composite, 3 sub-actions — path transform): mirror keeps the sub-action subdirs *and* adds a hoisted root `action.yml`:
```
/action.yml          # = copy of start/action.yml, with $GITHUB_ACTION_PATH/../src → $GITHUB_ACTION_PATH/src
/start/action.yml    # unchanged ($GITHUB_ACTION_PATH/../src resolves to /src — one level down)
/stop/action.yml     # unchanged (../src ✓)
/wait/action.yml     # unchanged (../src ✓)
/src/                # install-cloudflared.sh, lib.sh, start.sh, stop.sh, wait.sh
/__tests__/
/README.md           # ../LICENSE → ./LICENSE, ../README.md → monorepo URL
/LICENSE
```
Marketplace lists the root action (`start`). `stop`/`wait` remain usable as `…/toolu-cloudflare-tunnel/stop@vN`. The root and `start/` both describe `start`; the root copy is **generated** by the sync (never hand-edited) so it cannot drift.

### Stale root `action.yml`

The monorepo root `action.yml` is a drifted v1 duplicate of `code-review/action.yml`, unreferenced by any doc. **Delete it.** Marketplace metadata now comes from the mirrors. (This removes the undocumented `falconiere/toolu-ghactions@v2` root usage — confirmed unused.)

## Interfaces / Schema

### `scripts/mirror-action.sh`

```
Usage: mirror-action.sh <work_dir>

Environment (required):
  ACTION        code-review | cloudflare-tunnel
  TAG           release tag, e.g. v2.1.0
  MAJOR         major number, e.g. 2
  MIRROR_REPO   owner/repo, e.g. Falconiere/toolu-code-review
  MIRROR_TOKEN  repo-scope PAT for the mirror remote (push)
  SOURCE_REPO   owner/repo of the monorepo (for README backlinks)
  SOURCE_SHA    monorepo commit SHA being mirrored (commit trailer)
  IMAGE_BASE    ghcr.io/<owner>/toolu-ghactions/code-review (code-review only)

Behaviour:
  1. Clone MIRROR_REPO (token auth) into <work_dir>. The repo MUST already
     exist (human prereq); a clone failure (404 / no access) is fatal — the
     script does NOT auto-create, to avoid a wrong-visibility repo. An
     existing-but-empty repo is fine (commit on top of the unborn branch).
  2. On a fresh checkout of the mirror's default branch, wipe tracked files and
     lay down the per-action layout (above), applying:
       - code-review: rewrite action.yml `image:` → docker://${IMAGE_BASE}:v${MAJOR}
       - cloudflare-tunnel: generate root action.yml from start/action.yml with
         sed 's#$GITHUB_ACTION_PATH/../src#$GITHUB_ACTION_PATH/src#'
       - both: copy repo-root LICENSE to mirror root; rewrite EVERY `](../…)`
         README link — ](../LICENSE) → ](./LICENSE),
         ](../README.md) → ](https://github.com/${SOURCE_REPO})
  3. Commit on top of the existing mirror main (fast-forward, no force):
     "chore: sync ${ACTION} ${TAG}\n\nsource-sha: ${SOURCE_SHA}".
     No-op safe: if the tree is unchanged, skip the commit.
  4. Tags: release tags are IMMUTABLE — if ${TAG} already exists on the mirror,
     leave it (do not move); else create it at the new commit. Force-move ONLY
     the floating v${MAJOR} alias. Push: main (fast-forward), ${TAG} (only if
     newly created), v${MAJOR} (--force).

Exit non-zero on any clone/transform/push failure (set -euo pipefail).
```

### `release.yml` — new `mirror` job

```yaml
mirror:
  name: Mirror ${{ matrix.action }} to publish repo
  needs: [version, publish-image]
  if: ${{ !cancelled() && needs.version.result == 'success' && needs.publish-image.result == 'success' }}
  runs-on: ubuntu-latest
  strategy:
    fail-fast: false
    matrix:
      include:
        - action: code-review
          mirror_repo: Falconiere/toolu-code-review
        - action: cloudflare-tunnel
          mirror_repo: Falconiere/toolu-cloudflare-tunnel
  steps:
    - uses: actions/checkout@v4
      with: { fetch-depth: 0 }
    - run: scripts/mirror-action.sh "$RUNNER_TEMP/mirror"
      env:
        ACTION: ${{ matrix.action }}
        TAG: ${{ needs.version.outputs.tag }}
        MAJOR: ${{ needs.version.outputs.major }}
        MIRROR_REPO: ${{ matrix.mirror_repo }}
        MIRROR_TOKEN: ${{ secrets.MIRROR_TOKEN }}
        SOURCE_REPO: ${{ github.repository }}
        SOURCE_SHA: ${{ github.sha }}
        IMAGE_BASE: ghcr.io/${{ github.repository_owner }}/toolu-ghactions/code-review
```

`needs: [version, publish-image]` guarantees the `:v<major>` image exists before any mirror tag references it.

### Secrets / prerequisites (human)

- Push token — **reuse the existing `RELEASE_PLEASE_TOKEN`** (repo-owner classic PAT, `repo`/`public_repo` scope, per `release-pipeline`) — its scope already covers pushing to the owner's public mirror repos, so no new secret is needed. The script reads it via its generic `MIRROR_TOKEN` env input. Mirrors carry **no** `.github/workflows/`, so `workflow` scope is not required.
- Two empty public repos created once: `Falconiere/toolu-code-review`, `Falconiere/toolu-cloudflare-tunnel`.
- One-time per mirror: accept the Marketplace Developer Agreement, draft a release with "Publish this Action to the GitHub Marketplace" checked (2FA).

## Acceptance criteria

1. **code-review mirror contents** — after a release `vX.Y.Z`, `toolu-code-review` has at its root: `action.yml` (with `image: docker://ghcr.io/<owner>/toolu-ghactions/code-review:vX`), `Dockerfile`, `src/`, `prompts/`, `README.md`, `LICENSE`. (Test: run `mirror-action.sh code-review` against a real temp git remote with a real `code-review/` tree; assert tree + the rewritten `image:` line.)
2. **cloudflare-tunnel mirror resolves scripts** — `toolu-cloudflare-tunnel` root `action.yml` runs `bash "$GITHUB_ACTION_PATH/src/start.sh"` (rewritten), and `start/`, `stop/`, `wait/`, `src/` are present so `start/action.yml`'s `$GITHUB_ACTION_PATH/../src/start.sh` still resolves. (Test: assert the root `action.yml` `run:` line was rewritten and that `src/start.sh` exists at the path each `action.yml` would resolve to.)
3. **Tag + alias propagation** — both mirrors receive a tag matching the release `tag` and a force-moved `v<major>` alias pointing at it. (Test: after a sync, `git tag` on the mirror lists `vX.Y.Z` and `vX`, both at the sync commit.)
4. **README links rewritten** — no mirror README contains `../LICENSE` or `../README.md`; `../LICENSE` → `./LICENSE`, `../README.md` → the monorepo URL. (Test: grep the synced READMEs.)
5. **Idempotent re-run** — running the sync twice for the same tag does not error and leaves the mirror in the same state. (Test: run twice, assert clean exit and identical tree.)
6. **Root `action.yml` removed** — the monorepo no longer has a root `action.yml`; no doc/workflow references `falconiere/toolu-ghactions@` (bare). (Test: file absent; grep is clean.)
7. **Docs in sync** — the root `README.md` gains a short "Marketplace" note explaining that mirrors exist for discoverability and that monorepo paths remain canonical; each mirror README explains it is generated from the monorepo. (Test: prose present; links valid.)
8. **Tests are real-data** — `scripts/__tests__/mirror-action.bats` exercises the script against real local git repos (bare remote in a tempdir), no network, no mocks.
9. **Generated composite root is valid + listable** — the cloudflare-tunnel mirror's generated root `action.yml` passes `npx @action-validator/cli` and retains a `name` and `branding` (inherited from `start/action.yml`: `Toolu Cloudflare Tunnel — Start`, icon `cloud`, color `orange`). (Test: validator exit 0; assert `name:`/`branding:` keys present.)

## Open Questions

- **O1 (owner: Falconiere)** — Is the GHCR package `toolu-ghactions/code-review` **public**? A Marketplace action in `toolu-code-review` pulling `ghcr.io/.../toolu-ghactions/code-review` needs public read. If private, either make it public or push a copy to a `toolu-code-review` image namespace (changes the "reuse, don't rebuild" decision).
- **O2 (owner: Falconiere)** — Mirror `code-review/action.yml` image: float to `:v<major>` (tracks patches, matches `@vN` UX — recommended) or pin exact `:<tag>` per mirror release (more reproducible)? Spec assumes `:v<major>`.
- **O3 (owner: Falconiere)** — Does the deferred `@v2` image-tag bug get fixed before the first mirror publish? The mirror is correct regardless, but the monorepo's own `code-review@v2` stays broken until then.
- **O4 (owner: dev)** — Should `__tests__/` be excluded from mirrors to keep listings lean, or kept for transparency? Spec keeps them; cheap to flip.
