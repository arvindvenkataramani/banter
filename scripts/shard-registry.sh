#!/usr/bin/env bash
# Where the control shard's live registry is, resolved the way the shard itself
# resolves it (control/control-shard/src/paths.ts: shardRoot and
# resolveShardPaths), so a script and the shard can never read different files.
#
# The registry lives outside the deployed tree, so a deploy cannot overwrite it,
# and it is not tracked — only control/control-shard/data/registry.example.json
# is. That makes the repo checkout and a stage extracted from git the wrong
# places to look for it.
#
# Sourced, never executed. Defines functions only.

# The shard's data root: BANTER_SHARD_ROOT if set, else ~/services, or an
# existing ~/Services when there is no lowercase one. Directory names are read
# from the listing, not tested with -d: on macOS's default case-insensitive
# filesystem -d reports "services" present when only "Services" exists.
banter_shard_root() {
  if [[ -n "${BANTER_SHARD_ROOT:-}" ]]; then
    echo "$BANTER_SHARD_ROOT"
    return 0
  fi
  local names
  if names="$(ls -A "$HOME" 2>/dev/null)"; then
    if ! grep -qx 'services' <<<"$names" && grep -qx 'Services' <<<"$names"; then
      echo "$HOME/Services"
      return 0
    fi
  elif [[ ! -d "$HOME/services" && -d "$HOME/Services" ]]; then
    echo "$HOME/Services"
    return 0
  fi
  echo "$HOME/services"
}

# The shard's registry path: BANTER_SHARD_REGISTRY_PATH if set, else
# <root>/shard/registry.json. Echoes the path whether or not the file exists.
banter_shard_registry_path() {
  if [[ -n "${BANTER_SHARD_REGISTRY_PATH:-}" ]]; then
    echo "$BANTER_SHARD_REGISTRY_PATH"
    return 0
  fi
  echo "$(banter_shard_root)/shard/registry.json"
}
