#!/usr/bin/env bash
# build.sh — one atomic Gradle invocation derived from `format`; applies
# signing.init.gradle and verifies (via marker file) that release signing was
# actually injected whenever a release keystore is configured.
set -euo pipefail

dir="${EXPO_BUILDER_WORKING_DIR:-.}"
format="${EXPO_BUILDER_FORMAT:-apk}"
init_script="${EXPO_BUILDER_INIT_SCRIPT:?EXPO_BUILDER_INIT_SCRIPT is required}"

case "$format" in
  apk) tasks=(assembleRelease) ;;
  aab) tasks=(bundleRelease) ;;
  both) tasks=(assembleRelease bundleRelease) ;;
  *)
    echo "::error::invalid format '$format' (expected apk | aab | both)"
    exit 1
    ;;
esac

cd "$dir"
if [ ! -d android ]; then
  echo "::error::no android/ directory in '$dir' — prebuild did not run?"
  exit 1
fi

cmd=(./gradlew -I "$init_script" "${tasks[@]}")
if [ "${EXPO_BUILDER_DRY_RUN:-0}" = "1" ]; then
  echo "${cmd[*]}"
  exit 0
fi

# Must match signing.init.gradle's marker location exactly — both key off
# RUNNER_TEMP alone, so require it rather than risk divergent fallbacks.
marker="${RUNNER_TEMP:?RUNNER_TEMP is required (set by the Actions runner)}/expo-builder-signing-applied"
rm -f "$marker"

cd android
"${cmd[@]}"

if [ -n "${EXPO_BUILDER_KEYSTORE_PATH:-}" ] && [ ! -f "$marker" ]; then
  echo "::error::release keystore was configured but signing.init.gradle never applied it — refusing to ship a wrongly-signed binary"
  exit 1
fi
