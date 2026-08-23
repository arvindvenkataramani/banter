#!/usr/bin/env bash
# Deploy the control plane to $BANTER_PROD on the control machine. Builds and
# bundles the dashboard, installs the systemd unit, and starts it.
# Run from anywhere on the control machine.
#
# Usage:
#   control-deploy.sh           — check branch status, prompt if dev is ahead
#   control-deploy.sh main      — deploy from main without prompting
#   control-deploy.sh dev       — deploy from working tree without prompting
#
# The deployed config.json and registry.json are kept across a deploy. Add
# --reset-config to replace them with the shipped examples instead; an
# interactive deploy asks before doing so, and an unattended one always keeps
# them.
#
# First-time setup:
#   loginctl enable-linger $USER
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
source "$(dirname "$0")/deploy-env.sh"
PROD="$BANTER_PROD"
SCRIPTS_DIR="$REPO/scripts"

# Temporary directories to remove on exit. Bash keeps only one EXIT trap, and
# this script makes two kinds of temp directory — an extracted source tree and a
# config stash — so they share one trap over a list rather than each installing
# its own and silently replacing the other.
CLEANUP_DIRS=()
cleanup() {
  for d in ${CLEANUP_DIRS+"${CLEANUP_DIRS[@]}"}; do
    rm -rf "$d"
  done
}
trap cleanup EXIT

# Refuse before anything is modified if the destination belongs to something
# else. This runs first: before the branch check, the build, and any copy.
bash "$SCRIPTS_DIR/deploy-preflight.sh" "$BANTER_PROD" || {
  echo "[control-deploy] Aborted by preflight." >&2
  exit 1
}

# Determine deploy source
SRC="$REPO"
FORCE_REF=""
for arg in "$@"; do
  case "$arg" in
    # Replace the deployed config and registry with the shipped examples instead
    # of keeping them. Without this the live files are preserved, and an
    # interactive deploy asks before doing anything else.
    --reset-config) export BANTER_RESET_CONFIG=1 ;;
    *) FORCE_REF="$arg" ;;
  esac
done

if [[ -n "$FORCE_REF" ]]; then
  if [[ "$FORCE_REF" == "main" ]]; then
    SRC=$(mktemp -d); CLEANUP_DIRS+=("$SRC")
    echo "[control-deploy] Extracting main from git archive..."
    git -C "$REPO" archive main | tar -x -C "$SRC"
  elif [[ "$FORCE_REF" != "dev" ]]; then
    echo "[control-deploy] Unknown ref '$FORCE_REF'. Use 'main' or 'dev'." >&2
    exit 1
  fi
else
  # No ref given — check branch status and prompt if needed
  STATUS=0
  bash "$SCRIPTS_DIR/branch-status.sh" || STATUS=$?

  # 1 = not on the main line, worth confirming. 2 = could not tell, which is
  # not an error: proceed with what is checked out.
  if [[ $STATUS -eq 1 ]]; then
    if [[ -t 0 ]]; then
      echo ""
      echo "Deploy from:"
      echo "  1) main — last merged state (recommended)"
      echo "  2) dev  — current dev branch (includes unmerged commits above)"
      echo "  3) abort"
      read -rp "Choice [1/2/3]: " choice
      case "$choice" in
        2) ;;
        3) echo "[control-deploy] Aborted."; exit 0 ;;
        *) SRC=$(mktemp -d); CLEANUP_DIRS+=("$SRC")
           echo "[control-deploy] Extracting main from git archive..."
           git -C "$REPO" archive main | tar -x -C "$SRC"
           ;;
      esac
    else
      echo "[control-deploy] Non-interactive session: defaulting to main."
      SRC=$(mktemp -d); CLEANUP_DIRS+=("$SRC")
      echo "[control-deploy] Extracting main from git archive..."
      git -C "$REPO" archive main | tar -x -C "$SRC"
    fi
  elif [[ $STATUS -ge 2 ]]; then
    echo "[control-deploy] Branch state undetermined. Proceeding with working tree."
  fi
fi

