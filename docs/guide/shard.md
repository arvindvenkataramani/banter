# Adding a worker machine (shard)

Optional. Skip this entirely for a single-machine install.

A shard is a **full second instance of the control plane** running on another machine — its own registry, health checker, event log, and API. It exists because a control plane cannot start processes on a host it is not running on. The primary polls each shard and merges their services into one view, so Banter shows every machine as one system.

If one machine is doing everything adequately, you do not need a shard.

Nothing caps how many you add: the registry takes a list of hosts, and the primary polls each one independently. This page describes adding one; repeat it per machine.

On top of that base, the shard supports idle eviction, per service through the registry's `lifecycle` settings, and its own Tailscale Serve management.

The point is to run services on whatever machine suits them — a GPU box, a Mac with a Neural Engine, a machine that is only sometimes on — while the control plane lives on something small and always-on. Speech models are the usual case here, but the registry has no notion of what a service does: anything with an HTTP endpoint and a health path works the same way.

---

## Platform support

The shard's code is platform-neutral. Its installer is not: `ops/shard-deploy.sh` compiles a Swift supervisor and installs a launchd agent, so it runs on macOS only.

A Linux shard needs a systemd counterpart to that script — a unit where it installs a launchd agent. Nothing in the shard itself is in the way; `systemd` is already a supported runner type.

---

## On the worker machine

**1. Install the services** you intend to run there, such as speech servers. See [`services/README.md`](../../services/README.md).

**2. Create the shard's registry:**

```bash
mkdir -p ~/services/banter
jq --arg home "$HOME" \
  '(.services[] | select((.ops.env.workingDirectory? // "") | startswith("~/")) | .ops.env.workingDirectory) |= ($home + .[1:])' \
  control/control-shard/data/registry.example.json > ~/services/banter/registry.json
```

That destination is the shard's live registry, at the top of its deployment folder (`$BANTER_SHARD_PROD`, `~/services/banter` by default; one node per machine, so the shard shares the plane's default). It is a copy across directories, not a rename in place. The `jq` filter is the same one `ops/install.sh` uses to expand a leading `~/` in each service's `ops.env.workingDirectory` to your home directory — a plain `cp` would leave the literal `~/` in place, which nothing downstream expands.

Edit the host ids, hostnames, and service entries to match what runs there; the example's service entries and origins are placeholders to replace. The registry's `type` must be `"shard"`. Without a live registry, the deploy seeds one from the example.

**3. Deploy:**

```bash
ops/shard-deploy.sh
```

This merges the example registry into the live one (see [live-config](../reference/design/live-config.md#deploy)), copies files into place, compiles and code-signs the `shard-runner` Swift supervisor, and installs the launchd agent. It is short enough to read, and it is where the exact commands live — including the `swiftc` invocation, if you want to run the steps by hand.

The launchd agent is generated, not hand-edited. launchd will not expand `~` or `$HOME` in a plist, so the installed file has to carry absolute paths — but the tracked one does not. `ops/launchd/com.banter.control-shard.plist.template` carries a `__HOME__` placeholder, and the deploy substitutes your home directory into it before installing the result.

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
| `BANTER_SHARD_PROD` | `~/services/banter` | Deployment folder |
| `BANTER_SHARD_LIVE_DIR` | `$BANTER_SHARD_PROD` | Live directory: `registry.json`, `shipped/`, `state/` |
| `BANTER_SHARD_REGISTRY_PATH` | `$BANTER_SHARD_LIVE_DIR/registry.json` | Registry file |
| `BANTER_SHARD_EVENTS_PATH` | `$BANTER_SHARD_PROD/logs/events.jsonl` | Event log |
| `BANTER_SHARD_PORT` | `4200` | HTTP server port |
| `BANTER_SHARD_HOST` | `localhost` | Bind address. Set it (for example to `0.0.0.0`) only when the control plane reaches this shard over a LAN without Tailscale; see [Hardening](../../README.md#hardening) |
| `BANTER_HEALTH_INTERVAL_MS` | `intervals.healthMs` in `registry.json`, else `900000` | Health check interval |
| `BANTER_IDLE_INTERVAL_MS` | `60000` | Idle-eviction check interval |

The three numeric settings must be positive integers. An unusable value stops startup with a message naming the setting rather than being silently ignored — an unparseable port would otherwise reach the HTTP server as `NaN` and bind something nobody asked for.

---

## Networking

The primary reaches the shard by hostname, and the **browser** reaches the worker's model servers directly — so both must be routable from where you use Banter. A LAN works over plain http; Tailscale is one way to get https, which voice on a phone needs (see [remote-access.md](remote-access.md)).

The worker's model servers need Banter's origin in their CORS allowlists, or voice fails with an error the browser refuses to explain. The shard's example registry carries placeholder https tailnet origins in those lists; replace them with the origins you open Banter from, and add any other origin, such as `http://<lan-ip>:4200` for a LAN address. See [./configuration.md](../reference/configuration.md#cors).

---

## Known limits

The primary polls the shard and the shard cannot push, so urgent events — memory pressure, load failures — surface at the next poll rather than immediately. Cold-start times for demand-loaded models vary by model and machine, so idle timeouts are estimates to tune.

For the design detail, see [control-shard.md](../reference/components/control-shard.md).
