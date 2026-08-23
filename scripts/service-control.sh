#!/usr/bin/env bash
# service-control.sh — manual service lifecycle tool for the platform.
#
# Reads the deployed registry.json to derive commands from the runner schema.
# Works on either node, whichever registry is deployed there.
# This is a backup/diagnostic tool — prefer the control API for normal operations.
#
# Registry path: whichever of the plane/shard registries is actually deployed
# here, rather than inferred from the OS — either node can run on either OS.
# Override with BANTER_REGISTRY_PATH or BANTER_SHARD_REGISTRY_PATH.
#
# Service names use fuzzy matching: "parakeet" matches "stt-parakeet",
# "voxtral" matches "tts-voxtral", etc. Exact matches take priority.
set -euo pipefail

# ── OS detection and registry path ───────────────────────────────────────────

# Probe for a deployed registry instead of guessing from `uname`. A shard can
# run on Linux and a plane on macOS; what decides which node this is, is which
# registry is on disk. `~/Services` is checked for legacy macOS installs.
NODE=""
PROD=""
REGISTRY=""

if [[ -n "${BANTER_REGISTRY_PATH:-}" ]]; then
  REGISTRY="$BANTER_REGISTRY_PATH"
  NODE="control"
elif [[ -n "${BANTER_SHARD_REGISTRY_PATH:-}" ]]; then
  REGISTRY="$BANTER_SHARD_REGISTRY_PATH"
  NODE="shard"
else
  for root in "$HOME/services/banter" "$HOME/Services/banter"; do
    if [[ -f "$root/control/control-plane/data/registry.json" ]]; then
      PROD="$root"
      REGISTRY="$root/control/control-plane/data/registry.json"
      NODE="control"
      break
    elif [[ -f "$root/control/control-shard/data/registry.json" ]]; then
      PROD="$root"
      REGISTRY="$root/control/control-shard/data/registry.json"
      NODE="shard"
      break
    fi
  done
fi

if [[ -z "$REGISTRY" ]]; then
  echo "error: no deployed registry found under ~/services or ~/Services." >&2
  echo "       Set BANTER_REGISTRY_PATH or BANTER_SHARD_REGISTRY_PATH to point at one." >&2
  exit 1
fi

# PROD is unset when the path came from an env var; derive it from the registry.
if [[ -z "$PROD" ]]; then
  PROD="$(cd "$(dirname "$REGISTRY")/../../../.." && pwd)"
fi

# ── Help ─────────────────────────────────────────────────────────────────────

usage() {
  cat <<EOF
service-control.sh — manual service lifecycle tool

Usage:
  service-control.sh <command> <service>
  service-control.sh list

Commands:
  start <service>     Start a service (process/systemd/launchd)
  stop <service>      Stop a service
  restart <service>   Restart a service (native restart or stop+start)
  status <service>    Check if a service is running
  enable <service>    Enable and start a service (persists across reboots)
  disable <service>   Disable and stop a service
  list                List all services in the registry

Options:
  -h, --help          Show this help

Service names use fuzzy matching: "parakeet" matches "stt-parakeet".
Exact ID matches take priority over substring matches.

Node: $NODE
Registry: $REGISTRY
EOF
}

# ── Argument parsing ─────────────────────────────────────────────────────────

