#!/bin/sh
# Installs or updates Hangar on macOS: curl -fsSL https://hangar.odahcam.com/install.sh | sh
# Downloads Hangar.zip from a pinned GitHub release, checks its SHA-256, puts it in /Applications and clears the
# quarantine flag. The version and digest live here, not on GitHub: a release asset swapped there fails the check,
# so each release updates both lines and redeploys the Worker.
# Everything runs inside main, called on the last line, so a download cut short runs nothing.
set -eu

VERSION=0.4.0
SHA256=7d4c45a03dfb27b7095ca4b2d04aa3c98f4a0855817155841989721e39d120ea

main() {
	repo="https://github.com/odahcam/hangar/releases/download/v$VERSION/Hangar.zip"
	dest="/Applications/Hangar.app"

	[ "$(uname -s)" = Darwin ] || fail "this installs the macOS app; on Windows run: irm https://hangar.odahcam.com/install.ps1 | iex"
	[ "$(uname -m)" = arm64 ] || fail "Hangar needs a Mac with Apple Silicon"
	major=$(sw_vers -productVersion | cut -d. -f1)
	[ "$major" -ge 13 ] || fail "Hangar needs macOS 13 or later"
	[ -w /Applications ] || fail "/Applications isn't writable by $(id -un)"

	tmp=$(mktemp -d)
	trap 'rm -rf "$tmp"' EXIT
	echo "Downloading Hangar ${VERSION}…"
	curl -fL --progress-bar -o "$tmp/Hangar.zip" "$repo"
	echo "$SHA256  $tmp/Hangar.zip" | shasum -a 256 -c -s || fail "Hangar.zip doesn't match the expected SHA-256; nothing was installed"
	ditto -x -k "$tmp/Hangar.zip" "$tmp"
	[ -d "$tmp/Hangar.app" ] || fail "the download has no Hangar.app"

	# An update: the running app is asked to quit before its bundle is replaced.
	if pgrep -xq Hangar; then
		echo "Quitting the running Hangar…"
		osascript -e 'quit app "Hangar"' >/dev/null 2>&1 || true
		sleep 2
	fi
	rm -rf "$dest"
	mv "$tmp/Hangar.app" "$dest"
	xattr -dr com.apple.quarantine "$dest" 2>/dev/null || true

	echo "Hangar ${VERSION} is in /Applications. Opening it…"
	open "$dest"
}

fail() {
	echo "hangar install: $1" >&2
	exit 1
}

main "$@"
