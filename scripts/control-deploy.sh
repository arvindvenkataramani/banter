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
# The repo's config.example.json and registry.example.json are merged field by
# field into the live directory ($BANTER_LIVE_DIR, the deployed folder itself)
# before anything is stopped. Changed only in the repo, the repo's value is
# taken; changed only on this node, the node's value stays; changed on both to
# different values, the deploy stops and names the fields. There is no prompt.
#
# First-time setup:
#   loginctl enable-linger $USER
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
source "$(dirname "$0")/deploy-env.sh"
PROD="$BANTER_PROD"
SCRIPTS_DIR="$REPO/scripts"

# Temporary directories to remove on exit. Bash keeps only one EXIT trap, so
# every temporary directory registers in this list rather than installing its
# own trap and silently replacing the others.
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
  FORCE_REF="$arg"
done

if [[ -n "$FORCE_REF" ]]; then
  if [[ "$FORCE_REF" == "main" ]]; then
    SRC=$(platform_stage_dir); CLEANUP_DIRS+=("$SRC")
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
        *) SRC=$(platform_stage_dir); CLEANUP_DIRS+=("$SRC")
           echo "[control-deploy] Extracting main from git archive..."
           git -C "$REPO" archive main | tar -x -C "$SRC"
           ;;
      esac
    else
      echo "[control-deploy] Non-interactive session: defaulting to main."
      SRC=$(platform_stage_dir); CLEANUP_DIRS+=("$SRC")
      echo "[control-deploy] Extracting main from git archive..."
      git -C "$REPO" archive main | tar -x -C "$SRC"
    fi
  elif [[ $STATUS -ge 2 ]]; then
    echo "[control-deploy] Branch state undetermined. Proceeding with working tree."
  fi
fi

echo "[control-deploy] Building dashboard..."
if [[ "$SRC" != "$REPO" ]]; then
  echo "[control-deploy] Installing build dependencies..."
  (cd "$SRC" && bun install)
fi
cd "$SRC/dashboard"
bun run build

# Merge the repo's example configuration into the live directory while the old
# control plane is still running; a conflict leaves everything untouched. A first
# deploy starts from the files an older layout kept under
# $PROD/control/control-plane/data/, where they exist, and otherwise from the
# examples.
OLD_DATA="$PROD/control/control-plane/data"
LEGACY_ARGS=()
[[ -f "$OLD_DATA/config.json" ]]   && LEGACY_ARGS+=(--legacy-config "$OLD_DATA/config.json")
[[ -f "$OLD_DATA/registry.json" ]] && LEGACY_ARGS+=(--legacy-registry "$OLD_DATA/registry.json")
echo "[control-deploy] Merging configuration into $BANTER_LIVE_DIR..."
if ! bun "$SRC/control/scripts/deploy-config.ts" plane "$BANTER_LIVE_DIR" "$SRC/control/control-plane/data" ${LEGACY_ARGS+"${LEGACY_ARGS[@]}"}; then
  echo "[control-deploy] Configuration merge failed — nothing was stopped or changed." >&2
  exit 1
fi

echo "[control-deploy] Stopping control plane..."
systemctl --user stop "$BANTER_UNIT" 2>/dev/null || true

# A failure from here on brings the old control plane back, then removes the
# temporary directories.
restart_on_failure() {
  local rc=$?
  if [[ $rc -ne 0 ]]; then
    echo "[control-deploy] Deploy failed — restarting $BANTER_UNIT." >&2
    systemctl --user start "$BANTER_UNIT" 2>/dev/null || true
  fi
  cleanup
  exit $rc
}
trap restart_on_failure EXIT

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
# control-plane/data holds only the field reference; the live files are in the live directory.
mkdir -p "$PROD/control/control-plane/data"
cp    "$SRC/control/control-plane/data/config.md" "$PROD/control/control-plane/data/config.md"
cp    "$SRC/control/control-plane/package.json"  "$PROD/control/control-plane/package.json"

# dashboard — built assets only (served directly by control plane)
mkdir -p "$PROD/dashboard"
cp -r "$SRC/dashboard/dist"          "$PROD/dashboard/dist"

cp -r "$SRC/ops"          "$PROD/ops"
cp -r "$SRC/scripts"      "$PROD/scripts"
# deploy.conf is untracked, so a deploy from main has none in its stage. It stays
# in the checkout because it names this folder; the copy lets the deployed
# scripts, which systemd runs, read the same settings.
if [[ -f "$SCRIPTS_DIR/deploy.conf" ]]; then
  cp "$SCRIPTS_DIR/deploy.conf" "$PROD/scripts/deploy.conf"
fi
# Strip the dashboard and voice-engine workspaces from package.json — only the built dist is deployed
bun -e "const p = JSON.parse(require('fs').readFileSync('$SRC/package.json','utf8')); p.workspaces = p.workspaces.filter(w => w !== 'dashboard' && w !== 'voice-engine'); require('fs').writeFileSync('$PROD/package.json', JSON.stringify(p, null, 2))"
cp    "$SRC/tsconfig.json"   "$PROD/tsconfig.json"
cp    "$SRC/bun.lock"        "$PROD/bun.lock" 2>/dev/null || true

echo "[control-deploy] Installing dependencies..."
cd "$PROD"
bun install

# Mark this tree as ours so a later deploy's preflight can tell its own output
# from an unrelated system occupying the same path.
printf '{"project":"banter","deployedAt":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$PROD/.banter-deploy.json"

echo "[control-deploy] Making wrapper scripts executable..."
chmod +x "$PROD/scripts/"*.sh

echo "[control-deploy] Installing service units and scripts..."
# A deploy from main installs no built artifacts: its git archive holds none.
# A service install that needs attention must not stop the control plane from
# coming back up; it is reported at the end.
INSTALL_FAILED=false
INSTALL_ARGS=("$SRC")
[[ "$SRC" != "$REPO" ]] && INSTALL_ARGS=(--no-artifacts "$SRC")
bash "$PROD/scripts/control-install-services.sh" "${INSTALL_ARGS[@]}" || INSTALL_FAILED=true

echo "[control-deploy] Starting control plane..."
systemctl --user daemon-reload
systemctl --user enable "$BANTER_UNIT"
systemctl --user restart "$BANTER_UNIT"

echo "[control-deploy] Status:"
systemctl --user is-active --quiet "$BANTER_UNIT" && echo "  control plane: active" || echo "  control plane: FAILED"
if $INSTALL_FAILED; then
  echo "[control-deploy] Done, but a service install needs attention — see the [install] errors above." >&2
  exit 1
fi
echo "[control-deploy] Done."