if [[ $# -eq 0 ]] || [[ "${1:-}" == "-h" ]] || [[ "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

ACTION="$1"
shift

# ── Registry check ───────────────────────────────────────────────────────────

if [[ ! -f "$REGISTRY" ]]; then
  echo "error: registry not found at $REGISTRY" >&2
  echo "hint: has the platform been deployed? run control-deploy.sh or shard-deploy.sh first." >&2
  exit 1
fi

# ── List command (no service arg needed) ─────────────────────────────────────

if [[ "$ACTION" == "list" ]]; then
  printf "%-20s %-10s %-10s %-6s %s\n" "ID" "RUNNER" "ENABLED" "PORT" "NAME"
  printf "%-20s %-10s %-10s %-6s %s\n" "──────────────────" "────────" "────────" "────" "────"
  jq -r '.services[] | [
    .id,
    (.runner.type // "unknown"),
    (if .permissions.enabled then "yes" else "no" end),
    (.network.port // "-" | tostring),
    (.name // .id)
  ] | @tsv' "$REGISTRY" | while IFS=$'\t' read -r id runner enabled port name; do
    printf "%-20s %-10s %-10s %-6s %s\n" "$id" "$runner" "$enabled" "$port" "$name"
  done
  exit 0
fi

# ── Service argument required from here ──────────────────────────────────────

SERVICE_QUERY="${1:-}"
if [[ -z "$SERVICE_QUERY" ]]; then
  echo "error: missing service name" >&2
  echo "usage: service-control.sh $ACTION <service>" >&2
  echo "run 'service-control.sh list' to see available services" >&2
  exit 1
fi

# ── Fuzzy service matching ───────────────────────────────────────────────────

resolve_service() {
  local query="$1"

  # Try exact match first
  local exact
  exact=$(jq -e --arg id "$query" '.services[] | select(.id == $id) | .id' "$REGISTRY" 2>/dev/null) && {
    echo "$exact" | tr -d '"'
    return 0
  }

  # Substring match (case-insensitive)
  local matches
  matches=$(jq -r --arg q "$query" \
    '[.services[].id | select(ascii_downcase | contains($q | ascii_downcase))] | .[]' \
    "$REGISTRY" 2>/dev/null)

  local count
  count=$(echo "$matches" | grep -c . 2>/dev/null || echo 0)

  if [[ "$count" -eq 1 ]]; then
    echo "$matches"
    return 0
  elif [[ "$count" -gt 1 ]]; then
    echo "error: '$query' matches multiple services:" >&2
    echo "$matches" | sed 's/^/  /' >&2
    return 1
  fi

  # Try matching against .name field too
  matches=$(jq -r --arg q "$query" \
    '[.services[] | select(.name // .id | ascii_downcase | contains($q | ascii_downcase)) | .id] | .[]' \
    "$REGISTRY" 2>/dev/null)

  count=$(echo "$matches" | grep -c . 2>/dev/null || echo 0)

  if [[ "$count" -eq 1 ]]; then
    echo "$matches"
    return 0
  elif [[ "$count" -gt 1 ]]; then
    echo "error: '$query' matches multiple services:" >&2
    echo "$matches" | sed 's/^/  /' >&2
    return 1
  fi

  echo "error: no service matching '$query'" >&2
  return 1
}

SERVICE_ID=$(resolve_service "$SERVICE_QUERY") || exit 1

# ── Extract service config ───────────────────────────────────────────────────

svc_json=$(jq -e --arg id "$SERVICE_ID" '.services[] | select(.id == $id)' "$REGISTRY")

RUNNER_TYPE=$(echo "$svc_json" | jq -r '.runner.type // "external"')
RUNNER_MAIN=$(echo "$svc_json" | jq -r '.runner.main // empty')
RUNNER_UNIT=$(echo "$svc_json" | jq -r '.runner.unit // empty')
RUNNER_LABEL=$(echo "$svc_json" | jq -r '.runner.label // empty')
RUNNER_PLIST=$(echo "$svc_json" | jq -r '.runner.plist // empty')
WORK_DIR=$(echo "$svc_json" | jq -r '.ops.env.workingDirectory // empty')
PORT=$(echo "$svc_json" | jq -r '.network.port // empty')
HEALTH_PATH=$(echo "$svc_json" | jq -r '.network.healthPath // empty')
HEALTH_EXPECT=$(echo "$svc_json" | jq -r '.network.healthExpect // "ok"')
SVC_NAME=$(echo "$svc_json" | jq -r '.name // .id')
ENABLED=$(echo "$svc_json" | jq -r '.permissions.enabled')

# launchd needs uid and plist path
if [[ "$RUNNER_TYPE" == "launchd" ]]; then
  LAUNCHD_GUI="gui/$(id -u)"
  LAUNCHD_PLIST="$HOME/Library/LaunchAgents/${RUNNER_LABEL}.plist"
fi

# ── Helpers ──────────────────────────────────────────────────────────────────

die() { echo "error: $*" >&2; exit 1; }

is_process_running() {
  [[ -n "$RUNNER_MAIN" ]] && pgrep -f "$RUNNER_MAIN" > /dev/null 2>&1
}

is_port_open() {
  [[ -n "$PORT" ]] && command -v lsof >/dev/null 2>&1 && lsof -iTCP:"$PORT" -sTCP:LISTEN -n -P > /dev/null 2>&1
}

wait_for_exit() {
  local tries=0
  while is_process_running && (( tries < 20 )); do
    sleep 0.5
    (( tries++ ))
  done
}

wait_for_port_release() {
  [[ -z "$PORT" ]] && return
  local tries=0
  while is_port_open && (( tries < 20 )); do
    sleep 0.5
    (( tries++ ))
  done
}

check_health() {
  [[ -z "$PORT" || -z "$HEALTH_PATH" ]] && return 0
  local url="http://localhost:${PORT}${HEALTH_PATH}"
  # healthExpect "reachable": any HTTP response counts as alive, for services
  # whose health path answers non-2xx by design (an MCP endpoint returns 406 to
  # a plain GET). Dropping -f is what allows that; curl still fails on a refused
  # connection or timeout, so an unreachable service is still reported down.
  # Must stay in step with healthExpect handling in control/shared/src/health.ts.
  if [[ "$HEALTH_EXPECT" == "reachable" ]]; then
    curl -s --max-time 2 -o /dev/null "$url" 2>/dev/null
  else
    curl -sf --max-time 2 "$url" > /dev/null 2>&1
  fi
}

# ── Runner-specific command execution ────────────────────────────────────────

do_start() {
  case "$RUNNER_TYPE" in
    process)
      [[ -z "$RUNNER_MAIN" ]] && die "process runner has no main command"

      # Kill existing if running
      if is_process_running; then
        echo "  stopping existing process..."
        pkill -f "$RUNNER_MAIN" 2>/dev/null || true
        wait_for_exit
      fi
      wait_for_port_release

      # cd to working directory
      if [[ -n "$WORK_DIR" ]]; then
        cd "$WORK_DIR" || die "cannot cd to $WORK_DIR"
      fi

      # Export env variables from registry
      while IFS='=' read -r key val; do
        [[ -n "$key" ]] && export "$key=$(eval echo "$val")"
      done < <(echo "$svc_json" | jq -r '.ops.env.variables // {} | to_entries[] | "\(.key)=\(.value)"')

      # Start the process
      local log_dir="${WORK_DIR:-/tmp}"
      nohup $RUNNER_MAIN > "$log_dir/server.log" 2>&1 &
      local pid=$!
      echo "  started (pid $pid)"
      ;;

    systemd)
      [[ -z "$RUNNER_UNIT" ]] && die "systemd runner has no unit"
      systemctl --user start "${RUNNER_UNIT}.service"
      echo "  started ${RUNNER_UNIT}.service"
      ;;

    launchd)
      [[ -z "$RUNNER_LABEL" ]] && die "launchd runner has no label"
      launchctl bootstrap "$LAUNCHD_GUI" "$LAUNCHD_PLIST" 2>/dev/null || true
      echo "  bootstrapped $RUNNER_LABEL"
      ;;

    external)
      die "'$SVC_NAME' is an external service — cannot be started by the platform"
      ;;
  esac
}

