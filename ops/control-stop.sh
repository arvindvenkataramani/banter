#!/usr/bin/env bash
# Stop the control plane systemd service (which also serves the dashboard).
set -euo pipefail

source "$(dirname "$0")/deploy-env.sh"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "[control-stop] Stopping $BANTER_UNIT..."
systemctl --user stop "$BANTER_UNIT" 2>/dev/null || true

# Teardown reads the port from the registry rather than repeating a literal —
# the unit's ExecStopPost does the same, so a port change needs one edit.
echo "[control-stop] Tearing down Tailscale Serve..."
bash "$SCRIPT_DIR/control-serve-off.sh" || true

echo "[control-stop] Status:"
systemctl --user is-active --quiet "$BANTER_UNIT" && echo "  $BANTER_UNIT: active" || echo "  $BANTER_UNIT: stopped"
