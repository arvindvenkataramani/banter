# Component: Service Registry

*What the registry is, what it owns, and how it behaves. Every host that runs managed services runs an instance of it.*

---

## What it is

The registry is the source of truth for a host's service topology: which capabilities the host offers, and which services implement them. It answers *what should be running here, and how is it managed?*

It does not contain runtime state. No health, no timestamps, no "last seen." Those live in the event log.

---

## Distributed model

Each host owns its own registry as a static file local to that machine. A control host's registry describes only that host's services. A worker host's registry lives on the worker host, owned by the ControlShard running there.

A shard is optional — a single-machine install has no shard and no cross-host concept at all (see [`docs/shard-setup.md`](../shard-setup.md)). When one or more shards are in play, the control plane assembles the full cross-host picture at runtime from shard reports. No config file spans machines. This is intentional:

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

### Services

Concrete processes. Each service belongs to one host and implements one capability.

| Field | Description |
|-------|-------------|
| `id` | Unique identifier |
| `name` | Human-readable name (shown in dashboard); falls back to `id` if omitted |
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
| `port` | Port the service listens on. Required unless `runner.type` is `managed` |
| `healthPath` | Path to probe (e.g. `/health`). Required unless `runner.type` is `managed` |
| `healthExpect` | `"ok"` (default) requires a 2xx response; `"reachable"` accepts any HTTP response, for services whose health path answers non-2xx by design (e.g. an endpoint that returns 406 to a plain GET) |
| `healthTimeout` | Per-request timeout for routine health checks (ms). Default: `5000` |
| `endpoint` | **Derived at load time** from `scheme` + (`listenAddress` or the host's hostname) + `port` — never stored in JSON. Not derived at all for `managed` runners, which have no HTTP health surface |
| `listenAddress` | Address used in the derived endpoint instead of the host's hostname (e.g. `"localhost"` for local-only services). Address only — it does not change the scheme |
| `tailscaleServe` | Whether to register with Tailscale Serve when started. Default: `false`. This is a lifecycle concern only — it does not by itself decide the endpoint's scheme |
| `scheme` | `"http"` or `"https"`, defaulting to `http`. The only thing that decides the endpoint's protocol — set it explicitly for a service behind a reverse proxy, a self-signed cert, or Tailscale Serve |

#### `runner`

Declares how the registry's lifecycle module manages this service. Commands are derived from the runner type and its parameters — no command strings are hand-written in the registry, with one exception (`managed`, below).

**`process`** — spawned and held directly via `Bun.spawn`:

```json
"runner": {
  "type": "process",
  "main": ".venv/bin/uvicorn server:app --host 127.0.0.1 --port 8002"
}
```

**`systemd`** — OS-managed on Linux:

```json
"runner": {
  "type": "systemd",
  "unit": "embedding",
  "unitFile": "ops/systemd/embedding.service"
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

`startCmd`/`stopCmd` run as argv with no shell; `healthCmd` runs via `sh -c` and its exit code alone is the health signal. Unlike the other runner types, `managed` has no HTTP health surface — `network.port`/`healthPath` are not required, and no `endpoint` is derived even if `network.port` is set for reference.

#### `ops.env` (for `process`-type runners)

| Field | Description |
|-------|-------------|
| `workingDirectory` | Absolute path to cd into before spawning |
| `variables` | Key-value env vars injected into the process |

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

Each host's registry is a static JSON file local to that host. This repo ships an example, not a live one — `control/control-plane/data/registry.example.json` and `control/control-shard/data/registry.example.json` are templates to copy from, not a canonical deployed config:

```bash
cp control/control-plane/data/registry.example.json control/control-plane/data/registry.json
```

The actual `registry.json` is gitignored; you edit it with your own hosts, capabilities, and services after installing. See [`docs/configuration.md`](../configuration.md) and [`docs/models.md`](../models.md) for example service entries (Kokoro, Parakeet, etc.) and [`docs/shard-setup.md`](../shard-setup.md) for the worker-host registry.

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
- `process` runner requires `main`
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
