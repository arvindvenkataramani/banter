# Component: Service Registry

*What the registry is, what it owns, and how it behaves. Every host that runs managed services runs an instance of it.*

---

## What it is

The registry is the source of truth for a host's service topology: which capabilities the host offers, and which services implement them. It answers *what should be running here, and how is it managed?*

It does not contain runtime state. No health, no timestamps, no "last seen." Those live in the event log.

---

## Distributed model

Each host owns its own registry as a static file local to that machine. A control host's registry describes only that host's services. A worker host's registry lives on the worker host, owned by the ControlShard running there.

A shard is optional — a single-machine install has no shard and no cross-host concept at all (see [`../setup/shard.md`](../../guide/shard.md)). When one or more shards are in play, the control plane assembles the full cross-host picture at runtime from shard reports. No config file spans machines. This is intentional:

- **No drift** — each host's config is authoritative only for itself
- **No single point of failure** — hosts are self-contained; the control host going down doesn't lose a worker host's config
- **Derived, not stored** — the global view is assembled at runtime rather than persisted anywhere

---

## Data model

### Top-level fields

| Field | Description |
|-------|-------------|
| `version` | Schema version (currently `2`) |
| `type` | `"control"` or `"shard"` |
| `servicesRoot` | Absolute path to the services directory on this host, for reference (e.g. `~/services`). Working directories in services use absolute paths regardless. |
| `hosts` | Machines this registry knows about |
| `capabilities` | Abstract things the system can do |
| `services` | Concrete processes |
| `shards` | (Control registries only) List of shard endpoints to poll |
| `intervals` | How often this node's loops run, in ms: `healthMs` (health checks) and, on the control plane only, `shardPollMs` (shard poll). Each defaults to `900000`; `BANTER_HEALTH_INTERVAL_MS` and `BANTER_SHARD_POLL_INTERVAL_MS` override them. Read at startup; a reload that finds them changed warns that a restart is needed. |
| `roster` | The models and voices this node's services offer; see [Roster](#roster). Always present on a loaded registry — a registry with none gets an empty one |
| `defaults` | Default values for permissions, network, lifecycle, merged into each service at load time |

### Hosts

| Field | Description |
|-------|-------------|
| `id` | Unique identifier |
| `name` | Human-readable name |
| `hostname` | Network hostname (transport-agnostic, e.g. `control-host.your-tailnet.ts.net`) |
| `role` | `"control"` or `"worker"` |

### Capabilities

Abstract things the system can do: `tts`, `stt`, `control`, `dashboard`, and whatever else a given deployment adds. A capability has an id and a name. Services implement capabilities. Consumers ask for a capability and get back the best healthy provider — they don't need to know which backend serves it.

### Roster

The `roster` section declares what this node's model services offer, each fact once. The field-level contract is `$defs/nodeRoster` in `schemas/platform.schema.json`; the reasoning is in [model-roster.md](../design/model-roster.md).

| Field | Description |
|-------|-------------|
| `ttsModels` | Synthesis models on this node, each declared once however many providers serve it: `id`, `name`, and optionally `cloning`, `chunkProfile` and `chunking`. A model can clone if and only if it has a `cloning` block: `requiresText` (the model is sent the transcript), and, where the model constrains recordings, `minDurationS`, `maxDurationS` (both inclusive) and `sampleRate`. `chunkProfile` is the model's own chunker constraint (`words`, `chars`); `chunking` is how the realtime voice loop splits text for it |
| `sttModels` | Speech-to-text models: `id`, `name`, `kind` (`batch`, `streaming` or `both`), and optionally `params` and `variants` |
| `providers` | Keyed by registry service id: the runtimes that serve models. A provider has `serves`, a list of `{model, key, ...}`, and optionally `responseFormat`, `sessions`, `defaultModel` and `idleUnloadMs` |
| `voices` | The curated voices: `id`, `name`, optionally `recordings`, and `renderings`. A voice that is not declared does not exist, and a request for it is refused |

