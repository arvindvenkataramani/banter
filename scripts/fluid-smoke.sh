#!/usr/bin/env bash
# Smoke-test fluid-stt as built, installed and running, without touching the
# live one. Every check runs against a throwaway deploy that is removed on exit,
# whether the run passes, fails or is interrupted.
#
#   scripts/fluid-smoke.sh            # build, deploy to scratch, check, clean up
#   scripts/fluid-smoke.sh --keep     # leave the scratch deploy for debugging
#
# The deploy:
#   - fluid-build.sh builds fluid-stt.app.
#   - install-artifacts.sh installs it from a scratch registry into a scratch
#     working directory, the same code path a real install takes. Its control
#     URL points at nothing, so it never stops or starts a live service.
#   - The installed copy is re-stamped com.banter.fluid-stt.smoke-<random> and
#     re-signed. The server keys its temp directory, caches and log subsystem by
#     bundle identifier, and its temp directory is the per-user Darwin one
#     whatever TMPDIR says, so under the real identifier its startup wipe would
#     reach a live server's uploads.
#   - It runs from the scratch install on FLUID_SMOKE_PORT (18767).
#
# Cleanup stops the server and removes the scratch directory plus the
# smoke identifier's temp directory and ~/Library/Caches entry, so nothing the
# run created outlives it.
#
# The checks: the built bundle carries com.banter.fluid-stt and this commit;
# /healthz reports what the running bundle's Info.plist says; a batch
# transcription with no model named loads the roster default; Deepgram's POST
# /listen answers; the /listen socket refuses a second client, closes an
# utterance on a pause and answers CloseStream (fluid-smoke-listen.ts); the
# model unloads after the scratch roster's short idleUnloadMs.
#
# Never downloads. A model whose weights are not on this machine, or a missing
# `say` to speak the test sentence, is a skip, not a failure.
#
# Exit: 0 passed, 1 failed, 3 skipped (a prerequisite is missing).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE="$REPO/services/fluid"
PORT="${FLUID_SMOKE_PORT:-18767}"
MODEL="parakeet-unified-0.6b"
SENTENCE="The quick brown fox jumps over the lazy dog."
EXPECTED="fox"
IDLE_MS=4000

KEEP=false
[[ "${1:-}" == "--keep" ]] && KEEP=true

source "$REPO/scripts/install-artifacts.sh"
JQ="$(platform_find_jq)"
BUN="$(platform_find_bun)"

log() { echo "[fluid-smoke] $*"; }
ok() { echo "[fluid-smoke] ok   $*"; }

SCRATCH=""
SERVER_PID=""
SMOKE_ID="com.banter.fluid-stt.smoke-$(uuidgen | tr '[:upper:]' '[:lower:]' | cut -c1-8)"
SMOKE_TEMP="$(getconf DARWIN_USER_TEMP_DIR)$SMOKE_ID"
SMOKE_CACHES="$HOME/Library/Caches/$SMOKE_ID"

cleanup() {
  local status=$?
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 0.5
    done
    kill -KILL "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[fluid-smoke] warning: port $PORT is still listening after cleanup" >&2
  fi
  if [[ $status -eq 1 && -f "$SCRATCH/server.log" ]]; then
    echo "[fluid-smoke] last lines of the server log:" >&2
    tail -n 20 "$SCRATCH/server.log" >&2
  fi
  if [[ -n "$SCRATCH" && -d "$SCRATCH" ]]; then
    if $KEEP; then
      log "kept the scratch deploy at $SCRATCH"
    else
      rm -rf "$SCRATCH"
      log "removed the scratch deploy"
    fi
  fi
  # Named by the smoke identifier alone, so these can only be this run's.
  if ! $KEEP; then
    rm -rf "$SMOKE_TEMP" "$SMOKE_CACHES"
  fi
  exit $status
}
trap cleanup EXIT
trap 'exit 130' INT TERM

fail() {
  echo "[fluid-smoke] FAIL $*" >&2
  exit 1
}

skip() {
  echo "[fluid-smoke] SKIP $*"
  exit 3
}

command -v say >/dev/null 2>&1 || skip "no 'say' to speak the test sentence"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "port $PORT is in use; set FLUID_SMOKE_PORT to a free one"
fi

"$REPO/scripts/fluid-build.sh"

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/fluid-smoke.XXXXXX")"
mkdir -p "$SCRATCH/install"

# The scratch registry: the example's fluid-stt service and roster, installing
# into the scratch directory, with an idle unload short enough to wait for.
"$JQ" --arg wd "$SCRATCH/install" --argjson idle "$IDLE_MS" '
  {
    services: [.services[] | select(.id == "fluid-stt") | .ops.env.workingDirectory = $wd],
    roster: {providers: {"fluid-stt": (.roster.providers["fluid-stt"] | .idleUnloadMs = $idle)}}
  }' "$REPO/control/control-plane/data/registry.example.json" > "$SCRATCH/registry.json"