echo "[control-deploy] Generating API docs..."
cd "$REPO" && bun run docs || echo "[control-deploy] Warning: docs generation failed (non-blocking)"

echo "[control-deploy] Building dashboard..."
if [[ "$SRC" != "$REPO" ]]; then
  echo "[control-deploy] Installing build dependencies..."
  (cd "$SRC" && bun install)
fi
cd "$SRC/dashboard"
bun run build

echo "[control-deploy] Stopping control plane..."
systemctl --user stop "$BANTER_UNIT" 2>/dev/null || true

# Set the live config and registry aside before the tree they live in is
# removed. The stash is outside $PROD deliberately — anywhere inside it would be
# removed along with everything else.
CONFIG_STASH="$(mktemp -d "${TMPDIR:-/tmp}/banter-config-stash.XXXXXX")"
CLEANUP_DIRS+=("$CONFIG_STASH")
bash "$SCRIPTS_DIR/deploy-preserve-config.sh" save "$PROD" "$CONFIG_STASH"

echo "[control-deploy] Copying files to $PROD..."
mkdir -p "$PROD" "$PROD/control"
rm -rf "$PROD/shared" "$PROD/control/shared" "$PROD/control/control-plane" "$PROD/dashboard" "$PROD/ops" "$PROD/scripts"

# shared types
cp -r "$SRC/shared"                  "$PROD/shared"

# control/shared — runtime source only (no tests)
mkdir -p "$PROD/control/shared"
cp -r "$SRC/control/shared/src"          "$PROD/control/shared/src"
cp    "$SRC/control/shared/package.json" "$PROD/control/shared/package.json"
cp    "$SRC/control/package.json"        "$PROD/control/package.json"

# control-plane — runtime source and registry only (no tests, no ops)
mkdir -p "$PROD/control/control-plane"
cp -r "$SRC/control/control-plane/src"           "$PROD/control/control-plane/src"
cp -r "$SRC/control/control-plane/data"          "$PROD/control/control-plane/data"
cp    "$SRC/control/control-plane/package.json"  "$PROD/control/control-plane/package.json"

# dashboard — built assets only (served directly by control plane)
mkdir -p "$PROD/dashboard"
cp -r "$SRC/dashboard/dist"          "$PROD/dashboard/dist"

cp -r "$SRC/ops"          "$PROD/ops"
cp -r "$SRC/scripts"      "$PROD/scripts"
# Strip dashboard workspace from package.json — only dist is deployed, not the full package
bun -e "const p = JSON.parse(require('fs').readFileSync('$SRC/package.json','utf8')); p.workspaces = p.workspaces.filter(w => w !== 'dashboard'); require('fs').writeFileSync('$PROD/package.json', JSON.stringify(p, null, 2))"
cp    "$SRC/tsconfig.json"   "$PROD/tsconfig.json"
cp    "$SRC/bun.lock"        "$PROD/bun.lock" 2>/dev/null || true

# Put the live config and registry back over the examples the copy just laid
# down. Where there was nothing to save, the examples stand — a first deploy.
bash "$SCRIPTS_DIR/deploy-preserve-config.sh" restore "$PROD" "$CONFIG_STASH"

echo "[control-deploy] Installing dependencies..."
cd "$PROD"
bun install

# Mark this tree as ours so a later deploy's preflight can tell its own output
# from an unrelated system occupying the same path.
printf '{"project":"banter","deployedAt":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$PROD/.banter-deploy.json"

echo "[control-deploy] Making wrapper scripts executable..."
chmod +x "$PROD/scripts/"*.sh

echo "[control-deploy] Installing service units and scripts..."
bash "$PROD/scripts/control-install-services.sh" "$SRC"

echo "[control-deploy] Starting control plane..."
systemctl --user daemon-reload
systemctl --user enable "$BANTER_UNIT"
systemctl --user restart "$BANTER_UNIT"

echo "[control-deploy] Status:"
systemctl --user is-active --quiet "$BANTER_UNIT" && echo "  control plane: active" || echo "  control plane: FAILED"
echo "[control-deploy] Done."
