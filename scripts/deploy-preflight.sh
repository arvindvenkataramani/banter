#!/usr/bin/env bash
# Check that a deploy destination is safe to write to, before anything is written.
#
# The deploy removes directories and restarts a system service. Both are
# destructive, and neither is recoverable by re-running the command. This runs
# first and refuses when the destination belongs to something else.
#
# Usage: deploy-preflight.sh <destination-directory>
#
# Exit codes:
#   0 — safe to proceed
#   non-zero — refused; nothing was modified
#
# Environment:
#   BANTER_DEPLOY_FORCE=1   proceed anyway, logging that the check was overridden
#   BANTER_UNIT             systemd unit name to check (default: banter)
#   BANTER_SKIP_UNIT_CHECK  skip the unit check (used by tests)
#
# This script only inspects. It creates, moves, and deletes nothing, and never
# reads standard input — a refusal is a refusal, not a prompt.
set -uo pipefail

MARKER=".banter-deploy.json"
BANTER_UNIT="${BANTER_UNIT:-banter}"
FORCE="${BANTER_DEPLOY_FORCE:-}"

DEST="${1:-}"

if [[ -z "$DEST" ]]; then
  echo "[preflight] usage: deploy-preflight.sh <destination-directory>" >&2
  exit 2
fi

# Refuse, unless explicitly forced. Takes the reason as its argument.
refuse() {
  local reason="$1"
  if [[ -n "$FORCE" ]]; then
    echo "[preflight] WARNING: $reason"
    echo "[preflight] BANTER_DEPLOY_FORCE is set — overriding the refusal and proceeding."
    return 0
  fi
  echo "[preflight] refusing: $reason" >&2
  echo "[preflight] set BANTER_DEPLOY_FORCE=1 to override if this is really what you want." >&2
  exit 1
}

# --- destination ------------------------------------------------------------

if [[ ! -e "$DEST" ]]; then
  echo "[preflight] destination $DEST does not exist yet — safe to create."
elif [[ ! -d "$DEST" ]]; then
  refuse "$DEST exists and is not a directory."
elif [[ -z "$(ls -A "$DEST" 2>/dev/null)" ]]; then
  echo "[preflight] destination $DEST is empty — safe to use."
elif [[ -f "$DEST/$MARKER" ]]; then
  # A previous deploy left its mark. Confirm it was ours before overwriting.
  PROJECT=""
  if command -v jq >/dev/null 2>&1; then
    PROJECT="$(jq -r '.project // empty' "$DEST/$MARKER" 2>/dev/null || true)"
  else
    PROJECT="$(grep -o '"project"[[:space:]]*:[[:space:]]*"[^"]*"' "$DEST/$MARKER" 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)"$/\1/' || true)"
  fi

  if [[ "$PROJECT" == "banter" ]]; then
    echo "[preflight] destination $DEST was created by a previous banter deploy — safe to update."
  else
    refuse "$DEST carries a deployment marker for project '${PROJECT:-unknown}', not banter."
  fi
else
  refuse "$DEST is not empty and was not created by banter — it may belong to another deployment."
fi

# --- systemd unit -----------------------------------------------------------

if [[ -z "${BANTER_SKIP_UNIT_CHECK:-}" ]]; then
  UNIT_FILE="$HOME/.config/systemd/user/$BANTER_UNIT.service"
  if [[ -f "$UNIT_FILE" ]]; then
    EXEC_START="$(grep -m1 '^ExecStart=' "$UNIT_FILE" 2>/dev/null | cut -d= -f2- || true)"
    # systemd expands %h to the user's home directory. Expand it here too, or a
    # unit that legitimately points inside the destination reads as a conflict.
    EXEC_START="${EXEC_START//\%h/$HOME}"
    # A unit under our name that runs something outside the destination is a
    # different deployment wearing the same name. Restarting it would act on a
    # system this deploy does not own.
    if [[ -n "$EXEC_START" && "$EXEC_START" != "$DEST"* ]]; then
      refuse "systemd unit '$BANTER_UNIT' already exists and runs $EXEC_START, which is outside $DEST."
    fi
    echo "[preflight] systemd unit '$BANTER_UNIT' exists and points inside $DEST — safe to restart."
  else
    echo "[preflight] systemd unit '$BANTER_UNIT' is not installed yet — safe to create."
  fi
fi

echo "[preflight] OK — safe to deploy to $DEST"
exit 0
