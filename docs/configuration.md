# Configuration

Two files, both per-deployment and both gitignored. Copy the `.example.json` next to each and edit:

- **`control/control-plane/data/registry.json`** — hosts and services
- **`control/control-plane/data/config.json`** — gateway credentials and voice settings

A normal run needs no environment variables.

---

## The minimum

This is everything required to get a working single-machine deploy. Nothing else in this document is needed to start.

**`config.json`** — point it at your OpenClaw gateway:

```json
{
  "version": 2,
  "integrations": {
    "openclaw": {
      "gateway": {
        "url": "wss://your-gateway.example.com",
        "token": "your-gateway-token"
      },
      "defaultAgent": "main"
    }
  }
}
```

**`registry.json`** — one host, the control plane itself, and whatever model servers you have running:

```json
{
  "version": 2,
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

That is a working deploy with no voice. Add an STT and a TTS service to get the rest.

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
    "main": ".venv/bin/uvicorn server:app --host 127.0.0.1 --port 8002"
  },
  "ops": {
    "env": { "workingDirectory": "~/services/tts/kokoro" }
  },
  "network": { "port": 8002, "healthPath": "/health" },
  "lifecycle": { "loadStrategy": "demand", "idleUnload": true, "idleTimeout": 1800000 }
}
```

`capabilityId` must match an entry in `capabilities`. The voice config selects services by id, so `voice.stt.serviceId` and `voice.tts.selection.serviceId` both refer to these.

A TTS service entry alone doesn't make it selectable: `voice.tts.selection` names a roster model and voice, so the service also needs a `roster.providers` entry with at least one model and one voice able to reach it. `voice.stt.serviceId` is checked against the registry directly and needs no roster entry, though a roster `sttModels` list is still how `fluid-stt` declares what it can load. See [docs/voices-and-models.md#adding-another-model-or-another-speech-server](voices-and-models.md#adding-another-model-or-another-speech-server) for the roster entry that goes with a service like the one above.

### Choosing a runner

| `runner.type` | Use when | Needs |
|---|---|---|
| `process` | You want the platform to spawn it directly | `main` — the command, split on spaces |
| `systemd` | It is a systemd user unit | `unit`, `unitFile` |
| `launchd` | It is a launchd agent (macOS) | `label`, `plist` |
| `external` | It is already running and the platform should only watch it | nothing |
| `managed` | It has its own CLI for start/stop/health | `startCmd`, `stopCmd`, `healthCmd` |

Use `external` for anything you manage yourself: another machine's service, a container, anything already running. The platform health-checks and routes to it without ever starting or stopping it.

The `control` entry's `unitFile` points at `banter.service.template`, not a plain `.service` file — it has `__PROD__`/`__UNIT__` placeholders because the deploy path isn't known until install time. The install script fills those in and installs the result *before* it reads the registry at all, so this entry's `unitFile` is never copied as-is by the registry-driven step (which skips `id: "control"` for exactly that reason); it's declared here only because `unit`/`unitFile` are required together, and `service-control.sh` needs `unit` to restart the control plane by hand.

`runner.main` carries its own `--port`, independent of `network.port`. They must agree; the control plane warns on load if they differ.

### Demand-loading

`loadStrategy: "demand"` starts the service on first use instead of at boot, and `idleUnload` with an `idleTimeout` in milliseconds evicts it after inactivity. This is why the control plane exists: a speech model that takes eight seconds to load has no business sitting resident all day.

`loadStrategy: "startup"` starts it with the platform. `protected: true` prevents the dashboard from stopping it.

### Endpoints and schemes

The endpoint is derived at load time: `scheme://host:port`. The host comes from the service's `hostId`, or from `listenAddress` if set.

The scheme defaults to `http`. Set `scheme: "https"` when something terminates TLS in front of the service — a reverse proxy, a self-signed cert, Tailscale Serve, any ingress. Nothing else infers it.

If most of your services are https, set it once for the whole registry:

```json
"defaults": { "network": { "scheme": "https" } }
```

### CORS

The dashboard talks to model servers **from the browser**, so those servers must allow the dashboard's origin.

Both [fluid servers](../services/fluid/README.md) (`fluid-stt`, `fluid-tts`) read one comma-separated environment variable, `FLUID_CORS_ORIGINS`. Unset, they add no CORS headers at all — not "allow everything," but no allowlist means every cross-origin request from the browser is refused. `scripts/install.sh` sets it for you from the registry's own `control` service port, covering both `localhost` and `127.0.0.1` on that port and on Vite's `5173`:

```json
"ops": {
  "env": {
    "variables": { "FLUID_CORS_ORIGINS": "http://localhost:4200,http://127.0.0.1:4200,http://localhost:5173,http://127.0.0.1:5173" }
  }
}
```

Other servers vary — `tts/kokoro` and `tts/neutts-air` are permissive and need no configuration; `WHISPER_CORS_ORIGINS` for `stt/whisper`, `PARAKEET_CORS_ORIGINS` for `parakeet-mlx-fastapi`, `--allowed-origins` for `mlx-audio`. Check a server's own docs for the name.

A missing origin here is the most common cause of "voice transcription failed" on a healthy service: it answers `curl` fine, the browser is refused, and the browser cannot say why. Changing the dashboard's port means updating these. Note that Tailscale Serve does not add these headers — a service reached over the tailnet still needs its own origin list.

