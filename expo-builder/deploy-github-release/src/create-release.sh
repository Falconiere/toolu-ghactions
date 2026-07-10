#!/usr/bin/env bash
# create-release.sh — publish binaries to a GitHub Release: newline-separated
# glob patterns (spaces literal), tag defaulting to v<app-version>, fail on an
# existing tag unless overwrite=true (--clobber), sha256sums.txt asset.
set -euo pipefail

files_input="${EXPO_BUILDER_FILES:?EXPO_BUILDER_FILES is required}"
tag="${EXPO_BUILDER_TAG:-}"

if [ -z "$tag" ]; then
  if [ -z "${EXPO_BUILDER_APP_VERSION:-}" ]; then
    echo "::error::neither 'tag' nor 'app-version' was given — cannot derive a release tag"
    exit 1
  fi
  tag="v$EXPO_BUILDER_APP_VERSION"
fi
release_name="${EXPO_BUILDER_RELEASE_NAME:-$tag}"
[ -n "$release_name" ] || release_name="$tag"

# Expand newline-separated glob patterns; spaces within a line stay literal.
assets=()
while IFS= read -r pattern; do
  [ -n "$pattern" ] || continue
  matched=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    assets+=("$f")
    matched=1
  done < <(compgen -G "$pattern" || true)
  if [ "$matched" -eq 0 ]; then
    echo "::error::files pattern matched nothing: '$pattern'"
    exit 1
  fi
done <<<"$files_input"

if [ "${#assets[@]}" -eq 0 ]; then
  echo "::error::'files' resolved to zero assets"
  exit 1
fi

# Portable sha256 (sha256sum on Linux, shasum on macOS).
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

if [ "${EXPO_BUILDER_CHECKSUMS:-true}" = "true" ]; then
  sums="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/sha256sums.txt"
  : >"$sums"
  for f in "${assets[@]}"; do
    printf '%s  %s\n' "$(sha256_of "$f")" "$(basename "$f")" >>"$sums"
  done
  assets+=("$sums")
fi

exists=0
if gh release view "$tag" --json url --jq .url >/dev/null 2>&1 \
  || gh api "repos/${GH_REPO:?GH_REPO is required}/git/ref/tags/$tag" >/dev/null 2>&1; then
  exists=1
fi

upload_args=()
if [ "$exists" -eq 1 ]; then
  if [ "${EXPO_BUILDER_OVERWRITE:-false}" != "true" ]; then
    echo "::error::tag or release '$tag' already exists — set overwrite: true to re-upload assets"
    exit 1
  fi
  echo "[expo-builder] release '$tag' exists — re-uploading assets with --clobber"
  upload_args+=(--clobber)
  url="$(gh release view "$tag" --json url --jq .url)"
else
  create_args=(--title "$release_name" --notes "Published by expo-builder/deploy-github-release.")
  [ "${EXPO_BUILDER_DRAFT:-false}" = "true" ] && create_args+=(--draft)
  [ "${EXPO_BUILDER_PRERELEASE:-false}" = "true" ] && create_args+=(--prerelease)
  url="$(gh release create "$tag" "${create_args[@]}")"
fi

gh release upload "$tag" "${assets[@]}" "${upload_args[@]}"

# Unique heredoc delimiter — a static one could be matched by an asset
# literally named like it, truncating the multiline output.
delim="EXPO_BUILDER_EOF_$$_${SRANDOM:-$RANDOM}"
{
  echo "release-url=$url"
  echo "uploaded-assets<<$delim"
  for f in "${assets[@]}"; do basename "$f"; done
  echo "$delim"
} >>"$GITHUB_OUTPUT"
echo "[expo-builder] released ${#assets[@]} asset(s) to '$tag'"
