#!/usr/bin/env bash
# Uninstall the control plane and dashboard from the control machine.
# On systemd, stops and disables the service and removes the unit file. On
# macOS or Linux without systemd — the control-runner.sh fallback path — kills
# the running process instead, since there is no service to stop.
# Either way, removes the deployed files. Reverses exactly what
# control-deploy.sh installed.
set -euo pipefail

source "$(dirname "$0")/deploy-env.sh"
PROD="$BANTER_PROD"
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Tear down Tailscale Serve before the unit file and deployed tree go away —
# control-serve-off.sh reads the port from the registry under $PROD, so it must
# run while both still exist.
echo "[control-uninstall] Tearing down Tailscale Serve..."
bash "$SCRIPT_DIR/control-serve-off.sh" || true

if command -v systemctl >/dev/null 2>&1; then
  echo "[control-uninstall] Stopping service..."
  systemctl --user stop "$BANTER_UNIT" 2>/dev/null || true

  echo "[control-uninstall] Disabling service..."
  systemctl --user disable "$BANTER_UNIT" 2>/dev/null || true

  echo "[control-uninstall] Removing service unit..."
  rm -f "$SYSTEMD_USER_DIR/$BANTER_UNIT.service"
  systemctl --user daemon-reload
else
  # No systemd — the control-runner.sh fallback path from the README's macOS
  # section. There is no service to stop, and control-runner.sh execs into bun
  # (replacing itself), so the running process is just "bun run src/index.ts" —
  # too generic a command line to pkill -f safely; it could match an unrelated
  # bun process. Its listening port is unique, so find it by that instead.
  echo "[control-uninstall] No systemd — stopping the control plane by its port..."
  REGISTRY="${BANTER_REGISTRY_PATH:-$PROD/control/control-plane/data/registry.json}"
  if [[ -f "$REGISTRY" ]] && command -v jq >/dev/null 2>&1; then
    PORT="$(jq -r '.services[] | select(.id == "control") | .network.port' "$REGISTRY" 2>/dev/null || true)"
    if [[ -n "$PORT" && "$PORT" != "null" ]] && command -v lsof >/dev/null 2>&1; then
      lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | xargs -r kill 2>/dev/null || true
    fi
  fi
fi

echo "[control-uninstall] Removing deployed files..."
rm -rf "$PROD"

echo "[control-uninstall] Done. Run control-deploy.sh to reinstall."
