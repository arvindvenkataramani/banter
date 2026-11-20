#!/usr/bin/env bash
# Remove the dsh voice plugin from DeepSeek Harness profiles:
#
#   ops/dsh-plugin-uninstall.sh [--profile <name>]...
#
# With no --profile, every profile under $DSH_HOME/profiles (~/.dsh by default).
# Removes the plugin package and its settings entry from each, leaving the
# rest of the profile as it was. Reverses ops/dsh-plugin-install.sh.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
exec bun "$REPO/plugins/dsh/voice/scripts/install-dsh.ts" --uninstall "$@"
