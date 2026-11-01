#!/usr/bin/env bash
# Stop and disable the shard launchd agent (production).
# Tailscale serve is torn down by the Swift runner (shard-runner) on SIGTERM.
# Use shard-start.sh to re-enable.
set -euo pipefail

UID_NUM="$(id -u)"
SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPTS_DIR/deploy-env.sh"
AGENTS_DIR="$HOME/Library/LaunchAgents"

echo "[shard] Disabling agent..."
launchctl disable "gui/$UID_NUM/$SHARD_LABEL" 2>/dev/null || true

echo "[shard] Stopping agent..."
launchctl bootout "gui/$UID_NUM" "$AGENTS_DIR/${SHARD_LABEL}.plist" 2>/dev/null || true

echo "[shard] Tearing down Tailscale Serve..."
tailscale serve --bg --https=4200 off 2>/dev/null || true

echo "[shard] Stopped. Run 'scripts/shard-start.sh' to re-enable."
