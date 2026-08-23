# Adding a worker machine (shard)

Optional. Skip this entirely for a single-machine install.

A shard is a **full second instance of the control plane** running on another machine — its own registry, health checker, event log, and API. It exists because a control plane cannot start processes on a host it is not running on. The primary polls each shard and merges their services into one view, so the dashboard shows every machine as one system.

Nothing caps how many you add: the registry takes a list of hosts, and the primary polls each one independently. This page describes adding one; repeat it per machine.

On top of that base, the shard adds idle eviction and its own Tailscale Serve management.

The point is to run services on whatever machine suits them — a GPU box, a Mac with a Neural Engine, a machine that is only sometimes on — while the control plane lives on something small and always-on. Speech models are the usual case here, but the registry has no notion of what a service does: anything with an HTTP endpoint and a health path works the same way.

---

## Platform support

The shard's code is platform-neutral. Its installer is not: `scripts/shard-deploy.sh` compiles a Swift supervisor and installs a launchd agent, so it runs on macOS only.

A Linux shard needs a systemd counterpart to that script — a unit where it installs a launchd agent. Nothing in the shard itself is in the way; `systemd` is already a supported runner type.

---

## On the worker machine

**1. Install the model servers** you intend to run there. See [`services/README.md`](../services/README.md).

**2. Create the shard's registry:**

```bash
cp control/control-shard/data/registry.example.json ~/services/shard/registry.json
```

That destination is the shard's default `BANTER_SHARD_REGISTRY_PATH`, which is a different directory from where the example lives in the repo — a copy across directories, not a rename in place.

Edit the host ids, hostnames, and service entries to match what actually runs there. The registry's `type` must be `"shard"`.

Older macOS installs used `~/Services` with a capital S. That still works — the shard falls back to it when no lowercase `~/services` exists — but lowercase is the default now, so both nodes use one spelling on any filesystem.

**3. Deploy:**

```bash
scripts/shard-deploy.sh
```

This builds the dashboard, copies files into place, compiles and code-signs the `shard-runner` Swift supervisor, and installs the launchd agent. It is short enough to read, and it is where the exact commands live — including the `swiftc` invocation, if you want to run the steps by hand.

The launchd agent is generated, not hand-edited. launchd will not expand `~` or `$HOME` in a plist, so the installed file has to carry absolute paths — but the tracked one does not. `control/control-shard/ops/com.banter.control-shard.plist.template` carries a `__HOME__` placeholder, and the deploy substitutes your home directory into it before installing the result.

---

## On the primary machine

Add the worker host and a `shards` entry to the primary's registry:

```json
"hosts": [
  { "id": "box", "name": "box", "hostname": "box.local", "role": "control" },
  { "id": "gpu", "name": "gpu", "hostname": "gpu.local", "role": "worker" }
],
"shards": [
  { "hostId": "gpu", "port": 4200 }
]
```

The shard's endpoint is derived as `scheme://hostname:port`, defaulting to `http`. Add `"scheme": "https"` if the worker is behind TLS — Tailscale Serve, a reverse proxy, anything.

Leave the worker's services out of the primary's registry. The shard owns them and reports them upward; duplicating them creates two sources of truth that will disagree.

Restart the primary. Its services page should now show the worker's services alongside its own.

---

## Environment variables

All optional; the shard runs without any of them.

| Variable | Default | Purpose |
|---|---|---|
| `BANTER_SHARD_ROOT` | `~/services` (falls back to `~/Services` if only that exists) | Data root for the two paths below |
| `BANTER_SHARD_REGISTRY_PATH` | `$BANTER_SHARD_ROOT/shard/registry.json` | Registry file |
| `BANTER_SHARD_EVENTS_PATH` | `$BANTER_SHARD_ROOT/banter/logs/events.jsonl` | Event log |
| `BANTER_SHARD_PORT` | `4200` | HTTP server port |
| `BANTER_SHARD_HOST` | `localhost` | Bind address |
| `BANTER_HEALTH_INTERVAL_MS` | `900000` | Health check interval |
| `BANTER_IDLE_INTERVAL_MS` | `60000` | Idle-eviction check interval |

The three numeric settings must be positive integers. An unusable value stops startup with a message naming the setting rather than being silently ignored — an unparseable port would otherwise reach the HTTP server as `NaN` and bind something nobody asked for.

---

## Networking

The primary reaches the shard by hostname, and the **browser** reaches the worker's model servers directly — so both must be routable from where you use the dashboard. A tailnet is the easy answer; a LAN works too.

The worker's model servers need the dashboard's origin in their CORS allowlists, or voice fails with an error the browser refuses to explain. See [configuration.md](./configuration.md#cors).

---

## Known limits

The primary polls the shard and the shard cannot push, so urgent events — memory pressure, load failures — surface at the next poll rather than immediately. Cold-start times for demand-loaded models have never been benchmarked, which makes the default idle timeouts estimates.

For the design detail, see [architecture/control-shard.md](./architecture/control-shard.md).
