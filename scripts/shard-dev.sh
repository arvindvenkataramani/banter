#!/usr/bin/env bash
# Start control shard (API only) in the foreground, on the same port as production (4200).
# Automatically stops production agents on start and re-enables them on exit.
# Stop with Ctrl+C.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
source "$REPO/ops/deploy-env.sh"
# The live registry, where the shard reads it (the repo has only an example).
REGISTRY="$BANTER_SHARD_REGISTRY_PATH"
[[ -f "$REGISTRY" ]] || { echo "[shard-dev] error: no shard registry at $REGISTRY — the next shard-deploy.sh creates it; see docs/guide/shard.md" >&2; exit 1; }
UID_NUM="$(id -u)"
AGENTS_DIR="$HOME/Library/LaunchAgents"

# Read shard port from registry
SHARD_PORT=$(awk '
  /"id": *"control-shard",/ { found = 1 }
  found && /"port":/ { gsub(/[^0-9]/, "", $2); print $2; exit }
' "$REGISTRY")

# One cleanup for every way out — Ctrl+C, a signal, or a failure under set -e —
# so production is never left stopped. It runs once: the exit it ends with fires
# the EXIT trap again.
CLEANED=""
cleanup() {
  [[ -n "$CLEANED" ]] && return
  CLEANED=1

  echo ""
  echo "[shard-dev] Stopping dev server..."

  # Tear down tailscale serve for the shard
  tailscale serve --bg --https="$SHARD_PORT" off 2>/dev/null || true

  # Kill background jobs from this script
  kill $(jobs -p) 2>/dev/null || true

  # Wait for them to exit
  wait 2>/dev/null || true

  # Re-enable production if the plist is deployed — check actual state, not a flag
  if [[ -f "$AGENTS_DIR/${SHARD_LABEL}.plist" ]]; then
    echo "[shard-dev] Plist is installed — restoring production agent..."
    "$REPO/ops/shard-start.sh"
  else
    echo "[shard-dev] Plist not installed — skipping production restore."
  fi

  exit
}

trap cleanup EXIT INT TERM

# Stop production — always, regardless of whether it appears to be running.
# Covers both launchd agents and any stale tailscale serve bindings.
"$REPO/ops/shard-stop.sh"

echo "[shard-dev] Starting control shard..."

(cd "$REPO/control" && BANTER_SHARD_REGISTRY_PATH="$REGISTRY" bun run --watch control-shard/src/index.ts) &

# Enable tailscale serve for the shard
echo "[shard-dev] Enabling tailscale serve on port $SHARD_PORT"
tailscale serve --bg --https="$SHARD_PORT" localhost:"$SHARD_PORT" 2>/dev/null || true

wait
