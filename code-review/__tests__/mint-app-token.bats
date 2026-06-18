#!/usr/bin/env bash
# mint-app-token.bats — tests for mint-app-token.sh.
#
# Uses REAL crypto: a fresh RSA keypair is generated per test with openssl, the
# JWT is signed for real, and the signature is verified against the public key.
# The full mint flow uses a curl mock that branches on URL and returns recorded
# GitHub REST response shapes from fixtures/app/.

load helpers

APP_ID="901234"

# Generate a real RSA keypair into temp files; export the PEM as the App key.
setup_app_keys() {
    KEY_DIR=$(mktemp -d)
    PRIVATE_KEY_FILE="$KEY_DIR/private.pem"
    PUBLIC_KEY_FILE="$KEY_DIR/public.pem"
    openssl genrsa -out "$PRIVATE_KEY_FILE" 2048 2>/dev/null
    openssl rsa -in "$PRIVATE_KEY_FILE" -pubout -out "$PUBLIC_KEY_FILE" 2>/dev/null
    export INPUT_APP_ID="$APP_ID"
    INPUT_APP_PRIVATE_KEY="$(cat "$PRIVATE_KEY_FILE")"
    export INPUT_APP_PRIVATE_KEY
}

teardown_app_keys() {
    rm -rf "${KEY_DIR:-/tmp/nonexistent}"
}

# base64url-decode <segment> — pad and translate back to standard base64 so
# `openssl base64 -d` can decode a JWT segment.
b64url_decode() {
    local s="$1"
    s="${s//-/+}"
    s="${s//_/\/}"
    case $(( ${#s} % 4 )) in
        2) s="${s}==" ;;
        3) s="${s}=" ;;
    esac
    printf '%s' "$s" | openssl base64 -d -A
}

# Install a curl mock on PATH that branches on URL: the installation endpoint
# returns installation.json, the access_tokens endpoint returns
# access-tokens.json. <install-fixture> may be overridden to simulate failure.
setup_mock_curl() {
    local install_fixture="${1:-$FIXTURES_DIR/app/installation.json}"
    local install_code="${2:-200}"
    MOCK_DIR=$(mktemp -d)
    cat > "$MOCK_DIR/curl" << ENDSCRIPT
#!/usr/bin/env bash
args=("\$@"); outfile=""
for i in "\${!args[@]}"; do
    [ "\${args[\$i]}" = "-o" ] && outfile="\${args[\$((i+1))]}"
done
url="\${args[-1]}"
if [[ "\$url" == */access_tokens ]]; then
    body="\$(cat '$FIXTURES_DIR/app/access-tokens.json')"; code="201"
elif [[ "\$url" == */installation ]]; then
    body="\$(cat '$install_fixture')"; code="$install_code"
else
    body='{}'; code="404"
fi
[ -n "\$outfile" ] && printf '%s' "\$body" > "\$outfile"
printf '%s' "\$code"
ENDSCRIPT
    chmod +x "$MOCK_DIR/curl"
    export PATH="$MOCK_DIR:$PATH"
}

teardown_mock_curl() {
    rm -rf "${MOCK_DIR:-/tmp/nonexistent}"
}

@test "build_jwt: produces a valid RS256 JWT verifiable against the public key" {
    setup_app_keys

    # shellcheck source=/dev/null
    source "$SRC_DIR/mint-app-token.sh"
    jwt=$(build_jwt "$APP_ID" "$PRIVATE_KEY_FILE")

    # Three dot-separated segments.
    header="${jwt%%.*}"
    rest="${jwt#*.}"
    payload="${rest%%.*}"
    sig="${rest#*.}"
    [ -n "$header" ] && [ -n "$payload" ] && [ -n "$sig" ]

    # Header claims.
    header_json=$(b64url_decode "$header")
    [ "$(echo "$header_json" | jq -r '.alg')" = "RS256" ]
    [ "$(echo "$header_json" | jq -r '.typ')" = "JWT" ]

    # Payload claims: issuer is the app id, lifetime ≤ 600s.
    payload_json=$(b64url_decode "$payload")
    [ "$(echo "$payload_json" | jq -r '.iss')" = "$APP_ID" ]
    iat=$(echo "$payload_json" | jq -r '.iat')
    exp=$(echo "$payload_json" | jq -r '.exp')
    [ "$((exp - iat))" -le 600 ]

    # REAL signature verification against the public key (must succeed).
    sig_file="$KEY_DIR/sig.bin"
    b64url_decode "$sig" > "$sig_file"
    printf '%s' "${header}.${payload}" \
        | openssl dgst -sha256 -verify "$PUBLIC_KEY_FILE" -signature "$sig_file"

    teardown_app_keys
}

@test "mint: both creds set → prints the installation token, exit 0" {
    setup_app_keys
    setup_mock_curl

    run bash "$SRC_DIR/mint-app-token.sh"
    [ "$status" -eq 0 ]
    [ "$output" = "ghs_exampletoken1234567890abcdefghijklmn" ]

    teardown_mock_curl
    teardown_app_keys
}

@test "mint: base64-encoded private key is decoded and used, exit 0" {
    setup_app_keys
    setup_mock_curl
    # Many users store the multiline PEM base64-encoded on one line in a secret;
    # the action must auto-decode it. Real key → real JWT signing after decode.
    INPUT_APP_PRIVATE_KEY="$(openssl base64 -A -in "$PRIVATE_KEY_FILE")"
    export INPUT_APP_PRIVATE_KEY

    run bash "$SRC_DIR/mint-app-token.sh"
    [ "$status" -eq 0 ]
    [ "$output" = "ghs_exampletoken1234567890abcdefghijklmn" ]

    teardown_mock_curl
    teardown_app_keys
}

@test "mint: partial creds (only APP_ID) → WARN on stderr, empty stdout, exit 1" {
    export INPUT_APP_ID="$APP_ID"
    unset INPUT_APP_PRIVATE_KEY

    # stdout must be empty (caller's && chain falls back on exit 1).
    run bash -c "bash '$SRC_DIR/mint-app-token.sh' 2>/dev/null"
    [ "$status" -eq 1 ]
    [ -z "$output" ]

    # The WARN goes to stderr (capture stderr into $output, drop stdout).
    run bash -c "bash '$SRC_DIR/mint-app-token.sh' 2>&1 1>/dev/null"
    [[ "$output" == *"WARN"* ]]
    [[ "$output" == *"must both be set"* ]]
}

@test "mint: no creds → silent no-op, empty stdout, exit 0" {
    unset INPUT_APP_ID
    unset INPUT_APP_PRIVATE_KEY

    run bash "$SRC_DIR/mint-app-token.sh"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "mint: installation lookup non-2xx → WARN on stderr, empty stdout, exit 1" {
    setup_app_keys
    setup_mock_curl "$FIXTURES_DIR/app/not-found.json" "404"

    # stdout must be empty.
    run bash -c "bash '$SRC_DIR/mint-app-token.sh' 2>/dev/null"
    [ "$status" -eq 1 ]
    [ -z "$output" ]

    # The mint-failure WARN goes to stderr.
    run bash -c "bash '$SRC_DIR/mint-app-token.sh' 2>&1 1>/dev/null"
    [[ "$output" == *"[WARN] App token mint failed"* ]]

    teardown_mock_curl
    teardown_app_keys
}
