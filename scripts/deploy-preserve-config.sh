#!/usr/bin/env bash
# Carry a deployment's live configuration across a deploy.
#
# The plane's config.json and registry.json live inside the deployed tree, and
# the deploy removes that tree before copying a fresh one into place. Neither
# file is tracked — only an example of each is — so a deploy from a clean
# extraction of the main line would copy examples over both, and the deployed
# system would come back up describing nothing it was actually running.
#
# So: set the live files aside before the removal, put them back after the copy.
# An example survives only where there was no live file, which is a first deploy.
#
# Usage:
#   deploy-preserve-config.sh save    <dest> <stash>
#   deploy-preserve-config.sh restore <dest> <stash>
#
# Deliberately nothing else. No comparison against the example, no reporting of
# settings a new release added, no merge. A deploy that leaves configuration
# exactly as it found it is the whole requirement.
#
# Nothing here is an error worth failing a deploy over: a missing destination, a
# missing file, and an empty stash all mean "first deploy" and exit 0.
set -uo pipefail

DATA_REL="control/control-plane/data"
FILES=("config.json" "registry.json")

ACTION="${1:-}"
DEST="${2:-}"
STASH="${3:-}"

if [[ -z "$ACTION" || -z "$DEST" || -z "$STASH" ]]; then
  echo "[preserve-config] usage: deploy-preserve-config.sh {save|restore} <dest> <stash>" >&2
  exit 2
fi

case "$ACTION" in
  save)
    # What is actually at risk. Nothing here means a first deploy: nothing to
    # preserve, and nothing to ask about.
    live=()
    for f in "${FILES[@]}"; do
      [[ -f "$DEST/$DATA_REL/$f" ]] && live+=("$f")
    done

    if [[ ${#live[@]} -eq 0 ]]; then
      echo "[preserve-config] no live configuration at $DEST — the shipped examples will be used."
      exit 0
    fi

    # Preserving is the default. Replacing is available but must be chosen, and
    # a session with nobody to ask must never take silence for consent — the
    # deploy runs unattended from cron and from `control-deploy.sh main`.
    reset="${BANTER_RESET_CONFIG:-}"

    if [[ -z "$reset" && -t 0 ]]; then
      echo ""
      echo "Live configuration found at $DEST:"
      printf '  %s\n' "${live[@]}"
      echo ""
      echo "  1) keep it (recommended)"
      echo "  2) replace it with the shipped examples"
      read -rp "Choice [1/2]: " choice
      [[ "$choice" == "2" ]] && reset=1
    fi

    if [[ -n "$reset" ]]; then
      echo "[preserve-config] replacing live configuration with the shipped examples."
      exit 0
    fi

    for f in "${live[@]}"; do
      mkdir -p "$STASH"
      cp -p "$DEST/$DATA_REL/$f" "$STASH/$f"
      echo "[preserve-config] saved $f"
    done
    ;;

  restore)
    for f in "${FILES[@]}"; do
      src="$STASH/$f"
      if [[ -f "$src" ]]; then
        mkdir -p "$DEST/$DATA_REL"
        cp -p "$src" "$DEST/$DATA_REL/$f"
        echo "[preserve-config] restored $f"
      fi
    done
    ;;

  *)
    echo "[preserve-config] unknown action '$ACTION' — expected save or restore" >&2
    exit 2
    ;;
esac

exit 0
