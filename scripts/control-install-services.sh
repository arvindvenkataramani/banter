#!/usr/bin/env bash
# Install system service units and sync lifecycle scripts for the control plane.
# - Reads registry.json to find services with runner.type == "systemd"
# - Copies the referenced unit files to ~/.config/systemd/user/
# - Copies .sh scripts from services/ to ~/services/ (only where target dir exists)
# - Never touches venvs, app code, or models
#
# Usage:
#   control-install-services.sh              — install from repo working tree
#   control-install-services.sh /path/to/src — install from a specific source tree
set -euo pipefail

export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"

# Deploy location and unit name. Sourced rather than re-defaulted here, so a
# direct invocation reads deploy.conf exactly as a full deploy does.
source "$(dirname "$0")/deploy-env.sh"
PROD="$BANTER_PROD"
SRC="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
REGISTRY="$SRC/control/control-plane/data/registry.json"
SERVICES_SRC="$SRC/services"
SERVICES_DEST="$HOME/services"
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"

# --- the control plane's own unit ---
# Installed unconditionally, not via the registry-driven loop below. The
# registry describes what the plane *manages*; how the plane itself is run is
# not its own business to declare. A registry that lists the control service as
# `external` — which is correct when something else owns its lifecycle — would
# otherwise leave the deploy with no unit to start.
mkdir -p "$SYSTEMD_USER_DIR"
# The unit is rendered, not copied: it has to name an absolute deploy directory,
# and BANTER_PROD is only known here. systemd's %h expands to the home directory
# but nothing expands BANTER_PROD, so a tracked unit that hardcoded
# %h/services/banter silently ignored a non-default deploy location and started
# the wrong tree — or none. __PROD__ and __UNIT__ carry those values in.
BANTER_CONTROL_UNIT_SRC="$SRC/ops/systemd/banter.service.template"
if [[ -f "$BANTER_CONTROL_UNIT_SRC" ]]; then
  sed -e "s|__PROD__|$PROD|g" -e "s|__UNIT__|$BANTER_UNIT|g" \
    "$BANTER_CONTROL_UNIT_SRC" > "$SYSTEMD_USER_DIR/$BANTER_UNIT.service"
  echo "[install-services] installed control plane unit: $BANTER_UNIT.service ($PROD)"
else
  echo "[install-services] error: control plane unit template not found at $BANTER_CONTROL_UNIT_SRC" >&2
  exit 1
fi

# --- systemd units for managed services (registry-driven) ---
if [[ -f "$REGISTRY" ]]; then
  echo "[install-services] Installing systemd units..."
  mkdir -p "$SYSTEMD_USER_DIR"

  # Extract unitFile paths from services with runner.type == "systemd".
  # Excludes "control": its unit is installed above, filled in rather than
  # copied — this loop would otherwise also copy the raw, unfilled template.
  jq -r '.services[] | select(.runner.type == "systemd" and .id != "control") | .runner.unitFile // empty' "$REGISTRY" \
    | sort -u \
    | while read -r unit_path; do
        unit=$(basename "$unit_path")
        src="$SRC/$unit_path"
        if [[ -f "$src" ]]; then
          cp "$src" "$SYSTEMD_USER_DIR/"
          echo "  installed: $unit"
        else
          echo "  skipped (unit file missing): $src"
        fi
      done

fi

# Reload after any unit changes above — including the control plane's own unit,
# which is installed outside the registry-driven block.
systemctl --user daemon-reload

# --- service lifecycle scripts ---
if [[ ! -d "$SERVICES_SRC" ]]; then
  echo "[install-services] No services/ directory in $SRC, skipping scripts."
  exit 0
fi

echo "[install-services] Syncing service scripts from $SERVICES_SRC..."

find "$SERVICES_SRC" -type f -name '*.sh' | while read -r src_file; do
  rel="${src_file#$SERVICES_SRC/}"
  dest="$SERVICES_DEST/$rel"
  dest_dir="$(dirname "$dest")"

  if [[ -d "$dest_dir" ]]; then
    cp "$src_file" "$dest"
    chmod +x "$dest"
    echo "  synced: $rel"
  else
    echo "  skipped (target dir missing): $rel"
  fi
done

# Ensure logs directories exist for each service
find "$SERVICES_SRC" -mindepth 2 -maxdepth 3 -type d | while read -r src_dir; do
  rel="${src_dir#$SERVICES_SRC/}"
  dest_dir="$SERVICES_DEST/$rel"
  if [[ -d "$dest_dir" ]]; then
    mkdir -p "$dest_dir/logs"
  fi
done

echo "[install-services] Done."
