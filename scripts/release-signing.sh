#!/usr/bin/env bash
# release-signing.sh - make a code-signing identity usable on a CI Mac, for
# .github/workflows/release.yml, and print its name for APPLE_SIGNING_IDENTITY.
#
# Usage: release-signing.sh import      the identity in QUARTERDECK_SIGNING_P12
#                                       (base64 of a .p12) and
#                                       QUARTERDECK_SIGNING_P12_PASSWORD
#        release-signing.sh throwaway   a self-signed identity made on the spot,
#                                       for a dry run; it signs nothing kept
#        release-signing.sh cleanup     delete the keychain either one made
#
# The identity goes into a keychain of its own under RUNNER_TEMP, added to the
# search list so the Tauri bundler's codesign finds it. A self-signed
# certificate is also trusted for code signing in the system domain: codesign
# refuses an untrusted one outright ("no identity found"), which is why this
# needs the passwordless sudo a hosted runner has. A Developer ID certificate is
# trusted already and skips that step.
#
# Nothing secret is printed: the .p12 is decoded into the keychain's folder,
# imported, and deleted.
set -euo pipefail

TEMP=${RUNNER_TEMP:?release-signing.sh runs in CI, where RUNNER_TEMP is set}
KEYCHAIN="$TEMP/quarterdeck-signing.keychain-db"
OPENSSL=/usr/bin/openssl

die() {
  printf 'release-signing.sh: %s\n' "$1" >&2
  exit 1
}

# The keychain, unlocked for the whole job and ahead of the login keychain.
make_keychain() {
  local password
  password=$("$OPENSSL" rand -hex 24)
  security delete-keychain "$KEYCHAIN" >/dev/null 2>&1 || true
  security create-keychain -p "$password" "$KEYCHAIN" >/dev/null
  security set-keychain-settings "$KEYCHAIN" >/dev/null
  security unlock-keychain -p "$password" "$KEYCHAIN" >/dev/null
  printf '%s' "$password"
}

# import <p12 file> <p12 password> <keychain password>
import_p12() {
  security import "$1" -k "$KEYCHAIN" -P "$2" -T /usr/bin/codesign >/dev/null
  security set-key-partition-list -S apple-tool:,apple: -s -k "$3" "$KEYCHAIN" >/dev/null
  # shellcheck disable=SC2046 # one keychain path per word, as security prints them
  security list-keychains -d user -s "$KEYCHAIN" $(security list-keychains -d user | tr -d '"') >/dev/null
}

# The name of the one code-signing identity in the keychain, trusted if it
# has to be.
identity() {
  local name cert
  name=$(security find-identity -p codesigning "$KEYCHAIN" | sed -n 's/^ *1) [0-9A-F]\{40\} "\(.*\)".*$/\1/p' | head -n 1)
  [ -n "$name" ] || die "the certificate holds no code-signing identity"
  if ! security find-identity -v -p codesigning "$KEYCHAIN" | grep -qF "\"$name\""; then
    cert="$TEMP/quarterdeck-signing.pem"
    security find-certificate -c "$name" -p "$KEYCHAIN" >"$cert"
    sudo security add-trusted-cert -d -r trustRoot -p codeSign -k /Library/Keychains/System.keychain "$cert" >&2
    rm -f "$cert"
    security find-identity -v -p codesigning "$KEYCHAIN" | grep -qF "\"$name\"" ||
      die "\"$name\" is still not trusted for code signing"
  fi
  printf '%s\n' "$name"
}

case "${1:-}" in
  import)
    [ -n "${QUARTERDECK_SIGNING_P12:-}" ] || die "QUARTERDECK_SIGNING_P12 is not set"
    p12="$TEMP/quarterdeck-signing.p12"
    printf '%s' "$QUARTERDECK_SIGNING_P12" | base64 --decode >"$p12" || die "QUARTERDECK_SIGNING_P12 is not base64"
    password=$(make_keychain)
    import_p12 "$p12" "${QUARTERDECK_SIGNING_P12_PASSWORD:-}" "$password" || { rm -f "$p12"; die "the .p12 could not be imported: is QUARTERDECK_SIGNING_P12_PASSWORD right?"; }
    rm -f "$p12"
    identity
    ;;
  throwaway)
    work="$TEMP/quarterdeck-throwaway"
    rm -rf "$work"
    mkdir -p "$work"
    cat >"$work/cert.cnf" <<'EOF'
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = Quarterdeck Dry Run
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
EOF
    "$OPENSSL" req -x509 -newkey rsa:2048 -nodes -keyout "$work/key.pem" -out "$work/cert.pem" -days 2 -config "$work/cert.cnf" 2>/dev/null
    "$OPENSSL" pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" -out "$work/cert.p12" -passout pass:dry-run -name "Quarterdeck Dry Run" 2>/dev/null
    password=$(make_keychain)
    import_p12 "$work/cert.p12" dry-run "$password"
    rm -rf "$work"
    identity
    ;;
  cleanup)
    security delete-keychain "$KEYCHAIN" >/dev/null 2>&1 || true
    ;;
  *)
    die "usage: release-signing.sh import | throwaway | cleanup"
    ;;
esac
