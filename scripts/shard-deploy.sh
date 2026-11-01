#!/usr/bin/env bash
# Deploy control shard to the worker machine (Mac). API-only: no dashboard is built or served.
# Run from anywhere on the Mac.
#
# Usage:
#   shard-deploy.sh           — check branch status, prompt if dev is ahead
#   shard-deploy.sh main      — deploy from main without prompting
#   shard-deploy.sh dev       — deploy from working tree without prompting
#
# The repo's registry.example.json is merged field by field into the live
# directory ($BANTER_SHARD_LIVE_DIR, the shard's folder itself) before anything
# is stopped. Changed only in the repo, the repo's value is taken; changed only
# on this node, the node's value stays; changed on both to different values, the
# deploy stops and names the fields. There is no prompt.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
source "$(dirname "$0")/deploy-env.sh"
PROD="$BANTER_SHARD_PROD"
LAUNCHD_AGENTS_DIR="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"
SCRIPTS_DIR="$REPO/scripts"

# Temporary directories to remove on exit, under one trap: bash keeps only one
# EXIT trap, so each directory registers here rather than installing its own and
# silently replacing the others (control-deploy.sh does the same).
CLEANUP_DIRS=()
cleanup() {
  for d in ${CLEANUP_DIRS+"${CLEANUP_DIRS[@]}"}; do
    rm -rf "$d"
  done
}
trap cleanup EXIT

# Determine deploy source
SRC="$REPO"
FORCE_REF="${1:-}"

if [[ -n "$FORCE_REF" ]]; then
  if [[ "$FORCE_REF" == "main" ]]; then
    SRC=$(platform_stage_dir); CLEANUP_DIRS+=("$SRC")
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
        *) SRC=$(platform_stage_dir); CLEANUP_DIRS+=("$SRC")
           echo "[shard-deploy] Extracting main from git archive..."
           git -C "$REPO" archive main | tar -x -C "$SRC"
           ;;
      esac
    else
      echo "[shard-deploy] Non-interactive session: defaulting to main."
      SRC=$(platform_stage_dir); CLEANUP_DIRS+=("$SRC")
      echo "[shard-deploy] Extracting main from git archive..."
      git -C "$REPO" archive main | tar -x -C "$SRC"
    fi
  elif [[ $STATUS -ge 2 ]]; then
    echo "[shard-deploy] Warning: unexpected branch state. Proceeding with working tree."
  fi
fi

if [[ "$SRC" != "$REPO" ]]; then
  echo "[shard-deploy] Installing build dependencies..."
  (cd "$SRC" && bun install)
fi

# Compile Swift supervisor — always from $SRC source, output to $SRC so it gets copied
SWIFT_SRC="$SRC/control/control-shard/ops/shard-runner.swift"
INFO_PLIST="$SRC/control/control-shard/ops/Info.plist"
RUNNER_BIN="$SRC/control/control-shard/ops/shard-runner"

echo "[shard-deploy] Compiling shard-runner..."
# Through xcrun: a toolchain binary called by its own path fails to find the SDK's
# standard library.
if ! xcrun -f swiftc >/dev/null 2>&1; then
  echo "[shard-deploy] swiftc not found. Is Xcode or the Xcode Command Line Tools installed and selected (xcode-select -p)?" >&2
  exit 1
fi
xcrun swiftc "$SWIFT_SRC" -o "$RUNNER_BIN" \
  -Xlinker -sectcreate \
  -Xlinker __TEXT \
  -Xlinker __info_plist \
  -Xlinker "$INFO_PLIST"
codesign --sign - --force "$RUNNER_BIN"
echo "[shard-deploy]   compiled and ad-hoc signed"

# Merge the repo's example registry into the live directory while the old shard
# is still running; a conflict leaves everything untouched. A first deploy
# starts from the registry an older layout kept at ~/services/shard/registry.json,
# where there is one, and otherwise from the example.
OLD_REGISTRY="$HOME/services/shard/registry.json"
LEGACY_ARGS=()
[[ -f "$OLD_REGISTRY" ]] && LEGACY_ARGS+=(--legacy-registry "$OLD_REGISTRY")
echo "[shard-deploy] Merging configuration into $BANTER_SHARD_LIVE_DIR..."
if ! bun "$SRC/control/scripts/deploy-config.ts" shard "$BANTER_SHARD_LIVE_DIR" "$SRC/control/control-shard/data" ${LEGACY_ARGS+"${LEGACY_ARGS[@]}"}; then
  echo "[shard-deploy] Configuration merge failed — nothing was stopped or changed." >&2
  exit 1