A model has no key of its own: its id is Banter's identity for it, the same whichever runtime serves it. Each entry in a provider's `serves` names a model by id and carries `key`, the runtime's own name for it (`kokoro-82m` is served under the key `kokoro-ane` by `fluid-tts`), plus what is true of this runtime rather than the weights: `streaming`, `realtime`, `concurrency` and `requestParams`, the fields every request to it carries. An absent flag means no.

A synthesis provider must set `resolvesVoices`. `true` means the runtime reads the registry itself (`fluid-tts`, started with `--registry`) and is sent the model and voice ids; `false` means the shard on its machine turns the selected voice into what the runtime needs, and the browser sends that to the runtime unchanged.

A voice's `renderings` say which models produce it, in declared order of preference. A rendering names a model, never a runtime, and has a `method`: `preset`, with the model's own `key` for the voice, or `clone`, with no key, made from one of the voice's `recordings`. A recording is `{audio, text, durationS, sampleRate}`: the path to the audio, the path to its transcript file, and two facts that are declared rather than probed. Whether a model can use a recording is computed at load from the model's `cloning` block and the recording.

The registry is validated at load against the services in the same file. These are load errors: a provider naming no registered service; a duplicate voice id, or a model id repeated across `ttsModels` and `sttModels`; a serving that names an undeclared model, or one of the wrong capability; a rendering that names an undeclared synthesis model; a preset without a `key` or a clone with one; a clone rendering on a model without `cloning`, or on a voice with no recording that model accepts; a synthesis provider without `resolvesVoices`. A preset's `key` is not checked against the model, since the roster holds no list of every preset, and recording files are not checked to exist. A registry with no `roster` gets an empty one rather than failing.

Every node builds its roster from its own registry. The shard serves its roster at `GET /api/roster`; the control plane polls it alongside the shard's services and assembles every node's roster with its own. A model or voice id declared on two nodes is excluded from both and reported as a collision, since a silent winner would leave one node's copy unreachable without saying so. Recordings stay on the node that declares them and are not served.

The shard also answers `POST /api/voices/resolve` with a voice, a model and a service id, for runtimes that cannot read the registry. The control plane calls it when serving `GET /api/voice` and puts the answer in `tts.selection.request`, the body the browser sends to the runtime unchanged; if it cannot be resolved, `requestError` says why.

A server that reads its provider's roster section at startup (as `fluid-stt` and `fluid-tts` do, with `--registry {registry} --provider <id>`) sees an edit only when it restarts; `POST /api/config/reload` re-reads the registry but names the affected provider in a warning rather than restarting it for you. See [docs/guide/voices-and-models.md](../../guide/voices-and-models.md) for how to edit the roster and apply the change.

Among the provider fields, `sessions: true` declares that the runtime's streaming socket understands session ids and take-over — the same way `responseFormat` (`mp3`, `aac` or `wav`; `mp3` when absent) declares the audio format it returns. It applies to both STT and TTS providers, and `GET /api/voice` carries it through to each `stt.options` entry and each TTS provider so the dashboard can tell which services support taking over a held session.

An STT provider may also set `defaultModel`, the model a request naming none loads into an empty server (it must name a served model that needs no parameter), and `idleUnloadMs`, how long the model may go without work before the server unloads it (30 minutes when absent or not positive). Both are read by the runtime, not the control plane; `fluid-stt` honours them.

### Services

Concrete processes. Each service belongs to one host and implements one capability.

| Field | Description |
|-------|-------------|
| `id` | Unique identifier |
| `name` | Human-readable name (shown in Banter); falls back to `id` if omitted |
| `capabilityId` | Which capability this implements |
| `hostId` | Which host it runs on |

#### `permissions`

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Whether the registry monitors and manages this service |
| `protected` | `false` | If true, API rejects stop and disable actions |

#### `network`

