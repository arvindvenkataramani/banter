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

# The shard's half of the same idea, deployed with launchd on a worker Mac.
# Lowercase `services`, matching the plane: on a case-sensitive filesystem
# `~/Services` is a different directory, and the shard's own path resolution
# prefers the lowercase spelling.
BANTER_SHARD_PROD="${BANTER_SHARD_PROD:-$HOME/services/banter}"
BANTER_SHARD_SERVICES_DEST="${BANTER_SHARD_SERVICES_DEST:-$HOME/services}"

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
