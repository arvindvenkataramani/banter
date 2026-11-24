#!/usr/bin/env bash
# Smoke-test the fluid servers as built, installed and running, without touching
# the live ones. Every check runs against a throwaway deploy that is removed on
# exit, whether the run passes, fails or is interrupted.
#
#   scripts/fluid-smoke.sh                 # both servers
#   scripts/fluid-smoke.sh stt             # fluid-stt only
#   scripts/fluid-smoke.sh tts             # fluid-tts, with fluid-stt as its listener
#   scripts/fluid-smoke.sh --keep          # leave the scratch deploy for debugging
#   scripts/fluid-smoke.sh --audio-dir DIR # keep what fluid-tts synthesized, as WAV
#
# Run it after anything that changes what the servers are built from: a
# FluidAudio version, a Swift toolchain, a dependency pin, the build script.
#
# The deploy, per server:
#   - fluid-build.sh builds both .app bundles.
#   - install-artifacts.sh installs the server from a scratch registry into a
#     scratch working directory under /var/tmp, the same code path a real
#     install takes. Its control URL points at nothing, so it never stops or
#     starts a live service.
#   - The installed copy is re-stamped <real id>.smoke-<random> and re-signed.
#     A server keys its temp directory and caches by bundle identifier and
#     empties its temp directory at startup, so under the real identifier it
#     would reach the live server's files.
#   - It runs from the scratch install on its own port (FLUID_SMOKE_STT_PORT,
#     default 18767; FLUID_SMOKE_TTS_PORT, default 18769) with outbound HTTP
#     and HTTPS denied by sandbox-exec.
#
# The checks, for each server: the installed bundle is the real identifier at
# this commit, and /healthz reports what the running bundle's Info.plist says.
#
#   fluid-stt  a nameless transcription of a sentence spoken with `say` contains
#              an expected word and leaves the roster default resident;
#              Deepgram's POST /v1/listen answers; the /v1/listen socket refuses
#              a second client, closes an utterance on a pause, answers
#              CloseStream, answers a Finalize sent with no audio by one empty
#              from_finalize result, and with endpointing=false leaves an
#              utterance open through a pause longer than the 700 ms it closes
#              on otherwise (fluid-smoke-listen.ts); the default unloads after
#              the scratch roster's short idleUnloadMs; every
#              other roster model whose weights are present loads through the
#              Triton routes, shows READY in the index, transcribes the same
#              sentence if it serves HTTP transcription, and unloads.
#   fluid-tts  every roster model whose weights are present loads through the
#              Triton routes, shows READY in the index, synthesizes
#              the sentence as WAV, and that audio transcribes back to the
#              expected word through the scratch fluid-stt, in one voice: the
#              first roster voice with a preset on the model, else the first
#              that clones under it, named by id alone, so the server's own
#              choice of preset key or recording is what gets heard. A model
#              the roster marks `streaming` answers a speech request that
#              carries no stream flag progressively: its first audio arrives
#              well before its last.
#
# Never downloads, and proves it: the servers cannot reach the network, so a
# build that wants a file this machine lacks fails its load here instead of
# fetching it, and the run fails if either model directory gained a file.
#
# A model whose weights are not on this machine, a cloning model no roster
# voice clones under, or a missing `say` is a skip of that check, not a failure. A run
# in which nothing could be checked exits 3.
#
# Exit: 0 passed, 1 failed, 3 skipped (a prerequisite is missing).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE="$REPO/services/fluid"
STT_PORT="${FLUID_SMOKE_STT_PORT:-18767}"
TTS_PORT="${FLUID_SMOKE_TTS_PORT:-18769}"
SENTENCE="The quick brown fox jumps over the lazy dog."
EXPECTED="fox"
SCRATCH_PARENT="/var/tmp"
MODEL_ROOTS=("$HOME/.cache/fluidaudio" "$HOME/Library/Application Support/FluidAudio")
IDLE_MS=4000

