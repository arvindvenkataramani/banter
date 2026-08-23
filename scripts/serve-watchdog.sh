#!/usr/bin/env bash
# Serve watchdog: ensure every service marked `tailscaleServe: true` in the
# registry has a live Tailscale Serve entry on its port. Restore any missing.
# Intended to run via cron every minute.
set -euo pipefail

export PATH="$HOME/.npm-global/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"

source "$(dirname "$0")/deploy-env.sh"
REGISTRY="${BANTER_REGISTRY_PATH:-$BANTER_PROD/control/control-plane/data/registry.json}"
STATUS=$(tailscale serve status 2>/dev/null || true)

# Extract (port) pairs for services on this host with tailscaleServe=true.
ports=$(jq -r '
  .services[]
  | select(.network.tailscaleServe == true)
  | select(.network.port)
  | "\(.id)\t\(.network.port)"
' "$REGISTRY")

restored=0
while IFS=$'\t' read -r id port; do
  [ -z "$port" ] && continue
  if ! grep -q ":${port}\b" <<<"$STATUS"; then
    echo "[serve-watchdog] ${id}: port ${port} serve entry missing — re-adding..."
    tailscale serve --bg --https="${port}" "http://localhost:${port}" >/dev/null 2>&1 || {
      echo "[serve-watchdog] ${id}: re-add failed"
    }
    restored=$((restored+1))
  fi
done <<<"$ports"

[ "$restored" -gt 0 ] && echo "[serve-watchdog] restored ${restored} serve entr{y,ies}"
exit 0