**The gateway has its own allowlist, separate from any speech server's.** Browser-origin WebSocket clients — the dashboard included — are checked against `gateway.controlUi.allowedOrigins` in the OpenClaw gateway's own config, not Banter's. A dashboard origin missing there fails to connect to the gateway even when every speech server's CORS is correct. See [docs/gateway/openclaw/gateway-session-lifecycle.md](gateway/openclaw/gateway-session-lifecycle.md#browser-origin-check).

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

**On the worker**, install the shard with its own registry (`"type": "shard"`) describing the services it hosts. See [shard-setup.md](./shard-setup.md).

---

## Voice

Under `voice` in `config.json`. The pieces that matter:

```json
"voice": {
  "enabled": true,
  "stt": { "serviceId": "fluid-stt", "model": "parakeet-unified-0.6b", "preferStreaming": true },
  "tts": {
    "selection": { "serviceId": "fluid-tts", "model": "kokoro-ane", "voice": "heart", "speed": 1 },
    "options": { "chunkStrategy": "greedy", "minChunkWords": 15, "maxChunkWords": 60 },
    "settingsScope": "global",
    "modelPrefs": {}
  }
}
```

`serviceId` values must match registry entries. `selection.model` and `selection.voice` name a roster model and a roster voice (or a preset id nothing else claims) — the roster is what declares which ones exist, not `config.json`. See [docs/voices-and-models.md](voices-and-models.md) for what a roster model and voice are, and how to add or change them.

The dashboard's settings dialog writes back to `selection` — the STT picker only appears when more than one STT service is registered. `voice.tts.providers` does not exist in `config.json`; `GET /api/voice` returns the assembled roster under that key for the dashboard to read, but nothing writes it back.

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

---

## Runtime settings

Optional. Under `runtime` in `config.json`:

| Key | Default | Purpose |
|---|---|---|
| `host` | `localhost` | Bind address |
| `eventsPath` | `logs/events.jsonl` in the deployment | Event log |
| `healthIntervalMs` | `900000` | Health check interval |
| `shardPollIntervalMs` | `900000` | Shard poll interval |

The listening port is **not** here — it comes from the registry's `control` service entry, so it is declared in one place rather than two that can disagree.

Each has an environment override (`BANTER_CONTROL_HOST`, `BANTER_EVENTS_PATH`, `BANTER_HEALTH_INTERVAL_MS`, `BANTER_SHARD_POLL_INTERVAL_MS`, and `BANTER_CONTROL_PORT`), useful for local experiments. None is required.

---

## Deployment

| Variable | Default | Purpose |
|---|---|---|
| `BANTER_PROD` | `~/services/banter` | Install location |
| `BANTER_UNIT` | `banter` | systemd unit name |
| `BANTER_REGISTRY_PATH` | `control/control-plane/data/registry.json` | Registry file |
| `BANTER_CONFIG_PATH` | `control/control-plane/data/config.json` | Config file |
| `DASHBOARD_DIST` | `dashboard/dist` | Built assets to serve |
| `MIC_SAMPLE_DIR` | `~/services/banter/debug/mic-samples` | Where `DEBUG` mic captures land |

`BANTER_PROD` and `BANTER_UNIT` are better set in `scripts/deploy.conf` (copy `deploy.conf.example`) than exported on every call — it is an untracked per-machine file that all the scripts read. They must be set together; `deploy-env.sh` refuses a non-default directory under the default unit name, since every start and stop would address the other install.

A unit file cannot expand a shell variable, so `ops/systemd/banter.service.template` is rendered at install time with the deploy path and unit name substituted in, and the rendered unit passes `BANTER_PROD` back to the runner through `Environment=`.

`control-deploy.sh` runs `deploy-preflight.sh` first, which refuses when the destination is non-empty and was not created by a previous banter deploy, or when the unit name belongs to something running elsewhere. It is a refusal, not a prompt; override deliberately with `BANTER_DEPLOY_FORCE=1`.

Both config files live inside the deployed tree, which a deploy removes and rebuilds. The deploy sets them aside first and puts them back afterwards, so your settings survive; the shipped examples are used only where there was nothing to preserve, which is a first deploy.

To start over from the examples instead — a registry edited into a state that no longer loads, say — pass `--reset-config`. An interactive deploy that finds live configuration asks which you want; an unattended one always keeps what is there, since silence is not consent.

---

## Reloading

The dashboard's settings menu has a **Reload config** action, which hits `POST /api/config/reload`: it re-reads both `config.json` and `registry.json` without restarting the control plane.

The registry's `services`, `hosts`, `capabilities` and `defaults` all reload the same way — the in-memory copy is replaced from the file. A service already running keeps running as it was until you restart it; a service removed from the registry while still running is only reported, not stopped. The `shards` list is the one part reload never applies: a changed entry is reported but the running list is left as it was, so adding or removing a shard needs a restart of the control plane itself.

A registry roster's `voices[]` — which voices exist and what they map to — takes effect on that reload alone, since the control plane assembles voices fresh on every request. A changed `providers` section — a new model, a changed preset list, and so on — does not: `fluid-stt` and `fluid-tts` read their provider's roster section once, at startup, so the reload only reports a `provider-changed` warning naming the service and you restart it yourself. See [docs/voices-and-models.md#applying-an-edit](voices-and-models.md#applying-an-edit).