fi

echo "[shard-deploy] Stopping control shard..."
# bootout returns before the old shard exits, and the shard spends that time
# stopping its services, removing their Serve entries as it goes. Overlapping
# the new shard, it would tear down what the new one registers. Both the runner
# and its shard are waited on: a runner may exit before its shard does.
RUNNER_PID="$(launchctl print "gui/$UID_NUM/$SHARD_LABEL" 2>/dev/null | awk '/^\tpid = /{print $3}' || true)"
OLD_PIDS=""
if [[ -n "$RUNNER_PID" ]]; then
  OLD_PIDS="$RUNNER_PID $(pgrep -P "$RUNNER_PID" || true)"
fi
launchctl bootout "gui/$UID_NUM" "$LAUNCHD_AGENTS_DIR/${SHARD_LABEL}.plist" 2>/dev/null || true

# A failure from here on re-bootstraps the old agent, then removes the
# temporary directories.
restart_on_failure() {
  local rc=$?
  if [[ $rc -ne 0 ]]; then
    echo "[shard-deploy] Deploy failed — restarting the control shard." >&2
    launchctl bootstrap "gui/$UID_NUM" "$LAUNCHD_AGENTS_DIR/${SHARD_LABEL}.plist" 2>/dev/null || true
  fi
  cleanup
  exit $rc
}
trap restart_on_failure EXIT
if [[ -n "$OLD_PIDS" ]]; then
  waited=0
  for pid in $OLD_PIDS; do
    while kill -0 "$pid" 2>/dev/null; do
      if (( waited >= 60 )); then
        echo "[shard-deploy] Old shard (pid $pid) still running after 60s; not deploying over it." >&2
        exit 1
      fi
      sleep 1
      waited=$((waited + 1))
    done
  done
  echo "[shard-deploy]   old shard exited after ${waited}s"
fi

echo "[shard-deploy] Copying files to $PROD..."
mkdir -p "$PROD"
rm -rf "$PROD/shared" "$PROD/control" "$PROD/dashboard"
cp -r "$SRC/shared"                "$PROD/shared"
mkdir -p "$PROD/control"
cp -r "$SRC/control/shared"        "$PROD/control/shared"
cp -r "$SRC/control/control-shard" "$PROD/control/control-shard"
cp    "$SRC/control/package.json"  "$PROD/control/package.json"
# Strip dashboard workspace from package.json — the shard is API-only, no dashboard is built or deployed
bun -e "const p = JSON.parse(require('fs').readFileSync('$SRC/package.json','utf8')); p.workspaces = p.workspaces.filter(w => w !== 'dashboard'); require('fs').writeFileSync('$PROD/package.json', JSON.stringify(p, null, 2))"
cp    "$SRC/tsconfig.json"         "$PROD/tsconfig.json"
cp    "$SRC/bun.lock"              "$PROD/bun.lock" 2>/dev/null || true

echo "[shard-deploy] Setting permissions..."
chmod +x "$PROD/control/control-shard/ops/shard-runner"

echo "[shard-deploy] Installing services..."
# A deploy from main is the shard only: its git archive holds no builds, so
# compiled services are installed from a working tree, after a build.
# The shard is stopped at this point, so a service install that needs attention
# must not stop the deploy from bringing it back; it is reported at the end.
INSTALL_FAILED=false
INSTALL_ARGS=("$SRC")
[[ "$SRC" != "$REPO" ]] && INSTALL_ARGS=(--no-artifacts "$SRC")
bash "$SRC/scripts/shard-install-services.sh" "${INSTALL_ARGS[@]}" || INSTALL_FAILED=true

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
if $INSTALL_FAILED; then
  echo "[shard-deploy] Done, but a service install needs attention — see the [install] errors above." >&2
  exit 1
fi
echo "[shard-deploy] Done."
