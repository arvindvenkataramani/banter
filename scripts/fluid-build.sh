#!/usr/bin/env bash
# Build the FluidServer binaries (services/fluid) in this repo's working tree.
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

MACOS_VERSION="$(sw_vers -productVersion)"
MACOS_MAJOR="${MACOS_VERSION%%.*}"
if [[ "$MACOS_MAJOR" -lt 15 ]]; then
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
  echo "[fluid-build]        Install: xcode-select --install" >&2
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
echo "[fluid-build] Done: $PACKAGE/.build/release/fluid-stt, fluid-tts"