install_service_artifacts "$REPO" "$SCRATCH/registry.json" "http://127.0.0.1:9" "$SCRATCH/events.jsonl" \
  || fail "the install reported a problem"
[[ -x "$SCRATCH/install/fluid-stt.app/Contents/MacOS/fluid-stt" ]] || fail "the install did not place fluid-stt.app"
"$JQ" -e 'select(.type == "service.installed" and .subjectId == "fluid-stt")' "$SCRATCH/events.jsonl" >/dev/null \
  || fail "the install logged no service.installed event"
ok "installed fluid-stt.app into the scratch working directory"

commit="$(git -C "$REPO" rev-parse HEAD)"
[[ -n "$(git -C "$REPO" status --porcelain)" ]] && commit="$commit-dirty"

plist="$SCRATCH/install/fluid-stt.app/Contents/Info.plist"
pb() { /usr/libexec/PlistBuddy -c "Print :$1" "$plist"; }
[[ "$(pb CFBundleIdentifier)" == "com.banter.fluid-stt" ]] || fail "the built bundle is $(pb CFBundleIdentifier), not com.banter.fluid-stt"
[[ "$(pb CFBundleVersion)" == "$commit" ]] || fail "the built bundle is version $(pb CFBundleVersion), not $commit"
ok "the built bundle is com.banter.fluid-stt at $commit"

/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $SMOKE_ID" "$plist"
codesign --force --sign - --timestamp=none "$SCRATCH/install/fluid-stt.app" 2>/dev/null

(
  cd "$SCRATCH/install"
  exec fluid-stt.app/Contents/MacOS/fluid-stt \
    --port "$PORT" --registry "$SCRATCH/registry.json" --provider fluid-stt
) > "$SCRATCH/server.log" 2>&1 &
SERVER_PID=$!

URL="http://127.0.0.1:$PORT"
health=""
for _ in $(seq 1 40); do
  health="$(curl -sf -m 2 "$URL/healthz" 2>/dev/null)" && break
  kill -0 "$SERVER_PID" 2>/dev/null || fail "the server exited at startup"
  sleep 0.25
done
[[ -n "$health" ]] || fail "/healthz did not answer within 10 s"

"$JQ" -e --arg id "$SMOKE_ID" --arg c "$commit" '
  .bundleIdentifier == $id and .buildVersion == $c and .model == null' <<<"$health" >/dev/null \
  || fail "/healthz does not report the running bundle's Info.plist, or a model is already loaded: $health"
[[ -d "$SMOKE_TEMP" ]] || fail "the server did not create its temp directory at $SMOKE_TEMP"
ok "/healthz reports $SMOKE_ID at $commit, no model loaded"

"$JQ" -e --arg m "$MODEL" '.data[] | select(.id == $m) | .present' \
  <<<"$(curl -sf -m 10 "$URL/v1/models")" >/dev/null \
  || skip "$MODEL's weights are not on this machine; load it once through the dashboard or /v1/models/load"

wav="$SCRATCH/speech.wav"
say -o "$wav" --file-format=WAVE --data-format=LEI16@16000 "$SENTENCE"

text="$(curl -sf -m 180 -F "file=@$wav" "$URL/audio/transcriptions" | "$JQ" -r '.text')" \
  || fail "batch transcription with no model named was refused"
grep -qi "$EXPECTED" <<<"$text" || fail "batch transcription \"$text\" does not contain \"$EXPECTED\""
"$JQ" -e --arg m "$MODEL" '.model == $m' <<<"$(curl -sf -m 5 "$URL/healthz")" >/dev/null \
  || fail "a nameless request did not load the roster default $MODEL"
ok "a nameless batch request loaded $MODEL: \"$text\""

text="$(curl -sf -m 60 -H "Content-Type: audio/wav" --data-binary "@$wav" "$URL/listen" \
  | "$JQ" -r '.results.channels[0].alternatives[0].transcript')" || fail "POST /listen was refused"
grep -qi "$EXPECTED" <<<"$text" || fail "POST /listen \"$text\" does not contain \"$EXPECTED\""
ok "POST /listen: \"$text\""

"$BUN" "$REPO/scripts/fluid-smoke-listen.ts" "ws://127.0.0.1:$PORT" "$wav" "$EXPECTED" \
  || fail "the /listen socket"

unloaded=false
for _ in $(seq 1 30); do
  if "$JQ" -e '.model == null' <<<"$(curl -sf -m 2 "$URL/healthz")" >/dev/null; then
    unloaded=true
    break
  fi
  sleep 0.5
done
$unloaded || fail "the model was still loaded 15 s past a ${IDLE_MS} ms idleUnloadMs"
ok "the model unloaded after ${IDLE_MS} ms idle"

log "passed"