| Field | Description |
|-------|-------------|
| `port` | Port the service listens on. Required unless `runner.type` is `managed`. The only place the port is written: a `process` runner receives it as `{port}` in `main` and as `PORT` in its environment |
| `healthPath` | Path to probe (e.g. `/health`). Required unless `runner.type` is `managed` |
| `healthExpect` | `"ok"` (default) requires a 2xx response; `"reachable"` accepts any HTTP response, for services whose health path answers non-2xx by design (e.g. an endpoint that returns 406 to a plain GET) |
| `healthTimeout` | Per-request timeout for routine health checks (ms). Default: `5000` |
| `endpoint` | **Derived at load time** from `scheme` + (`listenAddress` or the host's hostname) + `port` — never stored in JSON. Derived for any service with a port, whatever its runner |
| `listenAddress` | Address used in the derived endpoint instead of the host's hostname (e.g. `"localhost"` for local-only services). Address only — it does not change the scheme |
| `tailscaleServe` | Whether to register with Tailscale Serve when started. Default: `false`. This is a lifecycle concern only — it does not by itself decide the endpoint's scheme |
| `scheme` | `"http"` or `"https"`, defaulting to `http`. The only thing that decides the endpoint's protocol — set it explicitly for a service behind a reverse proxy, a self-signed cert, or Tailscale Serve |

#### `runner`

Declares how the registry's lifecycle module manages this service. Commands are derived from the runner type and its parameters — no command strings are hand-written in the registry, with one exception (`managed`, below).

**`process`** — spawned and held directly via `Bun.spawn`:

```json
"runner": {
  "type": "process",
  "main": ".venv/bin/uvicorn server:app --host 127.0.0.1 --port {port}"
}
```

**`systemd`** — OS-managed on Linux:

```json
"runner": {
  "type": "systemd",
  "unit": "my-service",
  "unitFile": "ops/systemd/my-service.service"
}
```

Derives: `systemctl --user start/stop/restart/enable/disable {unit}.service`. Install copies `unitFile` (relative to `$BANTER_PROD`, the install location) to `~/.config/systemd/user/` and runs `daemon-reload`.

**`launchd`** — OS-managed on macOS:

```json
"runner": {
  "type": "launchd",
  "label": "com.banter.control-shard",
  "plist": "control/control-shard/ops/com.banter.control-shard.plist"
}
```

Derives: `launchctl bootstrap/bootout gui/$(id -u) ~/Library/LaunchAgents/{label}.plist`. Install copies `plist` (relative to `$BANTER_PROD`, the install location) to `~/Library/LaunchAgents/`.

**`external`** — observed only:

```json
"runner": {
  "type": "external"
}
```

Health-monitored but not managed. Start/stop API calls return 400.

**`managed`** — a self-managing daemon that owns its own start/stop/health commands:

```json
"runner": {
  "type": "managed",
  "startCmd": ["paseo", "daemon", "start"],
  "stopCmd": ["paseo", "daemon", "stop"],
  "healthCmd": "paseo daemon status"
}
```

`startCmd`/`stopCmd` run as argv with no shell; `healthCmd` runs via `sh -c` and its exit code alone is the health signal. Unlike the other runner types, `managed` has no HTTP health surface — `network.port`/`healthPath` are not required, and its health is `healthCmd`. A `network.port` still gives it an `endpoint`.

#### `ops.env` (for `process`-type runners)

| Field | Description |
|-------|-------------|
| `workingDirectory` | Absolute path to cd into before spawning |
| `variables` | Key-value env vars injected into the process |

#### `ops.install` (for services built from this repo)

```json
"install": { "artifacts": [ { "from": "services/fluid/.build/release/fluid-stt.app", "to": "fluid-stt.app" } ] }
```

What the install scripts copy into place: a file, or a whole directory such as a resource bundle a binary loads from beside itself. `from` is relative to the source tree, `to` relative to `ops.env.workingDirectory`, which is then required; both must be relative and free of `..`. Read only by `ops/install-artifacts.sh` — never by the running control plane or shard.

#### `lifecycle`

| Field | Default | Description |
|-------|---------|-------------|
| `loadStrategy` | `"startup"` | `"startup"` or `"demand"` |
| `autoStart` | `false` | Start automatically when the registry's owning process boots |
| `shutdown` | `false` | Stop gracefully when the owning process shuts down |
| `startupTime` | `30000` | Expected startup duration (ms). Grace period before treating a non-responsive service as failed. |
| `idleUnload` | `false` | Evict after idle timeout |
| `idleTimeout` | `300000` | Idle timeout (ms) |
| `restartOnCrash` | `false` | Auto-restart on unexpected exit (`process` runner only) |
| `maxRestarts` | `3` | Max restarts within window before giving up |
| `restartBackoff` | `5000` | Initial delay before restart attempt (ms) |

**`restartOnCrash`, `maxRestarts`, and `restartBackoff` are changeable at runtime via the API** — callers can adjust restart behavior when loading a service.

---

## Storage and access

Each node's registry is a JSON file local to that node, `registry.json` at the top of its deployment folder (`$BANTER_PROD` for the control plane, `$BANTER_SHARD_PROD` for a shard, both `~/services/banter` by default). The repo tracks examples, not live files: `control/control-plane/data/registry.example.json` and `control/control-shard/data/registry.example.json` are templates that `ops/install.sh` seeds the live file from and that every deploy three-way merges into it; see [`design/live-config.md`](../design/live-config.md). To create the live file by hand:

```bash
mkdir -p ~/services/banter
cp control/control-plane/data/registry.example.json ~/services/banter/registry.json
```

You edit the live `registry.json` with your own hosts, capabilities, and services. See [`../setup/configuration.md`](../configuration.md) and [`../setup/models.md`](../../guide/models.md) for example service entries and [`../setup/shard.md`](../../guide/shard.md) for the worker-host registry.

The registry is loaded into memory once at startup. All reads go to the in-memory copy. Mutations update the in-memory copy and then write to disk **atomically** (write to temp file, rename into place).

---

## Validation

On load:
- `version` must be `2`
- `type` must be `"control"` or `"shard"`
- All `capabilityId` references resolve to a known capability
- All `hostId` references resolve to a known host
- Required fields present on all objects
- Runner type is one of: `process`, `systemd`, `launchd`, `external`, `managed`
- `process` runner requires `main`, which may not write a port (`--port 8002`); it uses `{port}`
- `ops.env.variables` may not set `PORT`, which a process receives from `network.port`
- `systemd` runner requires `unit` and `unitFile`
- `launchd` runner requires `label` and `plist`
- `managed` runner requires `startCmd`, `stopCmd`, and `healthCmd`
- Services with `runner.type: "external"` are valid — monitored but unmanaged
- `network.healthPath` and `network.port` are required for every runner type except `managed`
- Optional `shards` entries require `hostId` and `port`, and `hostId` must resolve to a known host
- `defaults` (if present) may only set fields on an explicit allowlist per group (`permissions`, `network`, `lifecycle`); an unknown field or group is rejected, as is a shard-only default (e.g. `network.tailscaleServe`) on a `"control"`-type registry

Validation errors are fatal at startup.

---

## Installation

Installation is registry-driven. Deploy scripts read the registry, find services by runner type, and copy the appropriate unit/plist files to the right locations:

- `runner.type: "systemd"` — copy `unitFile` to `~/.config/systemd/user/`, `systemctl --user daemon-reload`
- `runner.type: "launchd"` — copy `plist` to `~/Library/LaunchAgents/`

Install/uninstall are deploy-time operations only — there are no runtime API endpoints for them.

**Enable vs start:** `enable` means start now and persist across reboots. `disable` means stop now and don't restart on reboot. `start`/`stop` affect only the running state.
