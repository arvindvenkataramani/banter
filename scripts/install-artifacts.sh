# Install the built artifacts a registry declares, one service at a time.
# Sourced, not run: shard-install-services.sh and control-install-services.sh
# both call install_service_artifacts, so every node installs the same way.
#
# A service declares what it installs in its registry entry:
#
#   "ops": { "env": { "workingDirectory": "/abs/dir" },
#            "install": { "artifacts": [ { "from": "<in source tree>", "to": "<in working dir>" } ] } }
#
# Building is not this file's job. An artifact that has not been built is
# reported and its service skipped; a service whose artifacts all match what is
# installed is not touched at all, so running this on every deploy is cheap.
#
# Design: docs/design/service-install.md.

source "$(dirname "${BASH_SOURCE[0]}")/deploy-env.sh"

# What the source tree is, as "<commit> <dirty>". Not a git checkout — a staged
# archive, say — reads as "unknown false".
_install_source_state() {
  local src="$1" commit
  if commit="$(git -C "$src" rev-parse HEAD 2>/dev/null)"; then
    if [[ -n "$(git -C "$src" status --porcelain 2>/dev/null)" ]]; then
      echo "$commit true"
    else
      echo "$commit false"
    fi
  else
    echo "unknown false"
  fi
}

_install_uuid() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr '[:upper:]' '[:lower:]'
  else
    cat /proc/sys/kernel/random/uuid
  fi
}

_install_sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    sha256sum "$1" | cut -d' ' -f1
  fi
}

# An artifact is a file or a directory — a binary, or a resource bundle the
# binary loads from beside itself. These three treat both alike.
_install_present() {
  [[ -f "$1" || -d "$1" ]]
}

_install_same() {
  if [[ -d "$1" ]]; then
    [[ -d "$2" ]] && diff -rq "$1" "$2" >/dev/null 2>&1
  else
    cmp -s "$1" "$2"
  fi
}

# One digest for a directory: each file's digest and path, in a fixed order,
# digested together.
_install_digest() {
  local path="$1" f
  if [[ -d "$path" ]]; then
    (cd "$path" && find . -type f | LC_ALL=C sort | while IFS= read -r f; do
      echo "$(_install_sha256 "$f")  $f"
    done) > "${TMPDIR:-/tmp}/install-digest.$$"
    _install_sha256 "${TMPDIR:-/tmp}/install-digest.$$"
    rm -f "${TMPDIR:-/tmp}/install-digest.$$"
  else
    _install_sha256 "$path"
  fi
}

