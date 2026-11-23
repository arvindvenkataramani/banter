# Configuration

Two files per node, both at the top of its deployment folder (`~/services/banter` by default):

- **`registry.json`** — hosts and services
- **`config.json`** — gateway credentials and voice settings

The repo tracks `config.example.json` and `registry.example.json` (under `control/control-plane/data/`; the shard's registry example is under `control/control-shard/data/`), not the live files. `ops/install.sh` seeds the live files from them, and every later deploy merges the examples into them; see [Deployment](#deployment). Beside the two files the folder holds `shipped/` (what the last deploy shipped, the merge base) and `state/state.json` (the last agent used and the last session per agent). [design/live-config.md](design/live-config.md) describes how these files are kept.

A normal run needs no environment variables.

---

## The minimum

This is everything required to get a working single-machine deploy. Nothing else in this document is needed to start.

**`config.json`** — point it at your OpenClaw gateway:

```json
{
  "version": 3,
  "integrations": {
    "openclaw": {
      "gateway": {
        "url": "wss://your-gateway.example.com",
        "token": "your-gateway-token"
      }
    }
  }
}
```

**`registry.json`** — one host, the control plane itself, and whatever model servers you have running:

```json
{
  "version": 3,
  "type": "control",
  "hosts": [
    { "id": "box", "name": "box", "hostname": "box.local", "role": "control" }
  ],
  "capabilities": [
    { "id": "control", "name": "Control Plane" },
    { "id": "stt", "name": "Speech-to-Text" },
    { "id": "tts", "name": "Text-to-Speech" }
  ],
  "services": [
    {
      "id": "control",
      "name": "Control Plane",
      "capabilityId": "control",
      "hostId": "box",
      "permissions": { "enabled": true, "protected": true },
      "runner": { "type": "systemd", "unit": "banter", "unitFile": "ops/systemd/banter.service.template" },
      "network": { "port": 4200, "healthPath": "/api/health" },
      "lifecycle": { "loadStrategy": "startup", "idleUnload": false }
    }
  ],
  "shards": []
}
```

The `control` entry is required: the control plane reads its own listening port from it.

That is a working deploy with no voice. Register an STT and a TTS service to get the rest.

---

## Adding a service

A service entry answers four questions: what it is, where it runs, how to start it, and how to tell whether it is healthy.

```json
{
  "id": "tts-kokoro",
  "name": "Kokoro",
  "capabilityId": "tts",
  "hostId": "box",
  "permissions": { "enabled": true, "protected": false },
  "runner": {
    "type": "process",
    "main": ".venv/bin/uvicorn server:app --host 127.0.0.1 --port {port}"
  },
  "ops": {
    "env": {
      "workingDirectory": "~/services/tts/kokoro",
      "variables": { "KOKORO_CORS_ORIGINS": "http://localhost:4200,http://localhost:5173" }
    }
  },
  "network": { "port": 8002, "healthPath": "/health" },
  "lifecycle": { "loadStrategy": "demand", "idleUnload": true, "idleTimeout": 1800000 }
}
```

`capabilityId` must match an entry in `capabilities`. The voice config selects services by id, so `voice.stt.serviceId` and `voice.tts.selection.serviceId` both refer to these.

A TTS service entry alone doesn't make it selectable: `voice.tts.selection` names a roster model and voice, so the service also needs a `roster.providers` entry whose `serves` names at least one declared model, and at least one voice with a rendering on that model. `voice.stt.serviceId` is checked against the registry directly and needs no roster entry, though a roster `sttModels` entry served by the provider is still how a server that reads the roster declares what it can load (`fluid-stt`, for example). See [voices-and-models.md#adding-another-model-or-another-speech-server](../guide/voices-and-models.md#adding-another-model-or-another-speech-server) for the roster entry that goes with a service like the one above.

### Choosing a runner

| `runner.type` | Use when | Needs |
|---|---|---|
| `process` | You want Banter to spawn it directly | `main` — the command, split on spaces |
| `systemd` | It is a systemd user unit | `unit`, `unitFile` |
| `launchd` | It is a launchd agent (macOS) | `label`, `plist` |
| `external` | It is already running and Banter should only watch it | nothing |
| `managed` | It has its own CLI for start/stop/health | `startCmd`, `stopCmd`, `healthCmd` |

Use `external` for anything you manage yourself: another machine's service, a container, anything already running. Banter health-checks and routes to it without ever starting or stopping it.

The `control` entry's `unitFile` points at `banter.service.template`, not a plain `.service` file — it has `__PROD__`/`__UNIT__` placeholders because the deploy path isn't known until install time. The install script fills those in and installs the result *before* it reads the registry at all, so this entry's `unitFile` is never copied as-is by the registry-driven step (which skips `id: "control"` for exactly that reason); it's declared here only because `unit`/`unitFile` are required together, and `service-control.sh` needs `unit` to restart the control plane by hand.

The service's port is written once, in `network.port`. A `process` runner's `runner.main` marks where it goes with `{port}` (for example `--port {port}`), and the runner also gets `PORT` in its environment. The registry refuses at load a literal port in `runner.main` and a `PORT` in `ops.env.variables`.

### Demand-loading

`loadStrategy: "demand"` starts the service on first use instead of at boot, and `idleUnload` with an `idleTimeout` in milliseconds evicts it after inactivity. This is why the control plane exists: a speech model that takes seconds to load need not sit resident all day.

`loadStrategy: "startup"` starts it with Banter. `protected: true` prevents Banter from stopping it.

### Endpoints and schemes

The endpoint is derived at load time: `scheme://host:port`. The host comes from the service's `hostId`, or from `listenAddress` if set.

The scheme defaults to `http`. Set `scheme: "https"` when something terminates TLS in front of the service — a reverse proxy, a self-signed cert, Tailscale Serve, any ingress. Nothing else infers it. `https` is the safer choice wherever you can have it, and a phone needs it to use the microphone; see [Why https](../guide/remote-access.md#why-https).

If most of your services are https, set it once for the whole registry:

```json
"defaults": { "network": { "scheme": "https" } }
```

### CORS

Banter talks to model servers **from the browser**, so those servers must allow Banter's origin.

Each speech server takes its allowlist from an environment variable, set under the service's `ops.env.variables`. Every Python adapter in this repo reads a comma-separated `*_CORS_ORIGINS` variable (`FASTER_WHISPER_CORS_ORIGINS`, `KOKORO_CORS_ORIGINS`, `NEUTTS_CORS_ORIGINS`, `WHISPER_CORS_ORIGINS`), and the [fluid servers](../../services/fluid/README.md) read `FLUID_CORS_ORIGINS`. Unset, they add no CORS headers at all: not "allow everything," but no allowlist means every cross-origin request from the browser is refused. `ops/install.sh` fills in every `*_CORS_ORIGINS` variable it finds in a fresh registry from the registry's own `control` service port, covering `http://localhost` and `http://127.0.0.1` on that port and on Vite's `5173`:

```json
"ops": {
  "env": {
    "variables": { "KOKORO_CORS_ORIGINS": "http://localhost:4200,http://127.0.0.1:4200,http://localhost:5173,http://127.0.0.1:5173" }
  }
}
```

Third-party servers vary: some take a variable or flag (for example `PARAKEET_CORS_ORIGINS` for `parakeet-mlx-fastapi`, `--allowed-origins` for `mlx-audio`), others are permissive or have no setting. Check a server's own docs for the name. [speech-servers.md](../guide/speech-servers.md#cors) has a check you can run against any server.

The origins `install.sh` writes cover only the machine itself. Opening Banter from another address, such as a LAN IP (`http://192.168.1.20:4200`) or an https hostname, means adding that origin to every speech server's allowlist. A shard's example registry carries placeholder https tailnet origins; replace them with the origins you use.

A missing origin here is the most common cause of "voice transcription failed" on a healthy service: it answers `curl` fine, the browser is refused, and the browser cannot say why. Changing the port Banter runs on means updating these. Tailscale Serve does not add these headers — a service reached over the tailnet still needs its own origin list.

**The gateway has its own allowlist, separate from any speech server's.** Browser-origin WebSocket clients — the web app included — are checked against `gateway.controlUi.allowedOrigins` in the OpenClaw gateway's own config, not Banter's. `ops/install.sh` tells you to add `http://localhost:PORT` there; add every other origin you open Banter from, such as a LAN address, too. An origin missing there fails to connect to the gateway even when every speech server's CORS is correct. See [docs/reference/protocols/openclaw/gateway-session-lifecycle.md](protocols/openclaw/gateway-session-lifecycle.md#browser-origin-check).

---

## Adding a shard

A shard is another machine running its own control plane, so the primary can reach services it cannot start itself. Add as many as you like — the registry takes a list of hosts and the primary polls each. Skip this for single-machine installs.

**On the primary**, add the worker host and a `shards` entry:

```json
"hosts": [
  { "id": "box", "name": "box", "hostname": "box.local", "role": "control" },
  { "id": "gpu", "name": "gpu", "hostname": "gpu.local", "role": "worker" }
],
"shards": [
  { "hostId": "gpu", "port": 4200 }
]
```

The primary polls that endpoint and merges the worker's services into one view. Add `"scheme": "https"` to the shard entry if the worker is behind TLS.

Leave the worker's services out of the primary's registry. The shard owns them and reports them upward; duplicating them creates two sources of truth.

**On the worker**, install the shard with its own registry (`"type": "shard"`) describing the services it hosts. See [shard.md](../guide/shard.md).

---

## Voice

Under `voice` in `config.json`. The pieces that matter (the service ids and models are examples; use the ones in your registry and roster):

```json
"voice": {
  "enabled": true,
  "stt": { "serviceId": "stt-faster-whisper", "preferStreaming": false },
  "tts": {
    "selection": { "serviceId": "tts-kokoro", "model": "kokoro-82m", "voice": "heart", "speed": 1 },
    "options": { "chunkStrategy": "greedy", "minChunkWords": 15, "maxChunkWords": 60 },
    "settingsScope": "global",
    "modelPrefs": {}
  }
}
```

`serviceId` values must match registry entries. A batch-only STT server leaves `voice.stt.model` unset; a server with streaming or loadable models names one there, as in [stt.md](../guide/stt.md#fluid-stt). `selection.model` and `selection.voice` name a roster model id and a roster voice id, and `selection.serviceId` the runtime that serves the model — the roster is what declares which ones exist, not `config.json`. See [voices-and-models.md](../guide/voices-and-models.md) for what a roster model and voice are, and how to add or change them.

Banter's settings dialog writes back to `selection` — the STT picker appears when the registry holds at least one STT service. `voice.tts.providers` does not exist in `config.json`; `GET /api/voice` returns the assembled roster under `tts.models`, `tts.providers` and `tts.voices` for Banter to read, but nothing writes it back.

### Settings scope

`settingsScope` decides whether your settings apply everywhere or per model:

| Value | Resolution, per field |
|---|---|
| `"global"` | your `options` only |
| `"per-model"` | model override → model's own defaults → your `options` |

Anything other than an explicit `"global"` — including the field being absent — resolves as `"per-model"`. With no overrides stored the two behave identically, since the chain falls through to your `options` either way.

Under `"global"`, `modelPrefs` is ignored. Under `"per-model"`, edits in the settings dialog land in `modelPrefs` keyed by service and model id, and each holds only the fields actually changed — global remains the backstop, so a partial override never leaves a field unfilled.

Both are managed from the settings dialog. `modelPrefs` starts empty and is written for you; hand-editing it is possible but rarely necessary.

The `vad` and `turnTaking` blocks tune when the system decides you have finished speaking. The defaults in `config.example.json` are reasonable starting points; `minSpeechProb` and `smartTurnThreshold` are the two worth adjusting if it cuts you off or waits too long.

### Field reference

Every field `config.json` accepts. Every field is optional except `version`. A "default" below is what the code uses when the field is absent; `config.example.json` ships some different values, noted where they differ. The schema is in `control/shared/src/live-config/schemas.ts`.

#### Top level

| Field | Purpose |
|---|---|
| `version` | Schema version; `3`. |
| `timezone` | An IANA timezone name. The schema accepts it and keeps it for compatibility with the platform schema; Banter does not read it. |
| `runtime` | See [Runtime settings](#runtime-settings). |
| `integrations.openclaw.gateway.url`, `.token` | The OpenClaw gateway's address and token. A token written as `"${NAME}"` is read from the environment variable `NAME` when the control plane serves it; if that variable is unset the token resolves to nothing and the gateway connection is unauthenticated. |
| `integrations.openclaw.defaultSession` | Session name the web app opens when nothing else is selected. Default: `main`. |

#### `voice`

| Field | Purpose |
|---|---|
| `enabled` | Accepted by the schema, which follows the platform schema; Banter does not read it. |
| `takeover` | What a voice session does when a voice server it wants, TTS or STT, is held by another session. `"ask"` (default) ends voice with a dialog offering to take it over; `"always"` takes over without asking, on every connection the session makes. |
| `debug.saveMicSamples` | Boolean, default `false`. Saves microphone captures to disk, and only takes effect when the control plane runs with the `DEBUG` environment variable set. See `MIC_SAMPLE_DIR` under [Deployment](#deployment). |

#### `voice.stt`

| Field | Default | Purpose |
|---|---|---|
| `serviceId` | none | Registry id of the STT service. It is started on demand and its endpoint is resolved from the registry. |
| `model` | none | The model the STT service loads for a voice session. A server holding nothing at start loads this before the first utterance. Leave it unset for a batch-only server. |
| `preferStreaming` | `false` | For a model that offers both batch and streaming, take the streaming side: words appear as you speak. Batch transcribes on each pause, so words appear only after it, with no live preview. Only models reporting both consult it; set from the settings dialog's Transcription mode. |
| `chunkMs` | server's own | Which streaming latency tier to load, for a model that offers a choice. |
| `maxRecordingMs` | `300000` | Longest an utterance may run before it is force-flushed to transcription, whatever turn detection says. A safety net against a wedged detector, not a turn-taking setting. |
| `settleOnStopMs` | `1500` | How long turning voice off waits for an utterance still being heard, or held paused, to finish transcribing before closing the transport regardless. |
| `pauseFlushMs` | `1500` | How long a paused utterance keeps streaming silence in the microphone's place. A streaming model only produces text for audio it holds as further audio arrives behind it, so without this the last words said before a mute would not appear until unmute. |
| `reveal.minIntervalMs` | `55` | Fastest interval between words revealed in the composer as a streaming partial arrives. |
| `reveal.maxIntervalMs` | `200` | Slowest such interval. |
| `reconnect.attempts` | `3` | Failed connections in a row after which voice ends when the streaming socket drops. `0` ends voice on the first drop. Words the dropped socket had not finalized are lost. |
| `reconnect.delayMs` | `1000` | How much longer each attempt after the first waits than the one before it. The first attempt goes at once. |
| `reconnect.stableMs` | `10000` | How long a socket must stay up before its drop starts a fresh count. One that drops sooner counts as a failure. |
| `options` | assembled | Not written by hand: `GET /api/voice` fills it from the registry's STT services (`serviceId`, `name`, `sessions`) for the settings dialog's picker. |

`vad` decides whether captured sound is speech at all:

| Field | Default | Purpose |
|---|---|---|
| `vad.minSpeechDurationS` | `0.75` | Seconds of speech before an utterance counts as confirmed rather than noise. |
| `vad.minSpeechProb` | `0.7` | Peak speech probability the utterance must also reach. A cough never crosses both gates. The example ships `0.9`. |

`turnTaking` decides when a pause is detected and how long to wait before committing the turn. The wait is adaptive: shorter when the smart-turn model is confident the speaker is done, longer when it is not.

| Field | Default | Purpose |
|---|---|---|
| `turnTaking.pauseThresholdMs` | `250` | Milliseconds of silence that count as a pause. The first stage of the two-stage commit gate. The microphone never stops; a pause is a purely logical state. The example ships `300`. |
| `turnTaking.commitMinDelayMs` | `250` | Wait after a pause when smart-turn confidence is at or above `smartTurnThreshold`. The example ships `300`. |
| `turnTaking.commitMaxDelayMs` | `2000` | Wait after a pause when confidence is below `smartTurnLowCutoff`. The example ships `1400`. |
| `turnTaking.smartTurnThreshold` | `0.7` | Confidence (0 to 1) at or above which the turn is treated as clearly done. The example ships `0.9`. |
| `turnTaking.smartTurnLowCutoff` | `0.15` | Confidence (0 to 1) below which the turn is treated as clearly not done. |
| `turnTaking.curve` | power, exponent `2` | Shape of the interpolation between the max and min delay for confidence between `smartTurnLowCutoff` and `smartTurnThreshold`. |
| `turnTaking.interruptionMinRemainingS` | `0.5` | Seconds of agent audio that must remain for a barge-in to count as interrupting speech. Not set from the settings dialog. |

Values written through the settings dialog must be non-negative, and probabilities at most 1; the control plane refuses a patch that is not. A field the dialog resets is sent as `null`, which removes it from `config.json` so the engine default applies; an emptied `vad` or `turnTaking` block stays as `{}`.

`curve` takes one of two forms:

- `{ "type": "power", "exponent": 2 }`: `1` is linear; `2` is patient through most of the band with a sharp drop near the threshold; higher is more patient for longer with a steeper drop at the end.
- `{ "type": "sigmoid", "center": 0.5, "steepness": 8 }`: an S-curve. `center` (0 to 1) is where in the band the delay drops fastest; higher `steepness` approaches a step, lower approaches linear. The loop reads both.

#### `voice.tts`

Nothing here declares what exists: models, voices, what each model calls them and each model's chunking and request settings are the roster's, declared in each node's `registry.json` and assembled by the control plane. `GET /api/voice` builds voice mode's choices from the roster and the registry.

| Field | Purpose |
|---|---|
| `selection.serviceId`, `.model`, `.voice` | The chosen runtime (a service id), roster model id and roster voice id. The control plane has the shard on the runtime's host resolve them, and serves the answer as `tts.selection.request` in `GET /api/voice`; the web app sends it to the TTS server unchanged, and `requestError` says why when they cannot be resolved. |
| `selection.speed` | Between `0.5` and `2.0`; `1` when unset. |
| `options.chunkStrategy` | `two-chunk`, `paragraph`, `sentence` or `greedy`. When nothing sets it, `two-chunk`. |
| `options.minChunkWords` | The shortest piece spoken on its own. A sentence shorter than this is held and joined with what follows, so very short phrases do not reach the TTS service without context for natural prosody. |
| `options.maxChunkWords` | Upper bound on words per chunk, used by the `sentence` and `greedy` strategies. When the buffer reaches it, the text is split at the latest sentence, clause or line break inside the limit; if none exists in that window, at the nearest boundary after it, so a chunk can run slightly over. A short lead-in sentence is only merged with what follows while the total stays within it. |
| `modelPrefs` | Per-model overrides, keyed by service id and then roster model id, each `{ "chunking": { "mode", "minWords", "maxWords" } }` holding only the fields changed. Used only under `settingsScope: "per-model"`. |
| `settingsScope` | `"global"` or `"per-model"`; see [Settings scope](#settings-scope). |

---

## Runtime settings

Optional. Under `runtime` in `config.json`:

| Key | Default | Purpose |
|---|---|---|
| `host` | `localhost` | Bind address |
| `eventsPath` | `logs/events.jsonl` in the deployment | Event log |

The listening port is **not** here — it comes from the registry's `control` service entry, so it is declared in one place rather than two that can disagree. Loop intervals are not here either: they live in `registry.json` under `intervals` (`healthMs`, and on the control plane `shardPollMs`, each defaulting to `900000`). See [registry.md](components/registry.md).

Each has an environment override (`BANTER_CONTROL_HOST`, `BANTER_EVENTS_PATH`, `BANTER_HEALTH_INTERVAL_MS`, `BANTER_SHARD_POLL_INTERVAL_MS`, and `BANTER_CONTROL_PORT`), useful for local experiments. None is required.

---

## Deployment

| Variable | Default | Purpose |
|---|---|---|
| `BANTER_PROD` | `~/services/banter` | Install location |
| `BANTER_UNIT` | `banter` | systemd unit name |
| `BANTER_LIVE_DIR` | `$BANTER_PROD` | Live directory: `config.json`, `registry.json`, `shipped/`, `state/` |
| `BANTER_REGISTRY_PATH` | `$BANTER_LIVE_DIR/registry.json` | Registry file |
| `BANTER_CONFIG_PATH` | `$BANTER_LIVE_DIR/config.json` | Config file |
| `DASHBOARD_DIST` | `dashboard/dist` | Built assets to serve |
| `MIC_SAMPLE_DIR` | `banter-voice-debug/mic-samples` in the OS temp directory | Where `DEBUG` mic captures land; set it to keep them somewhere durable |

`BANTER_PROD` and `BANTER_UNIT` are better set in `ops/deploy.conf` (copy `deploy.conf.example`) than exported on every call — it is an untracked per-machine file that all the scripts read. It stays in the checkout's `ops/` because it names the deployment folder; a deploy copies it into `$BANTER_PROD/ops/`, so the scripts systemd runs read the same settings. They must be set together; `deploy-env.sh` refuses a non-default directory under the default unit name, since every start and stop would address the other install.

A unit file cannot expand a shell variable, so `ops/systemd/banter.service.template` is rendered at install time with the deploy path and unit name substituted in, and the rendered unit passes `BANTER_PROD` back to the runner through `Environment=`.

`control-deploy.sh` runs `deploy-preflight.sh` first, which refuses when the destination is non-empty and was not created by a previous banter deploy or install, or when the unit name belongs to something running elsewhere. It is a refusal, not a prompt; override deliberately with `BANTER_DEPLOY_FORCE=1`.

A deploy replaces only the code folders it names (`control/`, `dashboard/`, `shared/`, `ops/`), so it never touches `config.json`, `registry.json`, `shipped/` or `state/`. What it does with them is a three-way merge of the last-shipped copy (`shipped/`), the live file and the repo's example, field by field, before anything is stopped:

- changed only in the repo, the repo's value is taken;
- changed only on the node (by hand, or through Banter's settings), the node's value stays;
- changed on both to different values, the deploy stops, names the fields and writes nothing. Resolve it by editing the live file or the example, then deploy again.

A field in the live file that the code does not know is kept, with a warning in the log. There is no prompt: to start over from an example, delete the live file and deploy.

The first deploy has no `shipped/` copy, so it takes the example as the base and keeps every value in the live file. Where the live file is missing, a first deploy seeds it from `$BANTER_PROD/control/control-plane/data/{config,registry}.json` (for a shard, `~/services/shard/registry.json`) when that file exists, and otherwise from the example.

Every load of `config.json` and `registry.json` also brings the file into line with its schema: missing fields get defaults, values are kept, and a value of the wrong type stops startup with a message naming the field. The control plane exits on an unreadable or invalid `config.json`. A setting saved from Banter is saved by changing that one field in the file on disk, so a hand edit made since startup survives. The last agent used and the last session per agent are not in `config.json`; they live in `state/state.json` and are never merged.

---

## Reloading

Banter's settings menu has a **Reload config** action, which hits `POST /api/config/reload`: it re-reads both `config.json` and `registry.json` without restarting the control plane.

The registry's `services`, `hosts`, `capabilities` and `defaults` all reload the same way — the in-memory copy is replaced from the file. A service already running keeps running as it was until you restart it; a service removed from the registry while still running is only reported, not stopped. The `shards` list is the one part reload never applies: a changed entry is reported but the running list is left as it was, so adding or removing a shard needs a restart of the control plane itself.

A registry roster's `voices[]` — which voices exist and how each model renders them — takes effect on that reload alone for a runtime the shard resolves for, since the control plane assembles voices fresh on every request. A runtime that reads the registry itself does not: a server such as `fluid-tts` reads its provider's roster section, its models and the voices once, at startup, so the reload only reports a `provider-changed` warning naming the service and you restart it yourself. A changed `providers` section, or a changed model a provider serves, is reported the same way. See [voices-and-models.md#applying-an-edit](../guide/voices-and-models.md#applying-an-edit).
