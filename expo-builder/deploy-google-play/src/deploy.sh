#!/usr/bin/env bash
# deploy.sh — upload an AAB to a Google Play track: validate every input BEFORE
# any network call, mint the token (in-process, masked), then the Android
# Publisher v3 edits flow: insert edit -> upload bundle -> assign track ->
# commit. tracks.update REPLACES the track's active releases with only the
# uploaded versionCode (documented single-release scope).
set -euo pipefail

api="https://androidpublisher.googleapis.com"

# --- Validation (all before any network call). ---
pkg="${EXPO_BUILDER_PLAY_PACKAGE:-}"
aab="${EXPO_BUILDER_PLAY_AAB:-}"
track="${EXPO_BUILDER_PLAY_TRACK:-}"
status="${EXPO_BUILDER_PLAY_STATUS:-completed}"
hold_review="${EXPO_BUILDER_PLAY_HOLD_REVIEW:-false}"
upload_timeout="${EXPO_BUILDER_PLAY_UPLOAD_TIMEOUT:-600}"
token_script="${EXPO_BUILDER_PLAY_TOKEN_SCRIPT:?EXPO_BUILDER_PLAY_TOKEN_SCRIPT is required}"

sa_b64="${EXPO_BUILDER_PLAY_SA_B64:-}"
if printf 'eA==' | base64 -d >/dev/null 2>&1; then decode_flag="-d"; else decode_flag="-D"; fi
if [ -z "$sa_b64" ] || ! sa_json="$(printf '%s' "$sa_b64" | base64 "$decode_flag" 2>/dev/null)" \
  || [ -z "$(printf '%s' "$sa_json" | jq -r '.client_email // empty' 2>/dev/null)" ] \
  || [ -z "$(printf '%s' "$sa_json" | jq -r '.private_key // empty' 2>/dev/null)" ]; then
  echo "::error::service-account-json-base64 is not a valid service-account key (bad base64/JSON or missing client_email/private_key)"
  exit 1
fi
if [ -z "$pkg" ]; then
  echo "::error::package-name is required"
  exit 1
fi
if [ ! -s "$aab" ]; then
  echo "::error::no AAB at '$aab' — pipe build-android's aab-path output"
  exit 1
fi
if [ -z "$track" ]; then
  echo "::error::track must not be empty"
  exit 1
fi
case "$status" in
  completed | draft) ;;
  *)
    echo "::error::invalid release-status '$status' (expected completed | draft)"
    exit 1
    ;;
esac
case "$upload_timeout" in
  '' | *[!0-9]* | 0)
    echo "::error::upload-timeout must be a positive integer (got '$upload_timeout')"
    exit 1
    ;;
esac

# --- Token: in-process only, masked the moment it exists. ---
token="$("$token_script")"
echo "::add-mask::$token"

workdir="$(mktemp -d "${RUNNER_TEMP:?RUNNER_TEMP is required}/expo-builder-deploy.XXXXXX")"
trap 'rm -rf "$workdir"' EXIT
body="$workdir/response.json"

# One API call: transport failures (curl exit) are reported with the exit
# code's meaning; HTTP >=400 surfaces Google's message verbatim plus a hint.
api_call() {
  local label="$1"
  shift 1
  local http_code rc=0
  http_code="$(curl -sS -o "$body" -w '%{http_code}' \
    -H "Authorization: Bearer $token" "$@")" || rc=$?
  if [ "$rc" -ne 0 ]; then
    local meaning="curl exit $rc"
    case "$rc" in
      28) meaning="curl exit 28 — timed out" ;;
      35) meaning="curl exit 35 — TLS handshake failure" ;;
      52) meaning="curl exit 52 — empty reply from server" ;;
    esac
    echo "::error::$label transport failure ($meaning)"
    exit 1
  fi
  if [ "$http_code" -ge 400 ]; then
    local msg
    msg="$(cat "$body")"
    local extra=""
    case "$msg" in
      *applicationNotFound*)
        extra=" Hint: the first AAB for a package must be uploaded manually in Play Console, and the service account needs access to this app."
        ;;
      *[Rr]eview*)
        if [ "$label" = "commit edit" ]; then
          extra=" Hint: apps that have never passed Play review must use release-status: draft."
        fi
        ;;
    esac
    case "$msg" in
      *editExpired* | *EDIT_EXPIRED* | *editAlreadyCommitted*)
        extra=" Hint: the Play edit expired or was superseded mid-deploy — re-run the workflow."
        ;;
    esac
    echo "::error::$label failed (HTTP $http_code): ${msg}${extra}"
    exit 1
  fi
}

# --- 1. Insert edit. ---
api_call "insert edit" -X POST "$api/androidpublisher/v3/applications/$pkg/edits"
edit_id="$(jq -r '.id // empty' <"$body")"
if [ -z "$edit_id" ]; then
  echo "::error::insert edit returned no edit id: $(cat "$body")"
  exit 1
fi

# --- 2. Upload the bundle (the only call that gets the long --max-time). ---
api_call "bundle upload" -X POST \
  -H "Content-Type: application/octet-stream" \
  --max-time "$upload_timeout" \
  --data-binary "@$aab" \
  "$api/upload/androidpublisher/v3/applications/$pkg/edits/$edit_id/bundles"
version_code="$(jq -r '.versionCode // empty' <"$body")"
if [ -z "$version_code" ]; then
  echo "::error::bundle upload returned no versionCode: $(cat "$body")"
  exit 1
fi

# --- 3. Assign the track (REPLACES the track's active releases). ---
track_body="$(printf '{"track":"%s","releases":[{"versionCodes":["%s"],"status":"%s"}]}' \
  "$track" "$version_code" "$status")"
api_call "track update" -X PUT \
  -H "Content-Type: application/json" \
  -d "$track_body" \
  "$api/androidpublisher/v3/applications/$pkg/edits/$edit_id/tracks/$track"

# --- 4. Commit. ---
commit_url="$api/androidpublisher/v3/applications/$pkg/edits/$edit_id:commit"
if [ "$hold_review" = "true" ]; then
  commit_url="$commit_url?changesNotSentForReview=true"
fi
api_call "commit edit" -X POST "$commit_url"

{
  echo "version-code=$version_code"
  echo "track=$track"
} >>"$GITHUB_OUTPUT"
echo "[expo-builder] released versionCode $version_code to '$track' as $status"