# A path from the registry that stays where it is put: non-empty, relative, no
# `..`. The TypeScript validator enforces the same rule, but these scripts read
# registry.json directly, so a hand-edited file reaches them unchecked.
_install_contained() {
  local p="$1"
  [[ -n "$p" && "$p" != /* && "/$p/" != */../* ]]
}

# Whether the control API reports the service loaded. An API that does not
# answer reports nothing loaded: during a shard deploy the shard is down, and
# the swap below is safe for a process that is somehow still running.
_install_is_loaded() {
  local control="$1" id="$2"
  curl -sf -m 5 "$control/api/services/$id" 2>/dev/null \
    | "$JQ" -e '.state.loadTime != null' >/dev/null 2>&1
}

# install_service_artifacts <source-tree> <registry.json> <control-url> <events.jsonl>
#
# Returns non-zero when anything needs an operator's attention: an unreadable
# registry, an entry that would install somewhere it should not, or a service
# stopped for the install that would not start again. Every other service is
# still installed first. An artifact that has not been built is not a failure.
install_service_artifacts() {
  local src="$1" registry="$2" control="$3" events="$4"
  JQ="$(platform_find_jq)"

  local state commit dirty
  state="$(_install_source_state "$src")"
  commit="${state% *}"
  dirty="${state#* }"

  local entries
  if ! entries="$("$JQ" -c '.services[]
      | select(.ops.install)
      | {id, wd: (.ops.env.workingDirectory // ""), artifacts: (.ops.install.artifacts // [])}' "$registry")"; then
    echo "[install] error: cannot read the registry at $registry" >&2
    return 1
  fi

  local failed=0 entry
  while IFS= read -r entry; do
    [[ -n "$entry" ]] || continue
    local id wd
    id="$("$JQ" -r '.id' <<<"$entry")"
    wd="$("$JQ" -r '.wd' <<<"$entry")"

    if [[ "$wd" != /* ]]; then
      echo "[install] $id: error: no absolute ops.env.workingDirectory to install into; skipped" >&2
      failed=1
      continue
    fi

    local pairs=() from to missing="" bad="" changed=0
    while IFS=$'\t' read -r from to; do
      if ! _install_contained "$from" || ! _install_contained "$to"; then
        bad="from \"$from\" to \"$to\""
        continue
      fi
      pairs+=("$from"$'\t'"$to")
      if ! _install_present "$src/$from"; then
        missing="$from"
      elif ! _install_same "$src/$from" "$wd/$to"; then
        changed=1
      fi
    done < <("$JQ" -r '.artifacts[] | [(.from // ""), (.to // "")] | @tsv' <<<"$entry")

    if [[ -n "$bad" || ${#pairs[@]} -eq 0 ]]; then
      echo "[install] $id: error: artifact ${bad:-list is empty} must be relative paths without ..; skipped" >&2
      failed=1
      continue
    fi
    if [[ -n "$missing" ]]; then
      echo "[install] $id: skipped, $missing has not been built"
      continue
    fi
    if [[ $changed -eq 0 ]]; then
      echo "[install] $id: unchanged"
      continue
    fi

    local was_running=false
    if _install_is_loaded "$control" "$id"; then
      was_running=true
      echo "[install] $id: stopping"
      curl -sf -m 120 -X POST "$control/api/services/$id/stop" >/dev/null || true
    fi

    # Copy beside the target, then rename over it: a process still holding the
    # old file keeps it, and nothing ever sees a half-written artifact. A
    # directory can't be renamed over another, so the old one is moved aside
    # first and removed once the new one is in place.
    local pair target
    for pair in "${pairs[@]}"; do
      from="${pair%%$'\t'*}"
      to="${pair#*$'\t'}"
      target="$wd/$to"
      if ! _install_same "$src/$from" "$target"; then
        mkdir -p "$(dirname "$target")"
        if [[ -d "$src/$from" ]]; then
          rm -rf "$target.new" "$target.old"
          cp -Rp "$src/$from" "$target.new"
          [[ -e "$target" ]] && mv "$target" "$target.old"
          mv "$target.new" "$target"
          rm -rf "$target.old"
        else
          cp -p "$src/$from" "$target.new"
          mv -f "$target.new" "$target"
        fi
        echo "[install] $id: $to"
      fi
    done

    mkdir -p "$wd/logs"
    if [[ "$dirty" == true ]]; then echo "$commit-dirty"; else echo "$commit"; fi > "$wd/SOURCE-COMMIT.txt"

    local recorded="[]" sum
    for pair in "${pairs[@]}"; do
      to="${pair#*$'\t'}"
      sum="$(_install_digest "$wd/$to")"
      recorded="$("$JQ" -c --arg p "$to" --arg s "$sum" '. + [{path: $p, sha256: $s}]' <<<"$recorded")"
    done
    mkdir -p "$(dirname "$events")"
    "$JQ" -nc \
      --arg id "$(_install_uuid)" \
      --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --arg svc "$id" \
      --arg commit "$commit" \
      --argjson dirty "$dirty" \
      --argjson artifacts "$recorded" \
      '{id: $id, timestamp: $ts, type: "service.installed", subjectType: "service",
        subjectId: $svc, data: {commit: $commit, dirty: $dirty, artifacts: $artifacts},
        actor: "user"}' >> "$events"

    if $was_running; then
      echo "[install] $id: starting"
      if ! curl -sf -m 300 -X POST "$control/api/services/$id/start" >/dev/null; then
        echo "[install] $id: error: stopped for the install and did not start again; start it through the control API" >&2
        failed=1
      fi
    fi
  done <<<"$entries"

  return $failed
}

# installed_record <events.jsonl> <service-id>
# The last service.installed event for a service, as one line of JSON: what is
# installed and which commit it came from. Fails when there is none.
installed_record() {
  local events="$1" id="$2" line
  JQ="$(platform_find_jq)"
  line="$("$JQ" -c --arg id "$id" \
    'select(.type == "service.installed" and .subjectId == $id)' "$events" 2>/dev/null | tail -n 1)"
  [[ -n "$line" ]] || return 1
  echo "$line"
}
