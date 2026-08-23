#!/usr/bin/env bash
# Report whether this checkout is on the project's main line.
#
# Answers one question for the deploy script: are you deploying the main line,
# or something else? Both are legitimate — the deploy just wants to say which.
#
# Reports on the repository in the current working directory, so it can be run
# from anywhere against any checkout.
#
# Exit codes:
#   0 — on the main line
#   1 — on some other branch (name is printed)
#   2 — cannot tell (not a repo, detached HEAD, no main line found)
#
# Exit 2 is not an error. A project whose branch layout we cannot read is not a
# reason to block an install.
set -uo pipefail

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "[branch-status] not a git repository — skipping branch check."
  exit 2
fi

CURRENT="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
if [[ -z "$CURRENT" ]]; then
  echo "[branch-status] detached HEAD — cannot determine branch."
  exit 2
fi

# Find the main line. Prefer what the remote advertises as its default; fall
# back to whichever conventional name exists locally. Discovered rather than
# assumed, so a fresh clone needs no configuration.
MAIN=""
REMOTE_HEAD="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)"
if [[ -n "$REMOTE_HEAD" ]]; then
  MAIN="${REMOTE_HEAD#origin/}"
fi

if [[ -z "$MAIN" ]]; then
  for candidate in main master; do
    if git show-ref --verify --quiet "refs/heads/$candidate"; then
      MAIN="$candidate"
      break
    fi
  done
fi

if [[ -z "$MAIN" ]]; then
  echo "[branch-status] no main or master branch found — skipping branch check."
  exit 2
fi

if [[ "$CURRENT" == "$MAIN" ]]; then
  echo "[branch-status] on the main line ($MAIN)."
  exit 0
fi

echo "[branch-status] on branch '$CURRENT', not the main line ($MAIN)."
exit 1
