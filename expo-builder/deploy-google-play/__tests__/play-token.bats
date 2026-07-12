#!/usr/bin/env bats
# play-token.bats — JWT minting with a REAL openssl keypair (the signature is
# cryptographically VERIFIED against the public key); only curl (the network
# binary) is a recording shim replaying real-shaped OAuth responses.

load ../../__tests__/helpers

setup() {
    common_setup
    SCRIPT="$SUITE_ROOT/deploy-google-play/src/play-token.sh"
    FIXTURES="$SUITE_ROOT/deploy-google-play/__tests__/fixtures"

    # A REAL service-account keypair: private key into the SA JSON fixture,
    # public key kept for signature verification.
    openssl genrsa -out "$BATS_TEST_TMPDIR/sa.pem" 2048 2>/dev/null
    openssl rsa -in "$BATS_TEST_TMPDIR/sa.pem" -pubout -out "$BATS_TEST_TMPDIR/sa.pub" 2>/dev/null
    jq -n --rawfile key "$BATS_TEST_TMPDIR/sa.pem" \
        '{client_email: "ci@project.iam.gserviceaccount.com", private_key: $key}' \
        >"$BATS_TEST_TMPDIR/sa.json"
    SA_B64="$(base64 <"$BATS_TEST_TMPDIR/sa.json" | tr -d '\n')"

    # Real-curl protocol: body goes to the -o target, ONLY the status code to
    # stdout (matches the script's -w '%{http_code}' capture).
    make_shim curl "$(replay_body token.json 200)"
}

# Shim body honoring curl's -o flag: write the fixture there, print the code.
replay_body() {
    printf 'out=/dev/stdout; prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done
cat '\''%s/%s'\'' >"$out"; printf %s' "$FIXTURES" "$1" "$2"
}

teardown() { common_teardown; }

b64url_decode() {
    local s="$1" pad
    s="$(printf '%s' "$s" | tr '_-' '/+')"
    pad=$(( (4 - ${#s} % 4) % 4 ))
    while [ "$pad" -gt 0 ]; do s="$s="; pad=$((pad - 1)); done
    printf '%s' "$s" | openssl base64 -d -A
}

@test "mints a token: RS256 signature VERIFIES against the real public key, claims exact" {
    EXPO_BUILDER_PLAY_SA_B64="$SA_B64" run "$SCRIPT"
    [ "$status" -eq 0 ]
    [ "$output" = "ya29.test-access-token-value" ]

    # Reconstruct the JWT the script sent (recorded by the curl shim).
    call="$(shim_calls curl)"
    jwt="${call#*assertion=}"
    jwt="${jwt%% *}"
    header="${jwt%%.*}"
    rest="${jwt#*.}"
    payload="${rest%%.*}"
    sig="${rest#*.}"

    # Real crypto verification: header.payload signed by the private key.
    printf '%s' "$header.$payload" >"$BATS_TEST_TMPDIR/signing-input"
    b64url_decode "$sig" >"$BATS_TEST_TMPDIR/sig.bin"
    openssl dgst -sha256 -verify "$BATS_TEST_TMPDIR/sa.pub" \
        -signature "$BATS_TEST_TMPDIR/sig.bin" "$BATS_TEST_TMPDIR/signing-input"

    # Claims: iss/scope/aud exact, exp-iat exactly 3600.
    b64url_decode "$payload" >"$BATS_TEST_TMPDIR/claims.json"
    [ "$(jq -r '.iss' "$BATS_TEST_TMPDIR/claims.json")" = "ci@project.iam.gserviceaccount.com" ]
    [ "$(jq -r '.scope' "$BATS_TEST_TMPDIR/claims.json")" = "https://www.googleapis.com/auth/androidpublisher" ]
    [ "$(jq -r '.aud' "$BATS_TEST_TMPDIR/claims.json")" = "https://oauth2.googleapis.com/token" ]
    [ "$(jq -r '.exp - .iat' "$BATS_TEST_TMPDIR/claims.json")" = "3600" ]
    [ "$(b64url_decode "$header" | jq -r '.alg')" = "RS256" ]
}

@test "temp key directory is gone after exit" {
    EXPO_BUILDER_PLAY_SA_B64="$SA_B64" run "$SCRIPT"
    [ "$status" -eq 0 ]
    run bash -c "ls '$RUNNER_TEMP' | grep expo-builder-play"
    [ "$status" -ne 0 ]
}

@test "invalid base64 fails before any curl call" {
    EXPO_BUILDER_PLAY_SA_B64="%%%not-base64%%%" run "$SCRIPT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::service-account-json-base64 did not decode"* ]]
    [ ! -f "$SHIM_DIR/curl.calls" ]
}

@test "JSON missing private_key fails with named error, no curl" {
    b64="$(printf '{"client_email":"a@b.c"}' | base64 | tr -d '\n')"
    EXPO_BUILDER_PLAY_SA_B64="$b64" run "$SCRIPT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"missing client_email/private_key"* ]]
    [ ! -f "$SHIM_DIR/curl.calls" ]
}

@test "garbage private_key fails at signing with PEM error" {
    b64="$(printf '{"client_email":"a@b.c","private_key":"not-a-pem"}' | base64 | tr -d '\n')"
    EXPO_BUILDER_PLAY_SA_B64="$b64" run "$SCRIPT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"not a valid PEM key"* ]]
}

@test "OAuth 401 replay exits non-zero with the Google error body" {
    make_shim curl "$(replay_body token-401.json 401)"
    EXPO_BUILDER_PLAY_SA_B64="$SA_B64" run "$SCRIPT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"token exchange failed (HTTP 401)"* ]]
    [[ "$output" == *"Invalid JWT Signature"* ]]
}

@test "token endpoint transport failure (curl exit 28) is reported" {
    make_shim curl 'exit 28'
    EXPO_BUILDER_PLAY_SA_B64="$SA_B64" run "$SCRIPT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"transport failure (curl exit 28)"* ]]
}
