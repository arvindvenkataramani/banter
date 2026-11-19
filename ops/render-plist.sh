#!/usr/bin/env bash
# Render a launchd plist template, substituting the deploying user's home
# directory for __HOME__.
#
# launchd has no equivalent of systemd's %h and will not expand ~ or $HOME, so
# the installed file must carry absolute paths. Tracking a template and
# rendering it at deploy time keeps one machine's paths out of the repository
# without pretending launchd can resolve something it cannot.
#
# Usage: render-plist.sh <template> <output>
set -euo pipefail

TEMPLATE="${1:-}"
OUTPUT="${2:-}"

if [[ -z "$TEMPLATE" || -z "$OUTPUT" ]]; then
  echo "[render-plist] usage: render-plist.sh <template> <output>" >&2
  exit 2
fi

if [[ ! -f "$TEMPLATE" ]]; then
  echo "[render-plist] template not found: $TEMPLATE" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT")"
sed "s|__HOME__|${HOME}|g" "$TEMPLATE" > "$OUTPUT"

# A leftover placeholder means launchd would be handed a path that cannot
# resolve, which fails at load time with a message that does not mention this.
if grep -q "__HOME__" "$OUTPUT"; then
  echo "[render-plist] error: $OUTPUT still contains __HOME__ after substitution" >&2
  exit 1
fi

echo "[render-plist] rendered $(basename "$OUTPUT")"
