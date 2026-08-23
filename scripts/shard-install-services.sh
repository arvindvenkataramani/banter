#!/usr/bin/env bash
# Install launchd agents and sync lifecycle scripts for the control shard (Mac).
# - Reads registry.json to find services with installCommand
# - Copies only the referenced .plist files to ~/Library/LaunchAgents/
# - Copies .sh and .plist files from services/ to ~/Services/ (only where target dir exists)
# - Never touches venvs, app code, or models
#
# Usage:
#   shard-install-services.sh              — install from repo working tree
#   shard-install-services.sh /path/to/src — install from a specific source tree
set -euo pipefail

SRC="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
source "$(dirname "$0")/deploy-env.sh"
REGISTRY="$SRC/control/control-shard/data/registry.json"
SERVICES_SRC="$SRC/services"
SERVICES_DEST="$BANTER_SHARD_SERVICES_DEST"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"

# --- launchd plists (registry-driven) ---
if [[ -f "$REGISTRY" ]]; then
  echo "[install-services] Installing launchd agents..."
  mkdir -p "$LAUNCH_AGENTS"

  # Extract plist paths from services with runner.type == "launchd", except the
  # shard's own agent: that one is rendered from a template by shard-deploy.sh,
  # which installs it directly. Copying it here would install a file still
  # carrying the __HOME__ placeholder.
  jq -r '.services[] | select(.runner.type == "launchd") | select(.id != "control-shard") | .runner.plist // empty' "$REGISTRY" \
    | sort -u \
    | while read -r plist_path; do
        plist=$(basename "$plist_path")
        src="$SRC/$plist_path"
        if [[ -f "$src" ]]; then
          cp "$src" "$LAUNCH_AGENTS/"
          echo "  installed: $plist"
        else
          echo "  skipped (plist file missing): $src"
        fi
      done
fi

# --- service lifecycle scripts ---
if [[ ! -d "$SERVICES_SRC" ]]; then
  echo "[install-services] No services/ directory in $SRC, skipping scripts."
  exit 0
fi

echo "[install-services] Syncing service scripts from $SERVICES_SRC..."

find "$SERVICES_SRC" -type f \( -name '*.sh' -o -name '*.plist' \) | while read -r src_file; do
  rel="${src_file#$SERVICES_SRC/}"
  dest="$SERVICES_DEST/$rel"
  dest_dir="$(dirname "$dest")"

  if [[ -d "$dest_dir" ]]; then
    cp "$src_file" "$dest"
    [[ "$dest" == *.sh ]] && chmod +x "$dest"
    echo "  synced: $rel"
  else
    echo "  skipped (target dir missing): $rel"
  fi
done

# Ensure logs directories exist for each shard-managed service
echo "[install-services] Ensuring logs directories..."
if [[ -f "$REGISTRY" ]]; then
  jq -r '.services[].ops.env.workingDirectory // empty' "$REGISTRY" | while read -r work_dir; do
    if [[ -d "$work_dir" ]]; then
      mkdir -p "$work_dir/logs"
      echo "  logs: $work_dir/logs"
    else
      echo "  skipped (directory missing): $work_dir"
    fi
  done
fi

echo "[install-services] Done."
