#!/usr/bin/env bash
# play-token.sh — mint an OAuth2 access token for the Android Publisher API
# from a base64-encoded service-account JSON (env EXPO_BUILDER_PLAY_SA_B64):
# RS256 JWT bearer flow signed with openssl. The token goes to STDOUT and
# nowhere else; the private key touches disk only as a 0600 temp file under
# RUNNER_TEMP that an EXIT trap removes.
set -euo pipefail

sa_b64="${EXPO_BUILDER_PLAY_SA_B64:?EXPO_BUILDER_PLAY_SA_B64 is required}"

# shellcheck source=src/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
decode_flag="$(b64_decode_flag)"

if ! sa_json="$(printf '%s' "$sa_b64" | base64 "$decode_flag" 2>/dev/null)" || [ -z "$sa_json" ]; then
  echo "::error::service-account-json-base64 did not decode (is it base64 of the key JSON?)" >&2
  exit 1
fi

# jq -r is load-bearing: without raw output the PEM's \n escapes stay literal
# and openssl rejects the key.
client_email="$(printf '%s' "$sa_json" | jq -r '.client_email // empty' 2>/dev/null)" || client_email=""
private_key="$(printf '%s' "$sa_json" | jq -r '.private_key // empty' 2>/dev/null)" || private_key=""
if [ -z "$client_email" ] || [ -z "$private_key" ]; then
  echo "::error::service-account-json-base64 is not a valid service-account key (bad JSON or missing client_email/private_key)" >&2
  exit 1
fi

workdir="$(mktemp -d "${RUNNER_TEMP:?RUNNER_TEMP is required}/expo-builder-play.XXXXXX")"
trap 'rm -rf "$workdir"' EXIT
keyfile="$workdir/sa.key"
# Subshell umask: the file is born 0600 — no window with default permissions.
# The trailing newline restores the one command substitution stripped; PEM
# parsers require the END line to be newline-terminated.
(umask 077 && printf '%s\n' "$private_key" >"$keyfile")

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

iat="$(date +%s)"
exp=$((iat + 3600))
header='{"alg":"RS256","typ":"JWT"}'
claims="$(printf '{"iss":"%s","scope":"https://www.googleapis.com/auth/androidpublisher","aud":"https://oauth2.googleapis.com/token","iat":%s,"exp":%s}' \
  "$client_email" "$iat" "$exp")"

signing_input="$(printf '%s' "$header" | b64url).$(printf '%s' "$claims" | b64url)"
if ! signature="$(printf '%s' "$signing_input" | openssl dgst -sha256 -sign "$keyfile" 2>/dev/null | b64url)"; then
  echo "::error::could not sign the JWT — the service-account private_key is not a valid PEM key" >&2
  exit 1
fi
jwt="$signing_input.$signature"

response_file="$workdir/token.json"
http_code="$(curl -sS -o "$response_file" -w '%{http_code}' \
  --data-urlencode 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer' \
  --data-urlencode "assertion=$jwt" \
  "https://oauth2.googleapis.com/token")" || {
  rc=$?
  echo "::error::token exchange transport failure (curl exit $rc)" >&2
  exit 1
}
if [ "$http_code" -ge 400 ]; then
  echo "::error::token exchange failed (HTTP $http_code): $(cat "$response_file")" >&2
  exit 1
fi

token="$(jq -r '.access_token // empty' <"$response_file")"
if [ -z "$token" ]; then
  echo "::error::token exchange returned no access_token: $(cat "$response_file")" >&2
  exit 1
fi
printf '%s\n' "$token"
