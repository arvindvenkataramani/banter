#!/usr/bin/env bash
# First-time setup: everything the README's Install section covers up through
# a running, reachable control plane. Speech models are the next step after
# this and are intentionally not automated here — see the README's "Choose
# and install speech models" section once this script finishes.
#
# Usage: scripts/install.sh
#
# Run from the repo root, after cloning. Prompts for the OpenClaw gateway URL
# and token; everything else follows the README's defaults.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

log() { echo "[install] $*"; }
die() { echo "[install] error: $*" >&2; exit 1; }

# --- prerequisites -----------------------------------------------------------

command -v bun >/dev/null 2>&1 || die "bun is required — https://bun.sh"
command -v jq  >/dev/null 2>&1 || die "jq is required"

OS="$(uname -s)"
case "$OS" in
  Linux)
    command -v systemctl >/dev/null 2>&1 || die "systemd (systemctl) not found — this script's Linux path needs it. Follow the README's manual macOS/no-systemd path instead."
    ;;
  Darwin)
    log "macOS detected. The systemd install step is expected to fail here — see the README's \"macOS, or Linux without systemd\" section, which this script follows."
    ;;
  *)
    die "unsupported OS '$OS' — follow the README's manual install steps instead."
    ;;
esac

# --- set up the control plane -------------------------------------------------

log "Installing dependencies..."
bun install

# The VAD + turn-detection assets are committed, so this only re-verifies them
# against their pinned hashes. A failure here means a bad or missing file, not a
# missing download — worth reporting, but not worth failing the install over.
log "Verifying VAD + turn-detection model assets..."
(cd dashboard && bun run setup) || log "warning: model asset verification failed — voice may not work until this is resolved. Continuing."

# --- configure it --------------------------------------------------------------

REGISTRY="control/control-plane/data/registry.json"
CONFIG="control/control-plane/data/config.json"

if [[ -f "$REGISTRY" || -f "$CONFIG" ]]; then
  log "control/control-plane/data/{registry,config}.json already exist — leaving them as-is."
else
  cp control/control-plane/data/registry.example.json "$REGISTRY"
  cp control/control-plane/data/config.example.json    "$CONFIG"
  log "Created registry.json and config.json from the shipped examples."

  GATEWAY_URL="${OPENCLAW_GATEWAY_URL:-}"
  GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-}"

  if [[ -z "$GATEWAY_URL" || -z "$GATEWAY_TOKEN" ]]; then
    if [[ -t 0 ]]; then
      echo ""
      [[ -z "$GATEWAY_URL" ]]   && read -rp "OpenClaw gateway URL (e.g. wss://your-gateway.example.com): " GATEWAY_URL
      [[ -z "$GATEWAY_TOKEN" ]] && read -rsp "OpenClaw gateway token: " GATEWAY_TOKEN && echo ""
    else
      die "no gateway URL/token supplied and this isn't an interactive session. Set OPENCLAW_GATEWAY_URL and OPENCLAW_GATEWAY_TOKEN, or run interactively."
    fi
  fi

  [[ -n "$GATEWAY_URL" ]]   || die "gateway URL cannot be empty"
  [[ -n "$GATEWAY_TOKEN" ]] || die "gateway token cannot be empty"

  TMP_CONFIG="$(mktemp)"
  jq --arg url "$GATEWAY_URL" --arg token "$GATEWAY_TOKEN" \
    '.integrations.openclaw.gateway.url = $url | .integrations.openclaw.gateway.token = $token' \
    "$CONFIG" > "$TMP_CONFIG"
  mv "$TMP_CONFIG" "$CONFIG"
  log "Wrote gateway URL and token to $CONFIG."
fi

log "registry.json is left at its shipped defaults — the control plane itself doesn't need any speech services to start. Add those after this script finishes."

# --- install as a service -------------------------------------------------------

BANTER_PORT="$(jq -r '.services[] | select(.id == "control") | .network.port' "$REGISTRY")"
[[ -n "$BANTER_PORT" && "$BANTER_PORT" != "null" ]] || die "could not read the control plane's port from $REGISTRY"

case "$OS" in
  Linux)
    log "Enabling linger (keeps the service running when you're not logged in)..."
    loginctl enable-linger "$USER" 2>/dev/null || log "warning: loginctl enable-linger failed — the service may stop when you log out. Continuing."

    log "Deploying..."
    scripts/control-deploy.sh

    log "Waiting for the control plane to respond on :$BANTER_PORT..."
    for _ in $(seq 1 30); do
      curl -sf "http://localhost:$BANTER_PORT/api/health" >/dev/null 2>&1 && break
      sleep 1
    done
    curl -sf "http://localhost:$BANTER_PORT/api/health" >/dev/null 2>&1 \
      || die "control plane did not come up on :$BANTER_PORT. Check 'systemctl --user status banter' and 'journalctl --user -u banter'."
    ;;

  Darwin)
    log "Deploying (the systemd step is expected to fail here)..."
    scripts/control-deploy.sh || true

    PROD="$HOME/services/banter"
    [[ -f "$PROD/scripts/control-runner.sh" ]] || die "deploy did not produce $PROD — check the output above for a real failure, not just the expected systemd one."

    log "Starting the control plane in the background..."
    nohup "$PROD/scripts/control-runner.sh" > "$PROD/install-run.log" 2>&1 &
    RUNNER_PID=$!
    log "Started control-runner.sh (pid $RUNNER_PID). This does not survive a reboot or logout —"
    log "see the README's \"macOS, or Linux without systemd\" section for supervising it yourself"
    log "(a launchd agent, or whatever you use)."

    log "Waiting for the control plane to respond on :$BANTER_PORT..."
    UP=""
    for _ in $(seq 1 30); do
      if curl -sf "http://localhost:$BANTER_PORT/api/health" >/dev/null 2>&1; then
        UP=1
        break
      fi
      sleep 1
    done
    [[ -n "$UP" ]] || die "control plane did not come up on :$BANTER_PORT. Check $PROD/install-run.log."
    ;;
esac

# --- done -------------------------------------------------------------------

echo ""
log "Control plane is running: http://localhost:$BANTER_PORT"
log "Next: pick and build speech models, then add them to $REGISTRY and restart."
log "See the README's \"Choose and install speech models\" section — docs/models.md is the fastest path in."
