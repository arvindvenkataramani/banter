#!/usr/bin/env bash
# Build the FluidServer binaries (services/fluid) in this repo's working tree,
# then wrap each in an .app bundle so it carries a bundle identifier.
#
# Builds only. Installing them is control-install-services.sh on a single
# machine, or shard-install-services.sh on a shard; both read the fluid-stt and
# fluid-tts entries' ops.install from that node's registry:
#
#   scripts/fluid-build.sh && scripts/control-install-services.sh
#
# The servers read the roster section of the deployed registry, so a change to
# the roster's shape ships with a deploy and a server build.
#
# Checked before the build starts, each printing what is missing and the
# command that installs it: Apple Silicon, macOS 15+, a Swift 6 toolchain, and
# libopus. A build that fails partway through leaves the package half-built;
# failing fast here means every failure looks the same, an actionable message
# and a non-zero exit, rather than a wall of clang errors deep in COpus.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE="$REPO/services/fluid"

ARCH="$(uname -m)"
if [[ "$ARCH" != "arm64" ]]; then
  echo "[fluid-build] error: Apple Silicon required (uname -m reported '$ARCH')." >&2
  echo "[fluid-build]        The FluidServer binaries only build and run on arm64 Macs." >&2
  exit 1
fi

MACOS_VERSION="$(sw_vers -productVersion 2>/dev/null || echo 0)"
if [[ "${MACOS_VERSION%%.*}" -lt 15 ]]; then
  echo "[fluid-build] error: macOS 15 or later required (found $MACOS_VERSION)." >&2
  echo "[fluid-build]        Update macOS, then re-run this script." >&2
  exit 1
fi

if ! command -v swift >/dev/null 2>&1; then
  echo "[fluid-build] error: no Swift toolchain found." >&2
  echo "[fluid-build]        Install: xcode-select --install" >&2
  exit 1
fi
SWIFT_VERSION_OUTPUT="$(swift --version 2>&1)"
if ! grep -q "Swift version 6" <<<"$SWIFT_VERSION_OUTPUT"; then
  echo "[fluid-build] error: Swift 6 toolchain required. Found:" >&2
  echo "[fluid-build]        $SWIFT_VERSION_OUTPUT" >&2
  echo "[fluid-build]        Install Xcode 16 or later, or: xcode-select --install" >&2
  exit 1
fi

if ! command -v brew >/dev/null 2>&1; then
  echo "[fluid-build] error: Homebrew not found, needed to check for libopus." >&2
  echo "[fluid-build]        Install: /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"" >&2
  exit 1
fi
if [[ ! -f "$(brew --prefix)/lib/pkgconfig/opus.pc" ]]; then
  echo "[fluid-build] error: libopus not found." >&2
  echo "[fluid-build]        Install: brew install opus" >&2
  exit 1
fi

echo "[fluid-build] Building $PACKAGE..."
swift build -c release --package-path "$PACKAGE"

# Same "<commit>[-dirty]" computation install-artifacts.sh uses for
# SOURCE-COMMIT.txt, so each bundle's CFBundleVersion always agrees with the
# installed binary's own record of what it was built from.
commit="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
if [[ -n "$(git -C "$REPO" status --porcelain 2>/dev/null)" ]]; then
  commit="$commit-dirty"
fi
version="$(<"$PACKAGE/VERSION")"

# Assemble each bundle fresh so a rebuild fully replaces whatever the last one
# left behind, rather than layering a new executable under a stale plist.
for name in fluid-stt fluid-tts; do
  bundle="$PACKAGE/.build/release/$name.app"
  rm -rf "$bundle"
  mkdir -p "$bundle/Contents/MacOS"
  cp "$PACKAGE/.build/release/$name" "$bundle/Contents/MacOS/$name"
  sed \
    -e "s/__SHORT_VERSION__/$version/" \
    -e "s/__BUILD_VERSION__/$commit/" \
    "$PACKAGE/Resources/$name.plist" > "$bundle/Contents/Info.plist"

  # FluidAudio's SwiftPM resource bundle looks for itself at Bundle.main's
  # resourceURL first, which for an .app is Contents/Resources/ — the bare
  # executable's own directory (its second fallback) no longer is one.
  resource_bundle="$PACKAGE/.build/release/FluidAudio_FluidAudio.bundle"
  if [[ -d "$resource_bundle" ]]; then
    mkdir -p "$bundle/Contents/Resources"
    cp -R "$resource_bundle" "$bundle/Contents/Resources/"
  fi

  codesign --force --sign - --timestamp=none "$bundle"
  echo "[fluid-build] $name.app ($version, $commit)"
done

echo "[fluid-build] Done: $PACKAGE/.build/release/fluid-stt.app, fluid-tts.app"
