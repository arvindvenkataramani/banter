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

`capabilityId` must match an entry in `capabilities`. The voice config selects services by id, so `voice.stt.serviceId` and the TTS provider's `serviceId` both refer to these.

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

The dashboard talks to model servers **from the browser**, so those servers must allow the dashboard's origin. Most adapters read a comma-separated environment variable:

```json
"ops": {
  "env": {
    "variables": { "KOKORO_CORS_ORIGINS": "https://box.local:4200" }
  }
}
```

A missing origin here is the most common cause of "voice transcription failed" on a healthy service: it answers `curl` fine, the browser is refused, and the browser cannot say why. Changing the dashboard's port means updating these.

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
  "stt": { "serviceId": "stt-whisper" },
  "tts": {
    "providers": [
      {
        "serviceId": "tts-kokoro",
        "models": [
          { "id": "hexgrad/Kokoro-82M", "voices": [{ "id": "af_heart", "name": "Heart" }] }
        ]
      }
    ],
    "selection": { "serviceId": "tts-kokoro", "model": "hexgrad/Kokoro-82M", "voice": "af_heart" }
  }
}
```

`serviceId` values must match registry entries. The dashboard's settings dialog writes back to `selection` — the STT picker only appears when more than one STT service is registered.

### Adding a TTS provider or model

`providers` is a catalogue, not a fixed list: the settings dialog offers exactly what is declared here, so a provider or model exists for the app once it appears in this array and nowhere else.

To add a **provider**, append an entry with its `serviceId` (matching a registry entry) and at least one model. To add a **model** to an existing provider, append to that provider's `models`. A model needs an `id` the service will accept and a `voices` array; voice `id` values are passed through to the service, and `name` is only what the dialog shows.

```json
{
  "serviceId": "tts-yourservice",
  "name": "Your Service",
  "models": [
    {
      "id": "vendor/model-name",
      "name": "Model Name",
      "voices": [{ "id": "voice-id", "name": "Voice Name" }]
    }
  ]
}
```

The example config ships one provider with one model to show the shape. It is a worked example rather than a recommendation — nothing is preloaded with presets, and no model is special to the app.

A model may also carry its own `options` block with the same chunking keys used globally. Declaring one is optional and only matters under per-model scope, below.

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

The dashboard's settings menu has a **Reload config** action, which re-reads `config.json` without restarting. Registry changes need a restart.