do_stop() {
  case "$RUNNER_TYPE" in
    process)
      [[ -z "$RUNNER_MAIN" ]] && die "process runner has no main command"
      if is_process_running; then
        pkill -f "$RUNNER_MAIN" 2>/dev/null || true
        wait_for_exit
      fi
      # Also kill anything holding the port
      if [[ -n "$PORT" ]] && command -v lsof >/dev/null 2>&1; then
        local port_pids
        port_pids=$(lsof -ti :"$PORT" 2>/dev/null || true)
        if [[ -n "$port_pids" ]]; then
          echo "$port_pids" | xargs kill 2>/dev/null || true
          wait_for_port_release
        fi
      fi
      echo "  stopped"
      ;;

    systemd)
      [[ -z "$RUNNER_UNIT" ]] && die "systemd runner has no unit"
      systemctl --user stop "${RUNNER_UNIT}.service" 2>/dev/null || true
      echo "  stopped ${RUNNER_UNIT}.service"
      ;;

    launchd)
      [[ -z "$RUNNER_LABEL" ]] && die "launchd runner has no label"
      launchctl bootout "$LAUNCHD_GUI" "$LAUNCHD_PLIST" 2>/dev/null || true
      echo "  booted out $RUNNER_LABEL"
      ;;

    external)
      die "'$SVC_NAME' is an external service — cannot be stopped by the platform"
      ;;
  esac
}

