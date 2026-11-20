#!/usr/bin/env bash
# Wrapper for the control plane. Sets up Tailscale Serve, then execs bun.
# systemd sends SIGTERM directly to bun; no signal forwarding needed.
set -euo pipefail

source "$(dirname "$0")/deploy-env.sh"
PROD="$BANTER_PROD"
REGISTRY="$BANTER_REGISTRY_PATH"

# systemd user units run with a minimal PATH, so jq and bun are found the way
# the deploy scripts find them: on PATH, then the usual install locations.
JQ="$(platform_find_jq)" || exit 1
BUN="$(platform_find_bun)" || exit 1

BANTER_CONTROL_PORT=$("$JQ" -r '.services[] | select(.id == "control") | .network.port' "$REGISTRY")

if [[ -z "$BANTER_CONTROL_PORT" || "$BANTER_CONTROL_PORT" == "null" ]]; then
  echo "[control-runner] error: no 'control' service with network.port in $REGISTRY" >&2
  exit 1
fi

# Clear stale Tailscale Serve bindings
tailscale serve --bg --https="$BANTER_CONTROL_PORT" off 2>/dev/null || true

# Set up Tailscale Serve
tailscale serve --bg --https="$BANTER_CONTROL_PORT" localhost:"$BANTER_CONTROL_PORT" 2>/dev/null || true

# Managed services run their startCmd/healthCmd through `sh -c`, inheriting this
# process's PATH. systemd's user PATH omits the Homebrew prefixes, so a registry
# entry calling a tool installed there fails with "not found". Put the resolved
# tools' directories on PATH so the whole tree can reach them, not just this
# wrapper.
PATH="$(dirname "$JQ"):$(dirname "$BUN"):$PATH"
export PATH

# Exec into bun — it becomes PID 1 of the service, systemd manages it directly.
# BANTER_CONTROL_PORT is passed explicitly so the server binds the same port we just
# handed to Tailscale Serve, rather than falling back to its own default.
cd "$PROD/control/control-plane"
exec env DASHBOARD_DIST="$PROD/dashboard/dist" BANTER_CONTROL_PORT="$BANTER_CONTROL_PORT" \
  BANTER_LIVE_DIR="$BANTER_LIVE_DIR" BANTER_REGISTRY_PATH="$BANTER_REGISTRY_PATH" BANTER_CONFIG_PATH="$BANTER_CONFIG_PATH" \
  "$BUN" run src/index.ts
