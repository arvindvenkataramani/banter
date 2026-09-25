#!/usr/bin/env bash
# Where each half of banter deploys to, and what it calls itself. Sourced by
# every script that installs, runs, stops, or removes either half.
#
# The defaults describe an ordinary deployment, so nothing needs to be set for
# one. To install somewhere else, copy deploy.conf.example to deploy.conf and
# edit it — that file is per-machine and untracked, so the setting survives
# every deploy and never has to be retyped or exported.
#
# Precedence: environment > deploy.conf > defaults. The environment wins so a
# one-off (a staging deploy, a test) does not require editing the file, and so
# CI can set the values without one.
#
# This file is sourced, never executed: it defines values and does nothing else.

# Per-machine overrides, if present. Sourced before the defaults below so its
# assignments become the ${VAR:-default} fallbacks rather than being overwritten
# by them.
__deploy_conf="$(dirname "${BASH_SOURCE[0]}")/deploy.conf"
if [[ -f "$__deploy_conf" ]]; then
  # Environment wins: stash anything already set, source, then put it back.
  __env_prod="${BANTER_PROD:-}"; __env_unit="${BANTER_UNIT:-}"
  __env_shard="${BANTER_SHARD_PROD:-}"; __env_shard_dest="${BANTER_SHARD_SERVICES_DEST:-}"
  # shellcheck source=/dev/null
  source "$__deploy_conf"
  [[ -n "$__env_prod" ]] && BANTER_PROD="$__env_prod"
  [[ -n "$__env_unit" ]] && BANTER_UNIT="$__env_unit"
  [[ -n "$__env_shard" ]] && BANTER_SHARD_PROD="$__env_shard"
  [[ -n "$__env_shard_dest" ]] && BANTER_SHARD_SERVICES_DEST="$__env_shard_dest"
  unset __env_prod __env_unit __env_shard __env_shard_dest
fi
unset __deploy_conf

# The control plane, deployed with systemd on the primary machine.
BANTER_PROD="${BANTER_PROD:-$HOME/services/banter}"
BANTER_UNIT="${BANTER_UNIT:-banter}"
# The control plane's event log, for artifact installs.
BANTER_EVENTS_PATH="${BANTER_EVENTS_PATH:-$BANTER_PROD/logs/events.jsonl}"

# The shard's half of the same idea, deployed with launchd on a worker Mac.
# Lowercase `services`, matching the plane: on a case-sensitive filesystem
# `~/Services` is a different directory, and the shard's own path resolution
# prefers the lowercase spelling.
BANTER_SHARD_PROD="${BANTER_SHARD_PROD:-$HOME/services/banter}"
BANTER_SHARD_SERVICES_DEST="${BANTER_SHARD_SERVICES_DEST:-$HOME/services}"
# The shard's event log, where installs are recorded alongside everything else.
# Same variable the shard itself reads.
BANTER_SHARD_EVENTS_PATH="${BANTER_SHARD_EVENTS_PATH:-$BANTER_SHARD_PROD/logs/events.jsonl}"

# A non-default directory under the default unit name is the one combination
# that silently misbehaves: the deploy writes new files while every start, stop,
# and restart keeps addressing the original install. Catch it here, where both
# values are known, rather than in each script that uses them.
if [[ "$BANTER_PROD" != "$HOME/services/banter" && "$BANTER_UNIT" == "banter" ]]; then
  echo "[deploy-env] error: BANTER_PROD is set to a non-default directory but" >&2
  echo "[deploy-env]        BANTER_UNIT is still 'banter'. Set both, or neither:" >&2
  echo "[deploy-env]          $BANTER_PROD" >&2
  echo "[deploy-env]        systemctl --user restart banter would act on the" >&2
  echo "[deploy-env]        default install, not this one." >&2
  return 1 2>/dev/null || exit 1
fi

# A non-interactive ssh session gets no login profile, so on the Pi neither bun
# nor jq is on PATH and every deploy script calling them bare fails. Append the
# usual install locations after whatever PATH already holds, so a working PATH
# still wins and a bare one still finds them.
for _platform_dir in "$HOME/.bun/bin" /home/linuxbrew/.linuxbrew/bin /opt/homebrew/bin /usr/local/bin /usr/bin /bin; do
  if [[ -d "$_platform_dir" && ":$PATH:" != *":$_platform_dir:"* ]]; then
    PATH="$PATH:$_platform_dir"
  fi
done
unset _platform_dir
export PATH

# systemd user units run with a minimal PATH, so a wrapper started by systemd
# cannot assume its tools are on it. Resolve one, preferring whatever is on PATH
# and falling back to the usual install locations. Pinning a single absolute
# path works only on the machine it was written on, and under `set -euo
# pipefail` a missing interpreter kills the service at startup.
platform_find_tool() {
  local tool="$1"; shift
  local candidate
  if candidate="$(command -v "$tool" 2>/dev/null)"; then
    echo "$candidate"
    return 0
  fi
  for candidate in "$@"; do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done
  echo "error: $tool not found on PATH or in the usual install locations" >&2
  return 1
}

platform_find_jq() {
  platform_find_tool jq \
    /home/linuxbrew/.linuxbrew/bin/jq /opt/homebrew/bin/jq /usr/local/bin/jq /usr/bin/jq
}

platform_find_bun() {
  platform_find_tool bun \
    "$HOME/.bun/bin/bun" /home/linuxbrew/.linuxbrew/bin/bun /opt/homebrew/bin/bun /usr/local/bin/bun
}
