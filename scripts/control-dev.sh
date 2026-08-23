#!/usr/bin/env bash
# Start control plane (serves API + dashboard) and Vite dev server in the foreground.
# Stop with Ctrl+C — both processes are killed together.
# Dev ports default to 4201 (control plane) and 5173 (Vite with HMR); Vite
# proxies /api to the control plane. Override either with BANTER_DEV_CONTROL_PORT /
# VITE_PORT if those are taken on your machine.
# Tailscale Serve exposes Vite on that port for mobile access over HTTPS.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
# Defines BANTER_PROD — where the deployment (and so the live config) lives.
source "$REPO/scripts/deploy-env.sh"
VITE_PORT="${VITE_PORT:-5173}"
BANTER_DEV_CONTROL_PORT="${BANTER_DEV_CONTROL_PORT:-4201}"

cleanup() {
  echo ""
  echo "[dev] Stopping dev servers..."

  # Tear down tailscale serve for the dev server
  tailscale serve --bg --https="$VITE_PORT" off 2>/dev/null || true

  # Kill background jobs from this script
  kill $(jobs -p) 2>/dev/null || true
  wait 2>/dev/null || true

  exit
}

trap cleanup INT TERM

# Clear any stale tailscale serve on the dev port BEFORE starting Vite
tailscale serve --bg --https="$VITE_PORT" off 2>/dev/null || true

# Clean up any lingering processes on dev ports only — do not touch prod port (4200)
# since Tailscale Serve may have a listener there. Skipped without lsof; a
# lingering process just fails the port bind below instead, with its own error.
if command -v lsof >/dev/null 2>&1; then
  for port in "$BANTER_DEV_CONTROL_PORT" "$VITE_PORT"; do
    if lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "[dev] Cleaning up lingering process on port $port..."
      lsof -iTCP:"$port" -sTCP:LISTEN | grep -v COMMAND | awk '{print $2}' | xargs -r kill -9 2>/dev/null || true
    fi
  done
fi

# Dev reads and writes the same live config as production. The repo's
# config.json is the tracked template and the deploy source; it is never read at
# runtime. Deploy is what copies template → live, and asks before overwriting.
CONFIG_LIVE="$BANTER_PROD/control/control-plane/data/config.json"
if [ ! -f "$CONFIG_LIVE" ]; then
  echo "[dev] No live config at $CONFIG_LIVE — run scripts/control-deploy.sh first." >&2
  exit 1
fi

# The registry is live state too — services are enabled, patched, and had their
# ports changed through the API, and all of that lands in the deployed copy. The
# control plane defaults it relative to its own source, so without this dev runs
# the deployed config against the repo's registry and disagrees with production
# about which services exist. Every other script here defaults to $PROD; match
# them.
REGISTRY_LIVE="$BANTER_PROD/control/control-plane/data/registry.json"
if [ ! -f "$REGISTRY_LIVE" ]; then
  echo "[dev] No live registry at $REGISTRY_LIVE — run scripts/control-deploy.sh first." >&2
  exit 1
fi

# Secrets referenced from config.json as ${VAR}. Production gets these from the
# platform.service drop-in; dev reads the same values from a file kept outside
# the repo so nothing secret is ever in the tree.
SECRETS_ENV="$BANTER_PROD/.env.secrets"
if [ -f "$SECRETS_ENV" ]; then
  set -a; source "$SECRETS_ENV"; set +a
else
  echo "[dev] No $SECRETS_ENV — gateway features will be unavailable." >&2
fi

echo "[dev] Starting control plane (port $BANTER_DEV_CONTROL_PORT) and Vite (port $VITE_PORT)..."

# Dev writes its own event log. The default lives in the production deployment
# tree, and health state is derived from the most recent event per service — so
# without this, dev health checks decide what production reports.
DEV_EVENTS="$REPO/control/control-plane/data/events.dev.jsonl"

(cd "$REPO/control" && DEBUG=1 BANTER_CONTROL_PORT="$BANTER_DEV_CONTROL_PORT" BANTER_CONFIG_PATH="$CONFIG_LIVE" BANTER_REGISTRY_PATH="$REGISTRY_LIVE" BANTER_EVENTS_PATH="$DEV_EVENTS" DASHBOARD_DIST="$REPO/dashboard/dist" bun run --watch control-plane/src/index.ts) &
(cd "$REPO/dashboard" && VITE_PROXY_TARGET="http://localhost:$BANTER_DEV_CONTROL_PORT" bun run dev -- --strictPort) &

# Wait for Vite to bind before setting up tailscale serve
echo "[dev] Waiting for Vite to start on port $VITE_PORT..."
for i in $(seq 1 30); do
  if ss -tln | grep -q ":${VITE_PORT} "; then
    break
  fi
  sleep 0.5
done

# Enable tailscale serve for Vite — mobile can access via https://<your-host>.your-tailnet.ts.net:5173
echo "[dev] Enabling tailscale serve on port $VITE_PORT"
tailscale serve --bg --https="$VITE_PORT" localhost:"$VITE_PORT" 2>/dev/null || true

wait
