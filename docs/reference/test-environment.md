# Test environment

A test environment runs a branch's control plane and fluid servers from a scratch directory, beside whatever is already installed on the machine, so a change can be tried end to end, from a browser or the dsh plugin, without deploying it. It reuses the speech models already on disk and changes nothing deployed. The only outside change is the dsh plugin's Banter server URL, which you set back when you finish.

`bun run control-dev` is the lighter option when the change is in the control plane or dashboard only. It reads the deployed config and registry and talks to the deployed speech servers. Use a test environment when the speech servers themselves changed, when the change is in how the registry or config are read, or when there is no Banter install on the machine to borrow from.

The steps below assume Apple Silicon (the fluid servers need it), the repo's dependencies installed with `bun install`, and `jq`. Commands run from the repository root.

## 1. Build

```bash
scripts/fluid-build.sh
(cd dashboard && bun run build)
```

The fluid build checks its toolchain first and says what is missing. The dashboard build is what the control plane serves.

## 2. Make the live directory

Pick a scratch directory and two free ports for the speech servers. Choose ports no running server uses: `lsof -iTCP -sTCP:LISTEN -P` lists them.

```bash
T=/var/tmp/banter-test        # anywhere outside the repo and any deployed folder
STT_PORT=8867 TTS_PORT=8869
mkdir -p "$T/logs" "$T/services/fluid-stt/logs" "$T/services/fluid-tts/logs"
```

The registry is the control-plane example with the fluid servers merged in. The control service becomes `external` because you run it by hand. Each fluid service gets its port and a working directory under `$T`. The roster takes the fluid providers, models and voices.

```bash
jq --slurpfile fl services/fluid/registry.fluid.example.json --arg wd "$T/services" \
   --argjson stt "$STT_PORT" --argjson tts "$TTS_PORT" '
  .services = ([.services[] | select(.id == "control") | .runner = {type: "external"}]
    + [$fl[0].services[]
        | .network.port = (if .id == "fluid-stt" then $stt else $tts end)
        | .ops.env.workingDirectory = ($wd + "/" + .id)
        | .ops.env.variables.FLUID_CORS_ORIGINS = "http://localhost:4200"])
  | .roster.providers = $fl[0].roster.providers
  | .roster.sttModels = $fl[0].roster.sttModels
  | .roster.ttsModels = (.roster.ttsModels + $fl[0].roster.ttsModels | unique_by(.id))
  | .roster.voices = (.roster.voices + $fl[0].roster.voices | unique_by(.id))
' control/control-plane/data/registry.example.json > "$T/registry.json"
```

The config is the example with voice pointed at the fluid servers and the event log moved into `$T`:

```bash
jq --arg ev "$T/logs/events.jsonl" '
  .runtime.eventsPath = $ev
  | .voice.tts.selection.serviceId = "fluid-tts"
  | .voice.stt.serviceId = "fluid-stt"
  | .voice.stt.model = "parakeet-unified-0.6b"
' control/control-plane/data/config.example.json > "$T/config.json"
```

To try other settings, edit `$T/config.json` and `POST /api/config/reload`; the control plane picks them up without a restart.

## 3. Install the servers

```bash
for n in fluid-stt fluid-tts; do
  cp -R "services/fluid/.build/release/$n.app" "$T/services/$n/"
  git rev-parse HEAD > "$T/services/$n/SOURCE-COMMIT.txt"
done
```

**If fluid servers built from this repo are already running on the machine,** re-stamp the test copies' bundle identifiers before starting them. At startup each server empties `<temp>/<bundle identifier>/`, so two servers sharing an identifier clear each other's temp files. Servers installed under another identifier need nothing.

```bash
for n in fluid-stt fluid-tts; do
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.banter.test.$n" "$T/services/$n/$n.app/Contents/Info.plist"
  codesign --force --sign - --timestamp=none "$T/services/$n/$n.app"
done
```

## 4. Start the control plane

```bash
(cd control && BANTER_CONTROL_PORT=4200 \
  BANTER_CONFIG_PATH="$T/config.json" BANTER_REGISTRY_PATH="$T/registry.json" \
  BANTER_LIVE_DIR="$T" BANTER_EVENTS_PATH="$T/logs/events.jsonl" \
  DASHBOARD_DIST="$PWD/../dashboard/dist" \
  bun run control-plane/src/index.ts) > "$T/logs/control.log" 2>&1 &
```

Port 4200 is the default for an install. If one is running here, use another port, and add that origin to `FLUID_CORS_ORIGINS` in the registry.

`curl localhost:4200/api/health` answers once it is up. The fluid servers are demand-loaded, so they stay off until voice is turned on. Start them by hand with `POST /api/services/<id>/start`, which is useful for a check before trying voice.

**The models.** The fluid servers are started without `--models-dir`, so they read FluidAudio's per-user folders (`~/Library/Application Support/FluidAudio/Models` and `~/.cache/fluidaudio/Models`). Any other fluid server on the machine that is not given a models directory reads the same folders, so the models already downloaded are used as they are. The servers never download: a model whose weights are not there is refused. The first load in the test environment takes a few seconds longer than usual, while CoreML compiles into the test bundle's own cache.

A quick check, once both are started, synthesises a sentence and transcribes it back. Requests name the roster's model id, not the provider's key:

```bash
curl -s localhost:$TTS_PORT/v1/audio/speech -H 'content-type: application/json' \
  -d '{"model":"kokoro-82m","voice":"heart","input":"Testing one two three.","response_format":"wav"}' -o "$T/t.wav"
curl -s localhost:$STT_PORT/v1/audio/transcriptions -F model=parakeet-unified-0.6b -F file=@"$T/t.wav"
```

## 5. Point the dsh plugin at it

Quit the desktop app fully (⌘Q) and stop `dsh web`, then note the URL the plugin uses now, so you can put it back afterwards:

```bash
grep -A2 'dsh-voice' ~/.dsh/profiles/*/cordis.patch.yml
ops/dsh-plugin-install.sh http://localhost:4200 --link
```

`--link` builds the plugin from this checkout and links each profile to that build. The script changes only the plugin's `controlPlaneUrl` line in each profile's `cordis.patch.yml`. Open dsh again, and the plugin talks to the test environment. The Banter web app is at `http://localhost:4200`.

## 6. Tear down

Quit dsh again and set the plugin back to the URL you noted, linked or copied as it was before:

```bash
ops/dsh-plugin-install.sh <the-earlier-url> --link
```

Then stop the fluid servers through the control plane, stop the control plane, and remove the directory:

```bash
for s in fluid-stt fluid-tts; do curl -s -X POST localhost:4200/api/services/$s/stop; done
kill %1        # or the control plane's pid, from lsof -iTCP:4200 -sTCP:LISTEN
rm -rf "$T"
```

Stop the fluid servers through the API before stopping the control plane: they are its child processes, and killing it does not stop them.
