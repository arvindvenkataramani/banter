#!/usr/bin/env bash
# Tear down the control plane's Tailscale Serve binding.
#
# Runs as the unit's ExecStopPost. The port is read from the registry — the
# same source control-runner.sh uses to bring the binding up — so moving the
# control plane to another port does not leave a stale listener behind.
set -euo pipefail

source "$(dirname "$0")/deploy-env.sh"
PROD="$BANTER_PROD"
REGISTRY="${BANTER_REGISTRY_PATH:-$PROD/control/control-plane/data/registry.json}"

# systemd user units run with a minimal PATH; see control-runner.sh.
if command -v jq >/dev/null 2>&1; then
  JQ=jq
elif [[ -x /home/linuxbrew/.linuxbrew/bin/jq ]]; then
  JQ=/home/linuxbrew/.linuxbrew/bin/jq
elif [[ -x /opt/homebrew/bin/jq ]]; then
  JQ=/opt/homebrew/bin/jq
else
  echo "[control-serve-off] warning: jq not found; cannot determine port" >&2
  exit 0
fi

BANTER_CONTROL_PORT=$("$JQ" -r '.services[] | select(.id == "control") | .network.port' "$REGISTRY" 2>/dev/null || true)

if [[ -z "$BANTER_CONTROL_PORT" || "$BANTER_CONTROL_PORT" == "null" ]]; then
  echo "[control-serve-off] warning: no control port in $REGISTRY; nothing torn down" >&2
  exit 0
fi

# Teardown is best-effort — a failure here must not mask the unit's exit status.
tailscale serve --bg --https="$BANTER_CONTROL_PORT" off 2>/dev/null || true
