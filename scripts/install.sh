#!/bin/sh
# Installs the latest Quarterdeck release on an Apple Silicon Mac, for someone who
# has never had it:
#
#   curl -fsSL https://raw.githubusercontent.com/caomyer/quarterdeck/main/scripts/install.sh | sh
#
# The release is not notarized, so a copy downloaded in a browser is refused by
# Gatekeeper. A file curl fetches carries no quarantine flag and opens, which is
# why this is the way in until the app is notarized (docs/releasing.md). Once
# installed, the app updates itself.
#
# It reads the same latest.json the app's updater reads, needs nothing that is not
# on a new Mac (no jq, no python), unpacks into a temporary folder, and moves the
# app into place only once that has worked, so a failure leaves the Mac as it was.
# It refuses an Intel Mac, and refuses to replace a copy that is running.
#
# For tests, and nothing else:
#   QUARTERDECK_MANIFEST_URL  where latest.json is read from
#   QUARTERDECK_INSTALL_DIR   where the app goes, instead of /Applications
#   QUARTERDECK_INSTALL_ARCH  what `uname -m` would say
#   QUARTERDECK_INSTALL_OPEN  0 to not open the app afterwards
set -eu

APP="firstmate desktop.app"
MANIFEST=${QUARTERDECK_MANIFEST_URL:-https://github.com/caomyer/quarterdeck/releases/latest/download/latest.json}
DEST_DIR=${QUARTERDECK_INSTALL_DIR:-/Applications}
DEST="$DEST_DIR/$APP"

say() { printf '%s\n' "$*"; }
stop() { printf '%s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || stop "Quarterdeck runs on macOS only, so nothing was installed."
arch=${QUARTERDECK_INSTALL_ARCH:-$(uname -m)}
[ "$arch" = arm64 ] || stop "This Mac has an Intel processor. Quarterdeck runs only on Apple Silicon for now, so nothing was installed."

# A copy running from where this one goes would lose its first mate mid-turn.
if pgrep -f "$DEST/Contents/MacOS/" >/dev/null 2>&1; then
  stop "firstmate desktop is open. Quit it, then run this line again. Nothing was changed."
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/quarterdeck-install.XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM

manifest=$(curl -fsSL "$MANIFEST" 2>"$work/curl.err") || stop "Could not read the latest release: $(tail -n 1 "$work/curl.err")
Nothing was installed."
version=$(printf '%s\n' "$manifest" | sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
# The one platform the app ships for; its url is the first url after its name.
url=$(printf '%s\n' "$manifest" | sed -n '/"darwin-aarch64"/,/}/s/^[[:space:]]*"url":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
[ -n "$version" ] && [ -n "$url" ] || stop "The latest release does not say where its Apple Silicon build is. Nothing was installed."

say "Installing Quarterdeck $version for Apple Silicon."
curl -fsSL "$url" -o "$work/app.tar.gz" 2>"$work/curl.err" || stop "Could not download the latest release: $(tail -n 1 "$work/curl.err")
Nothing was installed."
size=$(du -m "$work/app.tar.gz" | cut -f1)
say "Downloaded $size MB."
mkdir -p "$work/unpacked"
tar -xzf "$work/app.tar.gz" -C "$work/unpacked" 2>"$work/tar.err" || stop "The download could not be unpacked: $(tail -n 1 "$work/tar.err")
Nothing was installed."
[ -d "$work/unpacked/$APP" ] || stop "The download did not hold $APP. Nothing was installed."

mkdir -p "$DEST_DIR"
if [ -e "$DEST" ]; then
  mv "$DEST" "$work/previous.app" || stop "Could not move the copy already in $DEST_DIR aside. Nothing was changed."
fi
if ! mv "$work/unpacked/$APP" "$DEST"; then
  [ -e "$work/previous.app" ] && mv "$work/previous.app" "$DEST"
  stop "Could not put the app in $DEST_DIR. The copy that was there is back."
fi
say "Installed $DEST"

if [ "${QUARTERDECK_INSTALL_OPEN:-1}" != 0 ]; then
  say "Opening it. From now on it updates itself."
  open "$DEST"
fi
