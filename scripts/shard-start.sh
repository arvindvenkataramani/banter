#!/usr/bin/env bash
# Bootstrap the shard launchd agent (production).
# Tailscale serve is managed by the Swift runner (shard-runner), not this script.
# Requires the shard to already be deployed (plists installed via shard-deploy.sh).
set -euo pipefail

AGENTS_DIR="$HOME/Library/LaunchAgents"
SHARD_LABEL="com.banter.control-shard"
UID_NUM="$(id -u)"

# Fail fast if shard is not deployed
if [[ ! -f "$AGENTS_DIR/${SHARD_LABEL}.plist" ]]; then
  echo "[shard] error: ${SHARD_LABEL}.plist not found — run shard-deploy.sh first" >&2
  exit 1
fi

# Bootstrap the agent if it is not already loaded.
# The Swift runner (shard-runner) owns tailscale serve — it sets it up on start.
if ! launchctl list 2>/dev/null | grep -q "$SHARD_LABEL"; then
  echo "[shard] Bootstrapping agent..."
  launchctl enable "gui/$UID_NUM/$SHARD_LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_NUM" "$AGENTS_DIR/${SHARD_LABEL}.plist" 2>/dev/null || true
else
  echo "[shard] Agent already loaded."
fi

echo "[shard] Agent status:"
launchctl list | grep "$SHARD_LABEL" || echo "  (agent not loaded)"
echo "[shard] Done."
