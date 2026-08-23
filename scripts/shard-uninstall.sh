#!/usr/bin/env bash
# Uninstall the control shard from the worker machine (Mac).
# Tears down tailscale serve, stops and removes launchd agents, removes deployed files.
set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPTS_DIR/deploy-env.sh"
PROD="$BANTER_SHARD_PROD"
LAUNCHD_AGENTS_DIR="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"
SHARD_LABEL="com.banter.control-shard"

echo "[shard-uninstall] Tearing down tailscale serve..."
"$SCRIPTS_DIR/shard-stop.sh"

echo "[shard-uninstall] Removing launchd agent..."
launchctl disable "gui/$UID_NUM/$SHARD_LABEL" 2>/dev/null || true
launchctl bootout "gui/$UID_NUM" "$LAUNCHD_AGENTS_DIR/${SHARD_LABEL}.plist" 2>/dev/null || true

echo "[shard-uninstall] Removing plist file..."
rm -f "$LAUNCHD_AGENTS_DIR/${SHARD_LABEL}.plist"

echo "[shard-uninstall] Removing deployed files..."
rm -rf "$PROD"

echo "[shard-uninstall] Done. Run shard-deploy.sh to reinstall."
