#!/usr/bin/env bash
# Start the control plane systemd unit ($BANTER_UNIT), which also serves the
# dashboard. Requires control-deploy.sh to have been run first.
set -euo pipefail

source "$(dirname "$0")/deploy-env.sh"
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"

if [[ ! -f "$SYSTEMD_USER_DIR/$BANTER_UNIT.service" ]]; then
  echo "[control-start] error: $BANTER_UNIT.service not found — run control-deploy.sh first" >&2
  exit 1
fi

echo "[control-start] Starting $BANTER_UNIT..."
systemctl --user restart "$BANTER_UNIT"

echo "[control-start] Status:"
systemctl --user is-active --quiet "$BANTER_UNIT" && echo "  $BANTER_UNIT: active" || echo "  $BANTER_UNIT: FAILED"