do_restart() {
  case "$RUNNER_TYPE" in
    systemd)
      [[ -z "$RUNNER_UNIT" ]] && die "systemd runner has no unit"
      systemctl --user restart "${RUNNER_UNIT}.service"
      echo "  restarted ${RUNNER_UNIT}.service"
      ;;

    launchd)
      # launchd has no native restart — bootout then bootstrap
      do_stop
      sleep 1
      do_start
      ;;

    process)
      do_stop
      sleep 1
      do_start
      ;;

    external)
      die "'$SVC_NAME' is an external service — cannot be restarted by the platform"
      ;;
  esac
}

do_enable() {
  case "$RUNNER_TYPE" in
    systemd)
      [[ -z "$RUNNER_UNIT" ]] && die "systemd runner has no unit"
      systemctl --user enable --now "${RUNNER_UNIT}.service"
      echo "  enabled ${RUNNER_UNIT}.service"
      ;;

    launchd)
      [[ -z "$RUNNER_LABEL" ]] && die "launchd runner has no label"
      launchctl bootstrap "$LAUNCHD_GUI" "$LAUNCHD_PLIST" 2>/dev/null || true
      echo "  enabled $RUNNER_LABEL"
      ;;

    process)
      do_start
      ;;

    external)
      die "'$SVC_NAME' is an external service — cannot be enabled by the platform"
      ;;
  esac
}

do_disable() {
  case "$RUNNER_TYPE" in
    systemd)
      [[ -z "$RUNNER_UNIT" ]] && die "systemd runner has no unit"
      systemctl --user disable --now "${RUNNER_UNIT}.service"
      echo "  disabled ${RUNNER_UNIT}.service"
      ;;

    launchd)
      [[ -z "$RUNNER_LABEL" ]] && die "launchd runner has no label"
      launchctl bootout "$LAUNCHD_GUI" "$LAUNCHD_PLIST" 2>/dev/null || true
      echo "  disabled $RUNNER_LABEL"
      ;;

    process)
      do_stop
      ;;

    external)
      die "'$SVC_NAME' is an external service — cannot be disabled by the platform"
      ;;
  esac
}

do_status() {
  local running=false

  case "$RUNNER_TYPE" in
    process)
      is_process_running && running=true
      ;;
    systemd)
      systemctl --user is-active --quiet "${RUNNER_UNIT}.service" 2>/dev/null && running=true
      ;;
    launchd)
      launchctl print "$LAUNCHD_GUI/$RUNNER_LABEL" > /dev/null 2>&1 && running=true
      ;;
    external)
      # External services: check health endpoint only
      ;;
  esac

  local health="unknown"
  if check_health; then
    health="healthy"
  elif is_port_open; then
    health="port open, health check failed"
  fi

  echo "  service:  $SERVICE_ID ($SVC_NAME)"
  echo "  runner:   $RUNNER_TYPE"
  echo "  enabled:  $ENABLED"
  echo "  running:  $running"
  echo "  health:   $health"
  [[ -n "$PORT" ]] && echo "  port:     $PORT"
  [[ -n "$WORK_DIR" ]] && echo "  workdir:  $WORK_DIR"

  $running && exit 0 || exit 1
}

# ── Dispatch ─────────────────────────────────────────────────────────────────

echo "[$NODE] $ACTION $SERVICE_ID"

case "$ACTION" in
  start)    do_start ;;
  stop)     do_stop ;;
  restart)  do_restart ;;
  status)   do_status ;;
  enable)   do_enable ;;
  disable)  do_disable ;;
  *)
    echo "error: unknown command '$ACTION'" >&2
    echo "run 'service-control.sh --help' for usage" >&2
    exit 1
    ;;
esac
