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
# An example survives only where there was no live file, which is a first
# deploy, or where the operator chose not to keep that one — preserving is per
# file, and restore puts back exactly what save stashed.
#
# Usage:
#   deploy-preserve-config.sh save    <dest> <stash> [src-data-dir]
#   deploy-preserve-config.sh restore <dest> <stash>
#
# save takes the deploy source's data directory as an optional fourth argument.
# Given it, save refuses a deploy whose shipped config.example.json declares a
# higher version than the live one. Omitted, that check is skipped.
#
# Keys the running system writes for itself (RUNTIME_KEYS) are state, not
# configuration: they are ignored when comparing a live file with its shipped
# example, and an overwrite carries them across from the live file.
#
# The interactive prompt compares each live file against its shipped example to
# describe the choice — whether they differ, and which is newer if they do.
# It never acts on that comparison; the answer is the operator's.
#
# Nothing here is an error worth failing a deploy over: a missing destination, a
# missing file, and an empty stash all mean "first deploy" and exit 0.
set -uo pipefail

DATA_REL="control/control-plane/data"
FILES=("config.json" "registry.json")

# Per file, space-separated jq paths the running system writes.
declare -A RUNTIME_KEYS=(
  ["config.json"]=".integrations.openclaw.lastSessionByAgent"
)

# A file with its runtime keys removed, keys sorted.
strip_runtime() {
  local f="$1" file="$2" expr="." k
  for k in ${RUNTIME_KEYS[$f]:-}; do expr+=" | del($k)"; done
  jq -S "$expr" "$file" 2>/dev/null
}

# Whether a live file and its shipped example differ only in runtime keys, or not at all.
same_content() {
  local f="$1" a="$2" b="$3"
  cmp -s "$a" "$b" && return 0
  [[ -n "${RUNTIME_KEYS[$f]:-}" ]] || return 1
  diff -q <(strip_runtime "$f" "$a") <(strip_runtime "$f" "$b") >/dev/null
}