WHAT="all"
KEEP=false
AUDIO_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    stt|tts|all) WHAT="$1" ;;
    --keep) KEEP=true ;;
    --audio-dir) AUDIO_DIR="${2:?--audio-dir needs a directory}"; shift ;;
    *) echo "usage: fluid-smoke.sh [stt|tts|all] [--keep] [--audio-dir DIR]" >&2; exit 1 ;;
  esac
  shift
done

source "$REPO/ops/install-artifacts.sh"
BUN="$(platform_find_bun)"

log() { echo "[fluid-smoke] $*"; }
ok() { echo "[fluid-smoke] ok   $*"; CHECKED=$((CHECKED + 1)); }
note_skip() { echo "[fluid-smoke] skip $*"; SKIPPED=$((SKIPPED + 1)); }

CHECKED=0
SKIPPED=0
SCRATCH=""
PIDS=()
PORTS=()
SMOKE_IDS=()

# Removes a path only when it is non-empty and named by this run: under the
# scratch parent with the scratch prefix, or ending in a smoke identifier.
remove_own() {
  local path="$1"
  [[ -n "$path" ]] || return 0
  case "$path" in
    "$SCRATCH_PARENT"/fluid-smoke.?*) ;;
    */com.banter.fluid-???.smoke-?*) ;;
    *) echo "[fluid-smoke] refusing to remove $path" >&2; return 0 ;;
  esac
  rm -rf "$path"
}

