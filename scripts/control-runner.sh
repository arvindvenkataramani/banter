#!/usr/bin/env bash
# Wrapper for the control plane. Sets up Tailscale Serve, then execs bun.
# systemd sends SIGTERM directly to bun; no signal forwarding needed.
set -euo pipefail

source "$(dirname "$0")/deploy-env.sh"
PROD="$BANTER_PROD"
REGISTRY="${BANTER_REGISTRY_PATH:-$PROD/control/control-plane/data/registry.json}"

# systemd user units run with a minimal PATH, so Homebrew/Linuxbrew installs of
# jq are often not on it. Look there explicitly, but fall back to whatever is on
# PATH rather than pinning one machine's install location.
if command -v jq >/dev/null 2>&1; then
  JQ=jq
elif [[ -x /home/linuxbrew/.linuxbrew/bin/jq ]]; then
  JQ=/home/linuxbrew/.linuxbrew/bin/jq
elif [[ -x /opt/homebrew/bin/jq ]]; then
  JQ=/opt/homebrew/bin/jq
else
  echo "[control-runner] error: jq not found on PATH" >&2
  exit 1
fi

BANTER_CONTROL_PORT=$("$JQ" -r '.services[] | select(.id == "control") | .network.port' "$REGISTRY")

if [[ -z "$BANTER_CONTROL_PORT" || "$BANTER_CONTROL_PORT" == "null" ]]; then
  echo "[control-runner] error: no 'control' service with network.port in $REGISTRY" >&2
  exit 1
fi

# Clear stale Tailscale Serve bindings
tailscale serve --bg --https="$BANTER_CONTROL_PORT" off 2>/dev/null || true

# Set up Tailscale Serve
tailscale serve --bg --https="$BANTER_CONTROL_PORT" localhost:"$BANTER_CONTROL_PORT" 2>/dev/null || true

# Exec into bun — it becomes PID 1 of the service, systemd manages it directly.
# BANTER_CONTROL_PORT is passed explicitly so the server binds the same port we just
# handed to Tailscale Serve, rather than falling back to its own default.
cd "$PROD/control/control-plane"
exec env DASHBOARD_DIST="$PROD/dashboard/dist" BANTER_CONTROL_PORT="$BANTER_CONTROL_PORT" "$HOME/.bun/bin/bun" run src/index.ts
