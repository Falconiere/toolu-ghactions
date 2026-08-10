#!/usr/bin/env bash
# mirror-action.sh — build-and-sync one monorepo action into its standalone
# GitHub Marketplace publish repo.
#
# Why: the Marketplace lists exactly one root-`action.yml` action per repo;
# subdirectory actions never qualify. This mirrors a monorepo action into its
# own repo (root action.yml + sources) so it can be listed, while development
# stays in the monorepo. See
# docs/toolu/specs/2026-06-16-marketplace-mirror-pipeline-design.md.
#
# It clones the mirror repo, lays a freshly-computed file tree at its root,
# commits on top of the mirror's main (fast-forward), tags the release
# (immutable — never moved), and force-moves the floating v<major> alias.
#
# Usage: mirror-action.sh <work_dir>
#
# Environment (required):
#   ACTION        code-review | cloudflare-tunnel
#   TAG           release tag, e.g. v2.1.0
#   MAJOR         major number, e.g. 2
#   MIRROR_REPO   owner/repo, e.g. Falconiere/toolu-code-review (for messages)
#   MIRROR_TOKEN  repo-scope PAT used in the default clone URL
#   SOURCE_REPO   monorepo owner/repo, for README backlinks
#   SOURCE_SHA    monorepo commit SHA being mirrored (commit trailer)
# Environment (optional):
#   MIRROR_REMOTE full git URL to clone/push (default: token https URL from
#                 MIRROR_REPO). Test seam: point at a local bare repo.
#
# Exit non-zero on any missing input, clone, transform, or push failure.

set -euo pipefail

die() { echo "mirror-action: $*" >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- layout transforms ------------------------------------------------------

# Copy the code-review action to the mirror root. `cp -R` copies the run/ and
# sanitize-sarif/ nested node24 actions along with everything else. One rewrite:
# the composite references its nested actions with the `$/` self-repository
# syntax rooted at the ACTION repo — `$/code-review/run` in the monorepo — and
# the mirror hoists code-review/ to the repo root, so the prefix drops to `$/run`.
layout_code_review() {
  local dest="$1"
  cp -R "$REPO_ROOT/code-review/." "$dest/"
  sed 's#uses: \$/code-review/#uses: $/#g' \
    "$REPO_ROOT/code-review/action.yml" >"$dest/action.yml"
  # sed exits 0 whether or not it matched — assert the rewrite actually landed,
  # because a mirror published with an unrewritten `$/code-review/` reference
  # resolves to nothing at the mirror root and breaks every consumer.
  grep -qF 'uses: $/run' "$dest/action.yml" \
    || die "code-review hoist rewrite failed: no 'uses: \$/run' in mirror action.yml"
  grep -qF 'uses: $/sanitize-sarif' "$dest/action.yml" \
    || die "code-review hoist rewrite failed: no 'uses: \$/sanitize-sarif' in mirror action.yml"
  grep -qF '$/code-review/' "$dest/action.yml" \
    && die "code-review hoist rewrite incomplete: '\$/code-review/' still present in mirror action.yml"
  return 0
}

# Copy the cloudflare-tunnel composite sub-actions and synthesize a root
# action.yml from `start` so the mirror has a listable root action. The hoisted
# root sits one level higher than start/, so its script path must drop the `..`.
layout_cloudflare_tunnel() {
  local dest="$1"
  cp -R "$REPO_ROOT/cloudflare-tunnel/." "$dest/"
  sed 's#\$GITHUB_ACTION_PATH/\.\./src#\$GITHUB_ACTION_PATH/src#g' \
    "$REPO_ROOT/cloudflare-tunnel/start/action.yml" >"$dest/action.yml"
}

# Copy the expo-builder composite sub-actions and synthesize a root action.yml
# from `build-android` so the mirror has a listable root action. Unlike the
# tunnel suite, scripts live per-sub-action, so the hoisted root's paths gain
# the build-android/ segment instead of dropping a `..`.
layout_expo_builder() {
  local dest="$1"
  cp -R "$REPO_ROOT/expo-builder/." "$dest/"
  sed 's#}}/src/#}}/build-android/src/#g' \
    "$REPO_ROOT/expo-builder/build-android/action.yml" >"$dest/action.yml"
}

# Copy LICENSE to the mirror root, repoint the README's monorepo-relative links,
# and prepend a "generated" banner so no one hand-edits the mirror.
rewrite_readmes() {
  local dest="$1"
  cp "$REPO_ROOT/LICENSE" "$dest/LICENSE"
  [ -f "$dest/README.md" ] || return 0
  sed -e 's#](\.\./LICENSE)#](./LICENSE)#g' \
      -e "s#](\.\./README\.md)#](https://github.com/${SOURCE_REPO})#g" \
      "$dest/README.md" >"$dest/README.md.tmp"
  mv "$dest/README.md.tmp" "$dest/README.md"
  local banner="> 🤖 Generated from the [${SOURCE_REPO}](https://github.com/${SOURCE_REPO}) monorepo. Edit there, not here."
  { printf '%s\n\n' "$banner"; cat "$dest/README.md"; } >"$dest/README.md.tmp"
  mv "$dest/README.md.tmp" "$dest/README.md"
}

# --- git sync ---------------------------------------------------------------

git_sync() {
  local dest="$1"
  cd "$dest"
  git config user.name  "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  # Neutralize any inherited global signing config — CI runners have no key, and
  # the mirror's commits/tags are bot-generated artifacts, not signed releases.
  git config commit.gpgsign false
  git config tag.gpgSign false
  git config tag.forceSignAnnotated false

  git add -A
  if git diff --cached --quiet; then
    echo "mirror-action: tree unchanged; no commit"
  else
    git commit -q -m "chore: sync ${ACTION} ${TAG}" -m "source-sha: ${SOURCE_SHA}"
  fi

  local tag_created=0
  if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
    echo "mirror-action: tag ${TAG} already exists; leaving it immutable"
  else
    git tag "${TAG}"
    tag_created=1
  fi
  git tag -f "v${MAJOR}" >/dev/null

  local branch
  branch="$(git symbolic-ref --short HEAD)"
  git push origin "HEAD:${branch}"
  [ "$tag_created" -eq 1 ] && git push origin "${TAG}"
  git push origin "v${MAJOR}" --force
}

main() {
  local work_dir="${1:-}"
  [ -n "$work_dir" ] || die "usage: mirror-action.sh <work_dir>"
  for v in ACTION TAG MAJOR MIRROR_REPO MIRROR_TOKEN SOURCE_REPO SOURCE_SHA; do
    [ -n "${!v:-}" ] || die "$v is required"
  done

  local remote="${MIRROR_REMOTE:-https://x-access-token:${MIRROR_TOKEN}@github.com/${MIRROR_REPO}.git}"
  rm -rf "$work_dir"
  git clone --quiet "$remote" "$work_dir" \
    || die "clone failed for ${MIRROR_REPO} — the repo must exist and the token must have access (this script does not auto-create)"

  # Wipe tracked working-tree content (keep .git), then lay down the fresh tree.
  find "$work_dir" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +

  case "$ACTION" in
    code-review)      layout_code_review "$work_dir" ;;
    cloudflare-tunnel) layout_cloudflare_tunnel "$work_dir" ;;
    expo-builder)     layout_expo_builder "$work_dir" ;;
    *) die "unknown ACTION: $ACTION (expected code-review | cloudflare-tunnel | expo-builder)" ;;
  esac
  rewrite_readmes "$work_dir"
  git_sync "$work_dir"
}

main "$@"
