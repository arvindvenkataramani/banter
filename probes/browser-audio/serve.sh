#!/usr/bin/env bash
# Serve the browser-audio probe.
#
# A microphone (getUserMedia) only works on a secure page: https, or
# http://localhost on the same machine. So:
#
#   - With Tailscale, the probe is served over HTTPS at this machine's tailnet
#     name, which any device on the tailnet (a phone included) can open.
#   - Without it, the probe is served on http://localhost only. That is enough
#     for a desktop browser on this machine; a phone needs HTTPS some other way
#     (see README.md).
#
# Port 5199 is the probes' own, clear of the dashboard's dev server (5173) and
# the control plane (4200, 4201 in dev). Override with PROBE_PORT.
#
# The Tailscale Serve entry is released before binding and on exit: an active
# entry on the port stops the local server binding it.
set -euo pipefail

PORT="${PROBE_PORT:-5199}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v python3 >/dev/null 2>&1; then
  echo "serve.sh: python3 is needed to serve the probe's files." >&2
  exit 1
fi

use_tailscale=false
if [[ "${PROBE_LOCAL_ONLY:-}" != "1" ]] && command -v tailscale >/dev/null 2>&1 \
   && tailscale status --json >/dev/null 2>&1; then
  use_tailscale=true
fi

release_serve() {
  if $use_tailscale; then
    tailscale serve --https="$PORT" off 2>/dev/null || true
  fi
}

release_serve
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$DIR" &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true; release_serve' EXIT

sleep 1
echo
if $use_tailscale; then
  tailscale serve --bg --https="$PORT" "http://127.0.0.1:$PORT"
  host="$(tailscale status --json | jq -r '.Self.DNSName | rtrimstr(".")')"
  echo "  https://$host:$PORT/   (any device on your tailnet)"
  echo "  http://localhost:$PORT/   (this machine)"
else
  echo "  http://localhost:$PORT/   (this machine only)"
  echo
  echo "  Served without HTTPS, so a phone can't use its microphone here."
  echo "  See README.md for ways to get HTTPS without Tailscale."
fi
echo
echo "Ctrl-C to stop."
wait $SERVER
