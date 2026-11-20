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

# The shard's Serve port is its registry entry's port, as in shard-dev.sh and
# shard-runner; 4200 when the registry has none.
SHARD_PORT=""
if [[ -f "$BANTER_SHARD_REGISTRY_PATH" ]]; then
  SHARD_PORT=$(awk '
    /"id": *"control-shard",/ { found = 1 }
    found && /"port":/ { gsub(/[^0-9]/, "", $2); print $2; exit }
  ' "$BANTER_SHARD_REGISTRY_PATH")
fi
SHARD_PORT="${SHARD_PORT:-4200}"

echo "[shard] Tearing down Tailscale Serve on port $SHARD_PORT..."
tailscale serve --bg --https="$SHARD_PORT" off 2>/dev/null || true

echo "[shard] Stopped. Run 'ops/shard-start.sh' to re-enable."
