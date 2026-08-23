#!/usr/bin/env bash
# Deploy control shard to the worker machine (Mac). Builds and bundles the dashboard.
# Run from anywhere on the Mac.
#
# Usage:
#   shard-deploy.sh           — check branch status, prompt if dev is ahead
#   shard-deploy.sh main      — deploy from main without prompting
#   shard-deploy.sh dev       — deploy from working tree without prompting
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
source "$(dirname "$0")/deploy-env.sh"
PROD="$BANTER_SHARD_PROD"
LAUNCHD_AGENTS_DIR="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"
SHARD_LABEL="com.banter.control-shard"
SCRIPTS_DIR="$REPO/scripts"

# Determine deploy source
SRC="$REPO"
FORCE_REF="${1:-}"

if [[ -n "$FORCE_REF" ]]; then
  if [[ "$FORCE_REF" == "main" ]]; then
    SRC=$(mktemp -d)
    trap "rm -rf '$SRC'" EXIT
    echo "[shard-deploy] Extracting main from git archive..."
    git -C "$REPO" archive main | tar -x -C "$SRC"
  elif [[ "$FORCE_REF" != "dev" ]]; then
    echo "[shard-deploy] Unknown ref '$FORCE_REF'. Use 'main' or 'dev'." >&2
    exit 1
  fi
else
  # No ref given — check branch status and prompt if needed
  STATUS=0
  bash "$SCRIPTS_DIR/branch-status.sh" || STATUS=$?

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
        3) echo "[shard-deploy] Aborted."; exit 0 ;;
        *) SRC=$(mktemp -d); trap "rm -rf '$SRC'" EXIT
           echo "[shard-deploy] Extracting main from git archive..."
           git -C "$REPO" archive main | tar -x -C "$SRC"
           ;;
      esac
    else
      echo "[shard-deploy] Non-interactive session: defaulting to main."
      SRC=$(mktemp -d); trap "rm -rf '$SRC'" EXIT
      echo "[shard-deploy] Extracting main from git archive..."
      git -C "$REPO" archive main | tar -x -C "$SRC"
    fi
  elif [[ $STATUS -ge 2 ]]; then
    echo "[shard-deploy] Warning: unexpected branch state. Proceeding with working tree."
  fi
fi

echo "[shard-deploy] Building dashboard..."
if [[ "$SRC" != "$REPO" ]]; then
  echo "[shard-deploy] Installing build dependencies..."
  (cd "$SRC" && bun install)
fi
cd "$SRC/dashboard"
bun run build

# Compile Swift supervisor — always from $SRC source, output to $SRC so it gets copied
SWIFT_SRC="$SRC/control/control-shard/ops/shard-runner.swift"
INFO_PLIST="$SRC/control/control-shard/ops/Info.plist"
RUNNER_BIN="$SRC/control/control-shard/ops/shard-runner"

echo "[shard-deploy] Compiling shard-runner..."
swiftc "$SWIFT_SRC" -o "$RUNNER_BIN" \
  -Xlinker -sectcreate \
  -Xlinker __TEXT \
  -Xlinker __info_plist \
  -Xlinker "$INFO_PLIST"
codesign --sign - --force "$RUNNER_BIN"
echo "[shard-deploy]   compiled and ad-hoc signed"

echo "[shard-deploy] Stopping control shard..."
launchctl bootout "gui/$UID_NUM" "$LAUNCHD_AGENTS_DIR/${SHARD_LABEL}.plist" 2>/dev/null || true

echo "[shard-deploy] Copying files to $PROD..."
mkdir -p "$PROD"
rm -rf "$PROD/shared" "$PROD/control" "$PROD/dashboard"
cp -r "$SRC/shared"                "$PROD/shared"
mkdir -p "$PROD/control"
cp -r "$SRC/control/shared"        "$PROD/control/shared"
cp -r "$SRC/control/control-shard" "$PROD/control/control-shard"
cp    "$SRC/control/package.json"  "$PROD/control/package.json"
mkdir -p "$PROD/dashboard"
cp -r "$SRC/dashboard/dist"        "$PROD/dashboard/dist"
# Strip dashboard workspace from package.json — only dist is deployed, not the full package
bun -e "const p = JSON.parse(require('fs').readFileSync('$SRC/package.json','utf8')); p.workspaces = p.workspaces.filter(w => w !== 'dashboard'); require('fs').writeFileSync('$PROD/package.json', JSON.stringify(p, null, 2))"
cp    "$SRC/tsconfig.json"         "$PROD/tsconfig.json"
cp    "$SRC/bun.lock"              "$PROD/bun.lock" 2>/dev/null || true

echo "[shard-deploy] Setting permissions..."
chmod +x "$PROD/control/control-shard/ops/shard-runner"

echo "[shard-deploy] Syncing service scripts..."
bash "$SRC/scripts/shard-install-services.sh" "$SRC"

echo "[shard-deploy] Installing dependencies..."
cd "$PROD"
bun install

echo "[shard-deploy] Rendering and installing launchd plist..."
mkdir -p "$LAUNCHD_AGENTS_DIR"
# The tracked file is a template — launchd will not expand ~ or $HOME, so the
# installed copy is rendered with this machine's home directory.
bash "$SCRIPTS_DIR/render-plist.sh" \
  "$PROD/control/control-shard/ops/com.banter.control-shard.plist.template" \
  "$LAUNCHD_AGENTS_DIR/${SHARD_LABEL}.plist"

echo "[shard-deploy] Starting control shard..."
launchctl bootstrap "gui/$UID_NUM" "$LAUNCHD_AGENTS_DIR/${SHARD_LABEL}.plist" 2>/dev/null || true

sleep 2

echo "[shard-deploy] Status:"
launchctl list | grep "$SHARD_LABEL" && echo "  control shard: active" || echo "  control shard: FAILED (not loaded)"
echo "[shard-deploy] Done."