ACTION="${1:-}"
DEST="${2:-}"
STASH="${3:-}"
SRC_DATA="${4:-}"

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
    #
    # The choice is per file on both paths. BANTER_RESET_CONFIG names the
    # files to take from the repo, comma-separated; `all` (or the legacy `1`)
    # means every one of them. Anything not named is preserved, so an unattended
    # deploy can say "take the registry, keep the config" — the same answer the
    # interactive menu offers.
    overwrite=()
    case "${BANTER_RESET_CONFIG:-}" in
      "") ;;
      all|1) overwrite=("${FILES[@]}") ;;
      *)
        IFS=',' read -ra requested <<< "$BANTER_RESET_CONFIG"
        for r in "${requested[@]}"; do
          r="${r// /}"
          [[ -z "$r" ]] && continue
          known=""
          for f in "${FILES[@]}"; do
            [[ "$r" == "$f" ]] && known=1
          done
          if [[ -z "$known" ]]; then
            echo "[preserve-config] --reset-config names '$r', which is not one of: ${FILES[*]}" >&2
            exit 2
          fi
          overwrite+=("$r")
        done
        ;;
    esac

    # True when a given file is to be taken from the repo.
    is_overwritten() {
      local needle="$1" f
      for f in ${overwrite+"${overwrite[@]}"}; do
        [[ "$f" == "$needle" ]] && return 0
      done
      return 1
    }

    # What a replace would change, for one file. The interactive path prints
    # this to inform the answer; the flag path prints the same thing because an
    # unattended deploy still has to leave a record of what it discarded, and a
    # log that only says "overwritten" cannot be audited afterwards.
    describe_file() {
      local f="$1" indent="${2:-  }"
      local live_f="$DEST/$DATA_REL/$f"
      local tpl_f="$SRC_DATA/${f%.json}.example.json"
      local live_at tpl_at verdict keydiff total

      live_at="$(stat -c %y "$live_f" 2>/dev/null | cut -d. -f1)"

      # Content is the signal, the timestamps are context: a pull rewrites the
      # repo copy's mtime whether or not its bytes changed.
      if [[ -n "$SRC_DATA" && -f "$tpl_f" ]]; then
        tpl_at="$(stat -c %y "$tpl_f" 2>/dev/null | cut -d. -f1)"
        if [[ "$live_f" -nt "$tpl_f" ]]; then
          verdict="live is newer"
        else
          verdict="shipped example is newer"
        fi
        printf '%s%-14s live %s | repo %s — %s\n' "$indent" "$f" "$live_at" "$tpl_at" "$verdict"

        # Which keys differ decides the answer. Keys only the live file has are
        # settings made through the dashboard; keys only the example has are
        # what a replace would add. Values are not compared — a port or a toggle
        # changing is the normal case and would bury the structural difference
        # that matters.
        keydiff="$(jq -r -n --slurpfile t <(strip_runtime "$f" "$tpl_f") --slurpfile l <(strip_runtime "$f" "$live_f") '
          def paths_of($x; $p): $x | if type == "object"
            then to_entries | map(($p + [.key]) as $np | [$np] + paths_of(.value; $np)) | add // []
            else [] end;
          (paths_of($t[0]; []) | map(join("."))) as $tp |
          (paths_of($l[0]; []) | map(join("."))) as $lp |
          (($lp - $tp) | .[] | "only live: \(.)"),
          (($tp - $lp) | .[] | "only repo: \(.)")' 2>/dev/null || true)"

        if [[ -z "$keydiff" ]]; then
          printf '%s               same keys, differing values\n' "$indent"
        else
          # Truncate long lists, but say by how much rather than trailing off.
          total=$(printf '%s\n' "$keydiff" | wc -l)
          printf '%s\n' "$keydiff" | head -8 | sed "s/^/$indent               /"
          (( total > 8 )) && printf '%s               ... and %d more\n' "$indent" "$(( total - 8 ))"
        fi
      else
        printf '%s%-14s live %s — no shipped example\n' "$indent" "$f" "$live_at"
      fi
    }

    # A file identical to its shipped example is not a replacement whichever path
    # chose it: either answer leaves the same bytes on disk. Drop those from the
    # overwrite set so the flag neither reports nor acts on a non-change.
    if [[ ${#overwrite[@]} -gt 0 && -n "$SRC_DATA" ]]; then
      actual=()
      for f in "${overwrite[@]}"; do
        tpl_f="$SRC_DATA/${f%.json}.example.json"
        live_f="$DEST/$DATA_REL/$f"
        if [[ -f "$tpl_f" && -f "$live_f" ]] && same_content "$f" "$live_f" "$tpl_f"; then
          echo "[preserve-config] $f already matches the shipped example — nothing to replace."
          continue
        fi
        actual+=("$f")
      done
      overwrite=(${actual+"${actual[@]}"})
    fi

    reset=""
    chosen_in_menu=""
    [[ ${#overwrite[@]} -gt 0 ]] && reset=1

    # A release that changes the shape of config.json bumps its top-level
    # version. Preserving a live file across that bump leaves the new code
    # reading keys the old file does not have — and nothing validates the
    # config on load, so the failure surfaces later and somewhere unhelpful.
    # A version bump is the only signal a release gives deliberately, so it is
    # the only difference worth stopping a deploy over. Ordinary drift is not.
    tpl_config="$SRC_DATA/config.example.json"
    live_config="$DEST/$DATA_REL/config.json"

    if ! is_overwritten "config.json" && [[ -n "$SRC_DATA" && -f "$tpl_config" && -f "$live_config" ]]; then
      tpl_version="$(jq -r '.version // empty' "$tpl_config" 2>/dev/null || true)"
      live_version="$(jq -r '.version // empty' "$live_config" 2>/dev/null || true)"

      if [[ "$tpl_version" =~ ^[0-9]+$ && "$live_version" =~ ^[0-9]+$ ]] \
         && (( tpl_version > live_version )); then
        echo "" >&2
        echo "[preserve-config] config.json version $live_version is older than the example's $tpl_version." >&2
        # Which keys are missing is the reason the bump matters, so name them.
        missing="$(jq -r -n --slurpfile t "$tpl_config" --slurpfile l "$live_config" '
          def paths_of($x; $p): $x | if type == "object"
            then to_entries | map(($p + [.key]) as $np | [$np] + paths_of(.value; $np)) | add // []
            else [] end;
          (paths_of($t[0]; []) | map(join("."))) - (paths_of($l[0]; []) | map(join(".")))
          | .[]' 2>/dev/null || true)"
        if [[ -n "$missing" ]]; then
          echo "[preserve-config] the live config is missing these keys the example has:" >&2
          printf '  %s\n' $missing >&2
        fi
        echo "" >&2
        echo "[preserve-config] Refusing to deploy. Reconcile the live config by hand, or" >&2
        echo "[preserve-config] discard it and take the example with --reset-config." >&2
        echo "" >&2
        exit 1
      fi
    fi

    if [[ -z "$reset" && -t 0 ]]; then
      # A file identical to its shipped example is not a decision: either answer leaves
      # the same bytes on disk. Only the ones that differ go in the menu.
      differing=()
      for f in "${live[@]}"; do
        tpl_f="$SRC_DATA/${f%.json}.example.json"
        if [[ -n "$SRC_DATA" && -f "$tpl_f" ]] && same_content "$f" "$DEST/$DATA_REL/$f" "$tpl_f"; then
          continue
        fi
        differing+=("$f")
      done

      if [[ ${#differing[@]} -eq 0 ]]; then
        echo "[preserve-config] live configuration matches the shipped examples — keeping it."
      else
        echo ""
        echo "Live configuration differs from the shipped examples at $DEST:"
        for f in "${differing[@]}"; do
          describe_file "$f"
        done

        # One keypress decides it: keep everything, replace everything, or
        # replace exactly one file. Listing each file as its own option beats
        # asking per file, which makes an operator answer twice to change once.
        echo ""
        echo "  1) keep all (recommended)"
        echo "  2) overwrite all with the shipped examples"
        n=2
        declare -A overwrite_choice=()
        for f in "${differing[@]}"; do
          n=$(( n + 1 ))
          overwrite_choice[$n]="$f"
          echo "  $n) overwrite $f only"
        done
        read -rp "Choice [1-$n]: " choice

        # Anything that is not a listed number means keep, so the subscript is
        # only ever read once it is known to be one.
        if [[ "$choice" == "2" ]]; then
          overwrite=("${differing[@]}")
          reset=1; chosen_in_menu=1
        elif [[ "$choice" =~ ^[0-9]+$ && -n "${overwrite_choice[$choice]:-}" ]]; then
          overwrite=("${overwrite_choice[$choice]}")
          reset=1; chosen_in_menu=1
        fi
      fi
    fi

    # An unattended overwrite must not discard a live file newer than the
    # example. A menu choice was made after seeing that, so it stands.
    [[ -n "$chosen_in_menu" ]] && overwrite_checked=() || overwrite_checked=(${overwrite+"${overwrite[@]}"})
    for f in ${overwrite_checked+"${overwrite_checked[@]}"}; do
      live_f="$DEST/$DATA_REL/$f"
      tpl_f="$SRC_DATA/${f%.json}.example.json"
      [[ -n "$SRC_DATA" && -f "$tpl_f" && -f "$live_f" ]] || continue
      same_content "$f" "$live_f" "$tpl_f" && continue
      if [[ "$live_f" -nt "$tpl_f" ]]; then
        echo "" >&2
        echo "[preserve-config] $f on the deployment is newer than the copy this deploy carries," >&2
        echo "[preserve-config] and the two differ. Overwriting it would discard the newer file." >&2
        echo "" >&2
        echo "[preserve-config]   deployment: $(stat -c %y "$live_f" 2>/dev/null | cut -d. -f1)" >&2
        echo "[preserve-config]   this deploy: $(stat -c %y "$tpl_f" 2>/dev/null | cut -d. -f1)" >&2
        echo "" >&2
        echo "[preserve-config] Reconcile them by hand, or drop $f from --reset-config to keep it." >&2
        echo "" >&2
        exit 1
      fi
    done

    # What is left in `live` after removing the overwrites is what gets stashed,
    # since restore copies back exactly what save put aside.
    keep=()
    for f in "${live[@]}"; do
      is_overwritten "$f" || keep+=("$f")
    done
    live=(${keep+"${keep[@]}"})

    if [[ ${#overwrite[@]} -gt 0 ]]; then
      echo ""
      echo "[preserve-config] taking these from the shipped example, discarding the live copy:"
      for f in "${overwrite[@]}"; do
        describe_file "$f" "[preserve-config]   "
      done
      echo ""

      # The example goes in with the live file's runtime keys, stashed for restore.
      for f in "${overwrite[@]}"; do
        live_f="$DEST/$DATA_REL/$f"
        tpl_f="$SRC_DATA/${f%.json}.example.json"
        [[ -n "${RUNTIME_KEYS[$f]:-}" && -f "$live_f" && -f "$tpl_f" ]] || continue
        expr="."
        for k in ${RUNTIME_KEYS[$f]}; do
          expr+=" | if (\$l[0] | $k) != null then $k = (\$l[0] | $k) else . end"
        done
        mkdir -p "$STASH"
        jq --slurpfile l "$live_f" "$expr" "$tpl_f" > "$STASH/$f"
        echo "[preserve-config] $f keeps its runtime keys: ${RUNTIME_KEYS[$f]}"
      done
    fi

    if [[ ${#live[@]} -eq 0 ]]; then
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
