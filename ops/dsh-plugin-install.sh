#!/usr/bin/env bash
# Install the dsh voice plugin into DeepSeek Harness profiles, pointed at a
# Banter server:
#
#   ops/dsh-plugin-install.sh <banter-url> [--profile <name>]... [--link]
#
# With no --profile, every profile under $DSH_HOME/profiles (~/.dsh by default):
# `desktop` is the desktop app's, `web` is `dsh web`'s. Builds the plugin,
# installs a copy of it into each profile (--link links this checkout's build
# instead, for development), and sets the plugin's Banter server URL there,
# keeping its keep-voice-on setting. Checks that Banter answers first. dsh
# loads the plugin when the profile next starts. Runs from a checkout with
# `bun install` done; the work is plugins/dsh/voice/scripts/install-dsh.ts.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
exec bun "$REPO/plugins/dsh/voice/scripts/install-dsh.ts" "$@"