cleanup() {
  local status=$? pid port id
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do
    kill -0 "$pid" 2>/dev/null || continue
    kill -TERM "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    kill -KILL "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  for port in ${PORTS[@]+"${PORTS[@]}"}; do
    if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "[fluid-smoke] warning: port $port is still listening after cleanup" >&2
    fi
  done
  if [[ $status -eq 1 && -n "$SCRATCH" ]]; then
    for id in fluid-stt fluid-tts; do
      [[ -f "$SCRATCH/$id.log" ]] || continue
      echo "[fluid-smoke] last lines of the $id log:" >&2
      tail -n 20 "$SCRATCH/$id.log" >&2
    done
  fi
  if $KEEP; then
    [[ -n "$SCRATCH" ]] && log "kept the scratch deploy at $SCRATCH"
  else
    if [[ -n "$SCRATCH" && -d "$SCRATCH" ]]; then
      remove_own "$SCRATCH"
      log "removed the scratch deploy"
    fi
    for id in ${SMOKE_IDS[@]+"${SMOKE_IDS[@]}"}; do
      remove_own "$(getconf DARWIN_USER_TEMP_DIR)$id"
      remove_own "$HOME/Library/Caches/$id"
    done
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

# The Triton model repository routes both servers provide. `triton_post URL PATH
# BODY [TIMEOUT]` echoes the status and leaves the response in triton.json.
triton_post() {
  curl -s -m "${4:-300}" -o "$SCRATCH/triton.json" -w '%{http_code}' -X POST \
    -H "Content-Type: application/json" -d "$3" "$1$2"
}

# Succeeds when the repository index of URL shows the model NAME as READY.
triton_ready() {
  curl -sf -m 10 -X POST -H "Content-Type: application/json" -d '{}' "$1/v2/repository/index" \
    | "$JQ" -e --arg n "$2" 'any(.[]; .name == $n and .state == "READY")' >/dev/null
}

# The name a fluid-stt load is addressed by: the roster's key for the model.
stt_key() {
  "$JQ" -r --arg m "$1" '.roster.providers["fluid-stt"].serves[] | select(.model == $m) | .key' \
    "$SCRATCH/fluid-stt.registry.json"
}

model_files() {
  local root
  for root in "${MODEL_ROOTS[@]}"; do
    [[ -d "$root" ]] && find "$root" -type f
  done | sort
}

# Installs one server into the scratch directory, re-stamps it, starts it with
# the network denied, and waits for /healthz. Leaves its URL in SERVER_URL.
start_server() {
  local id="$1" port="$2"
  local real_id="com.banter.$id"
  local smoke_id="$real_id.smoke-$(uuidgen | tr '[:upper:]' '[:lower:]' | cut -c1-8)"
  local wd="$SCRATCH/$id" registry="$SCRATCH/$id.registry.json"

  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    fail "port $port is in use; set FLUID_SMOKE_STT_PORT or FLUID_SMOKE_TTS_PORT to a free one"
  fi
  mkdir -p "$wd"

  # The scratch registry: the fluid example registry's entry for this server,
  # installing into the scratch directory, with the roster the server reads. The
  # voices stay, since a cloning model is checked with one of them. fluid-stt
  # gets an idle unload short enough to wait for.
  "$JQ" --arg id "$id" --arg wd "$wd" --argjson idle "$IDLE_MS" '
    {
      version: .version,
      type: "shard",
      services: [.services[] | select(.id == $id) | .ops.env.workingDirectory = $wd],
      roster: {
        ttsModels: (.roster.ttsModels // []),
        sttModels: (.roster.sttModels // []),
        providers: {($id): (.roster.providers[$id] | if $id == "fluid-stt" then .idleUnloadMs = $idle else . end)},
        voices: (.roster.voices // [])
      }
    }' "$REPO/services/fluid/registry.fluid.example.json" > "$registry"

  # Nothing listens at port 1, so a service that is somehow loaded is never
  # stopped or started through a real control API.
  install_service_artifacts "$REPO" "$registry" "http://127.0.0.1:1" "$SCRATCH/events.jsonl" \
    || fail "the $id install reported a problem"
  [[ -x "$wd/$id.app/Contents/MacOS/$id" ]] || fail "the install did not place $id.app"
  "$JQ" -e --arg id "$id" 'select(.type == "service.installed" and .subjectId == $id)' \
    "$SCRATCH/events.jsonl" >/dev/null || fail "the install logged no service.installed event for $id"

  local plist="$wd/$id.app/Contents/Info.plist"
  pb() { /usr/libexec/PlistBuddy -c "Print :$1" "$plist"; }
  [[ "$(pb CFBundleIdentifier)" == "$real_id" ]] || fail "the built bundle is $(pb CFBundleIdentifier), not $real_id"
  [[ "$(pb CFBundleVersion)" == "$COMMIT" ]] || fail "the built $id bundle is build $(pb CFBundleVersion), not $COMMIT"
  [[ "$(pb CFBundleShortVersionString)" == "$VERSION" ]] \
    || fail "the built $id bundle is version $(pb CFBundleShortVersionString), not $VERSION"

  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $smoke_id" "$plist"
  codesign --force --sign - --timestamp=none "$wd/$id.app" 2>/dev/null
  SMOKE_IDS+=("$smoke_id")

  # TMPDIR is cleared so the server's temp directory is the per-user one the
  # cleanup removes.
  (
    cd "$wd"
    exec env -u TMPDIR sandbox-exec -f "$SCRATCH/no-network.sb" "$id.app/Contents/MacOS/$id" \
      --port "$port" --registry "$registry" --provider "$id"
  ) > "$SCRATCH/$id.log" 2>&1 &
  local pid=$!
  PIDS+=("$pid")
  PORTS+=("$port")

  SERVER_URL="http://127.0.0.1:$port"
  local health=""
  for _ in $(seq 1 40); do
    health="$(curl -sf -m 2 "$SERVER_URL/healthz" 2>/dev/null)" && break
    kill -0 "$pid" 2>/dev/null || fail "$id exited at startup"
    sleep 0.25
  done
  [[ -n "$health" ]] || fail "$id /healthz did not answer within 10 s"

  "$JQ" -e --arg id "$smoke_id" --arg c "$COMMIT" --arg v "$VERSION" '
    .bundleIdentifier == $id and .buildVersion == $c and .shortVersion == $v' <<<"$health" >/dev/null \
    || fail "$id /healthz does not report the running bundle's Info.plist: $health"
  [[ -d "$(getconf DARWIN_USER_TEMP_DIR)$smoke_id" ]] || fail "$id did not create its temp directory"
  ok "$id: $real_id $VERSION at $COMMIT, installed, running as $smoke_id"
}

# Echoes the transcription of a WAV through the scratch fluid-stt, by the model
# named or, with none, by whichever is resident or the roster default.
transcribe() {
  if [[ -n "${2:-}" ]]; then
    curl -sf -m 180 -F "file=@$1" -F "model=$2" "$STT_URL/v1/audio/transcriptions" | "$JQ" -r '.text'
  else
    curl -sf -m 180 -F "file=@$1" "$STT_URL/v1/audio/transcriptions" | "$JQ" -r '.text'
  fi
}

stt_unload() {
  local code key
  key="$(stt_key "$1")"
  code="$(triton_post "$STT_URL" "/v2/repository/models/$key/unload" '{}' 30)"
  [[ "$code" == 200 ]] || fail "fluid-stt: unloading $1 returned $code: $(head -c 300 "$SCRATCH/triton.json")"
  "$JQ" -e '.model == null' <<<"$(curl -sf -m 5 "$STT_URL/healthz")" >/dev/null \
    || fail "fluid-stt: $1 was still resident after its unload"
  if triton_ready "$STT_URL" "$key"; then fail "fluid-stt: the index still shows $1 READY after its unload"; fi
}

check_stt() {
  local default="$STT_MODEL" wav="$SCRATCH/speech.wav" text models model code
  say -o "$wav" --file-format=WAVE --data-format=LEI16@16000 "$SENTENCE"

  stt_unload_if_resident
  text="$(transcribe "$wav")" || fail "fluid-stt: the nameless transcription was refused"
  grep -qi "$EXPECTED" <<<"$text" || fail "fluid-stt: the transcription \"$text\" does not contain \"$EXPECTED\""
  "$JQ" -e --arg m "$default" '.model == $m' <<<"$(curl -sf -m 5 "$STT_URL/healthz")" >/dev/null \
    || fail "fluid-stt: a nameless transcription did not leave the roster default $default resident"
  ok "fluid-stt: $default, the roster default, transcribed \"$text\""

  text="$(curl -sf -m 60 -H "Content-Type: audio/wav" --data-binary "@$wav" "$STT_URL/v1/listen" \
    | "$JQ" -r '.results.channels[0].alternatives[0].transcript')" || fail "fluid-stt: POST /v1/listen was refused"
  grep -qi "$EXPECTED" <<<"$text" || fail "fluid-stt: POST /v1/listen \"$text\" does not contain \"$EXPECTED\""
  ok "fluid-stt: POST /v1/listen: \"$text\""

  "$BUN" "$REPO/scripts/fluid-smoke-listen.ts" "ws://127.0.0.1:$STT_PORT" "$wav" "$EXPECTED" \
    || fail "fluid-stt: the /v1/listen socket"

  local unloaded=false
  for _ in $(seq 1 30); do
    if "$JQ" -e '.model == null' <<<"$(curl -sf -m 2 "$STT_URL/healthz")" >/dev/null; then
      unloaded=true
      break
    fi
    sleep 0.5
  done
  $unloaded || fail "fluid-stt: the model was still loaded 15 s past a ${IDLE_MS} ms idleUnloadMs"
  ok "fluid-stt: the model unloaded after ${IDLE_MS} ms idle"

  models="$(curl -sf -m 10 "$STT_URL/v1/models")" || fail "fluid-stt /v1/models was refused"
  for model in $("$JQ" -r --arg d "$default" '.data[] | select(.id != $d) | .id' <<<"$models"); do
    if ! "$JQ" -e --arg m "$model" '.data[] | select(.id == $m) | .present' <<<"$models" >/dev/null; then
      note_skip "fluid-stt: $model's weights are not on this machine"
      continue
    fi
    # A load never defaults a choice the model offers: a model serving both
    # modes is asked for batch, and one with variants for its first.
    local key body
    key="$(stt_key "$model")"
    body="$("$JQ" -c --arg m "$model" '.data[] | select(.id == $m)
          | {parameters: ((if .kind == "both" then {mode: "batch"} else {} end)
            + (if (.variants // []) | length > 0 then {variant: .variants[0].id} else {} end))}' <<<"$models")"
    code="$(triton_post "$STT_URL" "/v2/repository/models/$key/load" "$body")"
    [[ "$code" == 200 ]] \
      || fail "fluid-stt: loading $model returned $code: $(tr -d '\n' < "$SCRATCH/triton.json" | head -c 300)"
    triton_ready "$STT_URL" "$key" || fail "fluid-stt: the index does not show $model READY after its load"
    if "$JQ" -e --arg m "$model" '.data[] | select(.id == $m) | .transport | index("http")' <<<"$models" >/dev/null; then
      text="$(transcribe "$wav" "$model")" || fail "fluid-stt: $model refused the transcription"
      grep -qi "$EXPECTED" <<<"$text" || fail "fluid-stt: $model transcribed \"$text\", without \"$EXPECTED\""
      ok "fluid-stt: $model transcribed \"$text\""
    else
      ok "fluid-stt: $model loaded; it has no HTTP transcription to check"
    fi
    stt_unload "$model"
  done
}

stt_unload_if_resident() {
  local resident
  resident="$(curl -sf -m 5 "$STT_URL/healthz" | "$JQ" -r '.model // empty')"
  [[ -z "$resident" ]] || stt_unload "$resident"
}

# Echoes the request fields that give a model one voice, as a JSON object: the
# first roster voice with a preset rendering on the model, else the first that
# clones under it. One voice proves the model speaks; a preset voice file the
# machine lacks would otherwise fail the run, since the servers cannot download.
# A voice is sent by id alone; choosing her recording or preset key is the
# server's job, and sending one would test this script's copy of the rule.
# Nothing when the roster offers none.
voice_fields() {
  local model="$1" registry="$SCRATCH/fluid-tts.registry.json"
  "$JQ" -c --arg m "$model" '
    [ ( .roster.voices[] | select(any(.renderings[]; .model == $m and .method == "preset")) ),
      ( .roster.voices[] | select(any(.renderings[]; .model == $m and .method == "clone")) )
    ] | first // empty | {voice: .id}' "$registry"
}

# Echoes `FIRST TOTAL BYTES` for a long speech request that carries no stream
# flag: seconds until the first audio byte, seconds until the last, and how many
# bytes arrived. Raw PCM, so the first byte of the body is audio, not a header.
speech_timing() {
  local text="$SENTENCE $SENTENCE $SENTENCE $SENTENCE $SENTENCE $SENTENCE"
  "$JQ" -n --arg m "$1" --arg t "$text" --argjson f "$2" \
      '{model: $m, input: $t, response_format: "pcm"} + $f' \
    | curl -sN -m 300 -H "Content-Type: application/json" -d @- "$TTS_URL/v1/audio/speech" \
    | perl -MTime::HiRes=time -e 'binmode STDIN; my $t0 = time; my $n = read(STDIN, my $b, 1);
        my $first = time - $t0; my $bytes = $n;
        while (my $r = read(STDIN, my $c, 65536)) { $bytes += $r }
        printf "%.3f %.3f %d\n", $first, time - $t0, $bytes;'
}

# INVENTED: the first audio must arrive in under half of the whole response's
# time. A server that renders everything before it sends anything delivers its
# first byte at about the whole time, so this fails for it; a streaming one
# sends its first half second of audio long before the end of a long text.
check_progressive() {
  local model="$1" fields="$2" timing first total bytes
  timing="$(speech_timing "$model" "$fields")" \
    || fail "fluid-tts: $model dropped the connection during a long speech request"
  read -r first total bytes <<<"$timing"
  [[ "${bytes:-0}" -gt 0 ]] || fail "fluid-tts: $model answered a long speech request with no audio"
  if awk -v t="$total" 'BEGIN { exit !(t < 1.0) }'; then
    note_skip "fluid-tts: $model synthesized the long text in ${total}s, too fast to tell streaming from buffering"
    return
  fi
  awk -v f="$first" -v t="$total" 'BEGIN { exit !(f < t * 0.5) }' \
    || fail "fluid-tts: $model sent its first audio after ${first}s of ${total}s; without a stream flag it should answer progressively"
  ok "fluid-tts: $model streamed with no stream flag: first audio after ${first}s of ${total}s"
}

check_tts() {
  local models model voices fields voice wav code text pcm_done
  models="$(curl -sf -m 10 "$TTS_URL/v1/models")" || fail "fluid-tts /v1/models was refused"

  for model in $("$JQ" -r '.data[].id' <<<"$models"); do
    if ! "$JQ" -e --arg m "$model" '.data[] | select(.id == $m) | .present' <<<"$models" >/dev/null; then
      note_skip "fluid-tts: $model's weights are not on this machine"
      continue
    fi
    pcm_done=""
    voices="$(voice_fields "$model")"
    if [[ -z "$voices" ]]; then
      note_skip "fluid-tts: the roster has no voice $model can use"
      continue
    fi

    code="$(triton_post "$TTS_URL" "/v2/repository/models/$model/load" '{"parameters":{}}')"
    [[ "$code" == 200 ]] || fail "fluid-tts: loading $model returned $code: $(head -c 300 "$SCRATCH/triton.json")"
    triton_ready "$TTS_URL" "$model" || fail "fluid-tts: the index does not show $model READY after its load"

    # A model the roster marks streaming answers progressively, with no flag.
    if "$JQ" -e --arg m "$model" '.roster.providers["fluid-tts"].serves[] | select(.model == $m and .streaming == true)' \
        "$SCRATCH/fluid-tts.registry.json" >/dev/null; then
      check_progressive "$model" "$(head -n 1 <<<"$voices")"
    fi

    while IFS= read -r fields; do
      voice="$("$JQ" -r '.voice' <<<"$fields")"
      wav="$SCRATCH/$model-$voice.wav"
      code="$("$JQ" -n --arg m "$model" --arg t "$SENTENCE" --argjson f "$fields" \
          '{model: $m, input: $t, response_format: "wav"} + $f' \
        | curl -s -m 300 -o "$wav" -w '%{http_code}' -H "Content-Type: application/json" -d @- \
          "$TTS_URL/v1/audio/speech")" || fail "fluid-tts: $model ($voice) dropped the connection while synthesizing"
      [[ "$code" == 200 ]] || fail "fluid-tts: $model ($voice) synthesis returned $code: $(head -c 300 "$wav")"
      [[ "$(head -c 4 "$wav")" == "RIFF" ]] || fail "fluid-tts: $model ($voice) did not return a WAV"

      if [[ -n "$STT_URL" ]]; then
        text="$(transcribe "$wav")" || fail "fluid-tts: the transcription of $model ($voice) was refused"
        grep -qi "$EXPECTED" <<<"$text" \
          || fail "fluid-tts: $model ($voice) transcribed as \"$text\", without \"$EXPECTED\""
        ok "fluid-tts: $model ($voice) heard as \"$text\""
      else
        ok "fluid-tts: $model ($voice) returned a WAV, not listened to"
      fi

      if [[ -n "$AUDIO_DIR" ]]; then
        mkdir -p "$AUDIO_DIR"
        cp "$wav" "$AUDIO_DIR/$model-$voice.wav"
      fi

      # Once per model: the same request as headerless PCM, which is 24 kHz
      # whatever the model produces. It is given a 24 kHz WAV header here and
      # listened to, so audio sent at the model's own rate is heard as wrong.
      if [[ -z "$pcm_done" && -n "$STT_URL" ]]; then
        pcm_done=1
        code="$("$JQ" -n --arg m "$model" --arg t "$SENTENCE" --argjson f "$fields" \
            '{model: $m, input: $t, response_format: "pcm"} + $f' \
          | curl -s -m 300 -o "$SCRATCH/$model.pcm" -D "$SCRATCH/pcm.headers" -w '%{http_code}' \
            -H "Content-Type: application/json" -d @- "$TTS_URL/v1/audio/speech")" \
          || fail "fluid-tts: $model dropped the connection while synthesizing PCM"
        [[ "$code" == 200 ]] || fail "fluid-tts: $model PCM synthesis returned $code: $(head -c 300 "$SCRATCH/$model.pcm")"
        grep -qi '^content-type: audio/pcm;rate=24000' "$SCRATCH/pcm.headers" \
          || fail "fluid-tts: $model PCM came back as $(grep -i '^content-type' "$SCRATCH/pcm.headers" | tr -d '\r')"
        perl -e 'binmode STDIN; binmode STDOUT; my $d = do { local $/; <STDIN> };
                 print "RIFF", pack("V", 36 + length $d), "WAVEfmt ",
                       pack("VvvVVvv", 16, 1, 1, 24000, 48000, 2, 16), "data", pack("V", length $d), $d' \
          < "$SCRATCH/$model.pcm" > "$SCRATCH/$model-pcm.wav"
        text="$(transcribe "$SCRATCH/$model-pcm.wav")" || fail "fluid-tts: the transcription of $model's PCM was refused"
        grep -qi "$EXPECTED" <<<"$text" \
          || fail "fluid-tts: $model's PCM, played at 24 kHz, transcribed as \"$text\", without \"$EXPECTED\""
        ok "fluid-tts: $model as PCM at 24 kHz heard as \"$text\""
      fi
    done <<<"$voices"
  done
}

[[ "$(uname -s)" == "Darwin" ]] || skip "the fluid servers run on macOS only"
command -v sandbox-exec >/dev/null 2>&1 || skip "no sandbox-exec to keep the servers off the network"
JQ="$(platform_find_jq)" || skip "jq is not installed"
if [[ "$WHAT" != "tts" ]]; then
  command -v say >/dev/null 2>&1 || skip "no 'say' to speak the test sentence"
fi

"$REPO/scripts/fluid-build.sh"

COMMIT="$(git -C "$REPO" rev-parse HEAD)"
[[ -n "$(git -C "$REPO" status --porcelain)" ]] && COMMIT="$COMMIT-dirty"
VERSION="$(<"$PACKAGE/VERSION")"

SCRATCH="$(mktemp -d "$SCRATCH_PARENT/fluid-smoke.XXXXXX")"
cat > "$SCRATCH/no-network.sb" <<'EOF'
(version 1)
(allow default)
(deny network-outbound (remote tcp "*:443"))
(deny network-outbound (remote tcp "*:80"))
EOF
model_files > "$SCRATCH/models-before.txt"

# fluid-stt runs for every mode: it is what is checked, or what listens to
# fluid-tts. Without its default model there is nothing to listen with.
STT_URL=""
STT_MODEL="$("$JQ" -r '.roster.providers["fluid-stt"].defaultModel' "$REPO/services/fluid/registry.fluid.example.json")"
[[ -n "$STT_MODEL" && "$STT_MODEL" != "null" ]] || fail "the fluid example registry's fluid-stt roster names no defaultModel"
start_server fluid-stt "$STT_PORT"
if "$JQ" -e --arg m "$STT_MODEL" '.data[] | select(.id == $m) | .present' \
    <<<"$(curl -sf -m 10 "$SERVER_URL/v1/models")" >/dev/null; then
  STT_URL="$SERVER_URL"
else
  note_skip "fluid-stt: $STT_MODEL's weights are not on this machine"
fi

if [[ "$WHAT" != "stt" ]]; then
  start_server fluid-tts "$TTS_PORT"
  TTS_URL="$SERVER_URL"
  check_tts
fi
if [[ "$WHAT" != "tts" && -n "$STT_URL" ]]; then
  check_stt
fi

model_files > "$SCRATCH/models-after.txt"
added="$(comm -13 "$SCRATCH/models-before.txt" "$SCRATCH/models-after.txt")"
[[ -z "$added" ]] || fail "a model directory gained files during the run: $(head -n 5 <<<"$added")"
ok "no model directory gained a file"

# A build can want a file, fail to fetch it, and carry on with an older one, so
# a refused download is reported even when every check passed.
if grep -ihE 'download|huggingface' "$SCRATCH"/fluid-*.log >/dev/null 2>&1; then
  log "the servers logged download activity while off the network:"
  grep -ihE 'download|huggingface' "$SCRATCH"/fluid-*.log | cut -c1-200 | sort -u | head -n 10
fi

[[ "$CHECKED" -gt 1 ]] || skip "nothing could be checked beyond the model directories"
log "passed ($SKIPPED skipped)"
