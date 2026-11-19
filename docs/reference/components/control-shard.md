# ControlShard

*The control plane's pattern running on a remote host. Inherits the registry, health checker, event log and API core of the three-plane architecture. It serves no web app, and adds the concerns of a host whose services are demand-loaded: idle eviction and Tailscale Serve management.*

---

## What it is

The ControlShard is an instance of the control plane running on a remote host. The primary control plane cannot directly manage services on other machines; the shard is its reach into that host.

It is not a lightweight proxy or a thin agent. It is a full instance that:
- Maintains its own local service registry, describing only that host's services
- Runs health checks against its services
- Manages service lifecycle natively in TypeScript, spawning processes with `Bun.spawn`, polling health and retrying on failure
- Appends events to its own local event log
- Exposes the same REST API shape as the control plane
- Serves no web app: it is API-only, and every non-API path 404s
- Reports state upward to the primary control plane via pull-based polling

For the inherited behavior, see the component docs:
- Registry schema, lifecycle commands, distributed model: [`components/registry.md`](registry.md)
- Event log format and health state derivation: [`components/event-log.md`](event-log.md)
- Health checker behavior: [`components/health-checker.md`](health-checker.md)
- API shape: [`components/control-plane-api.md`](control-plane-api.md)

A shard is optional. A single-machine install does not need one, and the control plane runs standalone with an empty `shards` array. [`setup/shard.md`](../../guide/shard.md) covers installing one.

---

## Relationship to the control plane

The control plane is the authority. It holds the definitive map of all shards, a `shards` section in its registry with each shard's address and metadata. The shard is a full instance, but the control plane is the one that knows the topology.

### Communication model

**Pull-only.** The control plane periodically calls the shard's API to fetch its assembled view (service list with health state, events). The shard does not need to know about the control plane's existence for this to work; it just serves its API. Urgent events surface at the next poll rather than immediately.

A push channel, where the shard sends urgent events (memory pressure, load failures) without waiting to be polled, would need an authentication and trust handshake between the two. Neither exists.

### Dashboard routing

The dashboard talks only to the control plane. It never queries shards directly. The control plane assembles the global view, so shard services appear alongside local services in the same API responses.

When the dashboard requests a lifecycle action (start, stop, restart, etc.) for a service the control plane's own registry does not hold, the control plane finds it among the services its last poll of each shard returned and forwards the request to that shard's API. The shard handles its own concerns (Tailscale Serve, idle eviction) behind its API. The dashboard does not know or care whether a service is local or remote. What the control plane merges, forwards and caches is in [`components/control-plane-api.md`](control-plane-api.md).

### Authentication and trust

There is no authentication between a shard and a control plane. The shard's API is reachable by anything that can reach it on the network, so the network boundary is the only one (see Security, below).

---

## What's unique to the shard

### Memory

The shard host shares one pool of memory between the LLM runtime, the services the shard manages, and the OS, and the shard has no check on it: it starts any demand-loaded service it is asked to, whatever room is left. Idle eviction is the only thing that frees memory. A real check needs a measure of pressure on macOS, where `vm_stat`, `top`, `memory_pressure` and Activity Monitor disagree, plus a per-service memory figure in the registry and a check on every load path.

`getFreeMem()` parses `PhysMem: … unused` out of `top -l 1 -n 0` for `GET /status`. That figure stays small even when memory is available, because macOS fills spare RAM with cache. `memory.pressure` is a real event type, but nothing emits it.

### Idle eviction

Services that sit unused consume memory other services need. The shard tracks last activity per service and evicts on a configurable idle timeout.

- A background timer checks every 60s (`IDLE_INTERVAL_MS`, overridden by `BANTER_IDLE_INTERVAL_MS`)
- Only services with `lifecycle.idleUnload === true` that are currently loaded are considered
- If `now - last_ping > lifecycle.idleTimeout`: run the stop sequence, emit `service.unloaded`
- Restarting an evicted service takes an explicit `POST /api/services/:id/start`; there is no wake-on-demand interception

Thresholds are per service, set as `lifecycle.idleTimeout` in the host's registry; the registry default is 5 minutes, and demand-loaded services generally override it upward. Read the live values from the registry rather than from this document. The wake latency of a cold start has not been benchmarked, so the defaults are estimates.

**Heartbeat:** consumers ping `POST /ping/:service` on each interaction and the shard records `last_ping`, which both `GET /status` and the eviction loop read. No session tracking is needed; the heartbeat stream is the signal.

### Tailscale Serve management

The shard manages Tailscale Serve registrations for its services. This must happen in the right order or ports stay occupied after a process dies.

**On start**, for a `process` runner, a fast path runs first: probe `http://localhost:PORT/healthPath` for up to 3s, and if the service already answers, adopt it rather than restarting, emitting `service.up` with `alreadyRunning: true`, and repairing a missing Serve registration first if one is needed (`serveRepaired: true`). Healthy-locally alone is not proof the service came up through the shard, so the Serve entry is checked either way.

Otherwise:

1. Stop any existing process: kill the held child, run the stop command (silent, no event emitted)
2. Remove any stale Tailscale Serve entry for this port
3. Spawn the process via `Bun.spawn` (shard-managed) or `systemctl`/`launchctl` (supervisor-managed)
4. Poll the health endpoint over HTTP once a second until healthy or `startupTime` elapses
5. If healthy: register with Tailscale Serve, emit `service.up`
6. If it times out: stop the process and return an error, with no retry. The caller emits `service.down` with `reason: "start_failed"` (there is no `service.start_failed` event type)

**On stop:**
1. Remove the Tailscale Serve entry *first*
2. Stop the process

Removing the Serve entry before stopping is non-negotiable: Tailscale Serve holds the port at the system level. If the process is killed while the entry is active, the port stays occupied and the process cannot rebind on restart.

How concurrent starts and stops are serialized is in [`design/lifecycle-executor.md`](../design/lifecycle-executor.md).

### Upward event reporting

**Passive.** The shard records events locally in its own event log. The control plane discovers them by polling the shard's `GET /api/events` endpoint.

---

## Code sharing model

The shard inherits the full control plane pattern: registry, health checker, event log, API. Rather than duplicating code, the generic server-side modules are shared.

**Directory structure:**

```
<repo root>/
├── shared/              ← types (used by dashboard + all server code)
├── control/
│   ├── shared/          ← server-side modules (registry, events, health, services)
│   ├── control-plane/   ← primary-host entry point + service install/uninstall
│   └── control-shard/   ← remote-host entry point + idle eviction, tailscale serve
├── dashboard/           ← React frontend, served by the control plane only
```

`control/shared/` contains the generic modules that both control-plane and control-shard import: registry loading and validation, event log append, read and health derivation, the health checker loop, the lifecycle action runner, and the API factory (`createApp` with dependency injection).

Each host's entry point (`control-plane/src/index.ts`, `control-shard/src/index.ts`) wires up host-specific concerns, the init system on the primary host and Tailscale Serve and idle eviction on a shard host, and passes them into the shared modules via the dependency injection pattern in `createApp`.

The shard extends the shared API with shard-specific endpoints (`/status`, `/ping/:service`) and its own start/stop handlers. These are defined in the shard's own code, not in the shared API module.

---

## Runtime

TypeScript, Bun. Consistent with the control plane.

**Deployment:** the shard is supervised by the compiled `shard-runner` Swift binary, managed by launchd. The installer, `ops/shard-deploy.sh`, therefore runs on macOS only; [`setup/shard.md`](../../guide/shard.md) covers what a Linux shard needs. Nothing in the shard's own TypeScript depends on launchd, and a shard on another OS needs an equivalent supervisor, such as a systemd unit, to get the same crash-restart and Serve teardown behavior.

The `shard-runner` binary:
- Tears down stale Tailscale Serve on the shard's port, read from the registry
- Spawns the shard Bun process (API only, no web app)
- Sets up Tailscale Serve for that same port
- Restarts the shard process if it exits
- On SIGTERM: kills children, tears down Tailscale Serve, exits

**Debugging tool:** `ops/service-control.sh` provides manual lifecycle control for registry-managed services: `start`, `stop`, `restart`, `status`, `enable`, `disable`. The shard itself does not call this script; it manages services natively. The script is for use in coding sessions and debugging.

**Startup sequence:**
1. shard-runner handles Tailscale Serve and process supervision
2. The shard loads its registry from `registry.json` at the top of its deployment folder (`~/services/banter` by default), or from `BANTER_SHARD_REGISTRY_PATH` if set
3. Starts the health check loop and the idle eviction loop
4. For each auto-start service: runs the start sequence (stop existing, spawn, health poll)

**Shutdown:**
1. For each `shutdown: true` service: run the stop sequence. A startup service can set `shutdown: false`, so a shard restart leaves it running and the next shard adopts it. Demand-loaded services keep `shutdown: true`, because idle eviction tracks load time in memory and could not evict a service that outlived the shard
2. shard-runner tears down Tailscale Serve
3. Exit

---

## Additional HTTP endpoints (shard-specific)

Beyond the standard API shape, the shard adds:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/status` | Free memory, and each service's health and last ping (`null` if never pinged) |
| `POST` | `/ping/:service` | Heartbeat: updates `last_ping` for the named service |
| `POST` | `/api/services/:id/start` | Load a service |
| `POST` | `/api/services/:id/stop` | Explicitly evict a service |
| `GET` | `/api/roster` | The roster section of the registry as currently loaded, so a reload shows at once |
| `POST` | `/api/config/reload` | Re-read the registry; see [`components/registry.md`](registry.md) |

These routes go to the shard's own app and every other `/api/` path to the shared one, which also serves restart.

Start and stop here handle only demand-loaded services; any other service is 400. Start answers 202 as soon as the load begins, without waiting for it, and a second start while one is loading joins it. The caller follows the load through `GET /api/services/:id`, whose `pending` and `health` say whether it is still running and how it ended. A disabled service is 400. Stop waits for the unload and is 500 with the error if it fails.

A reload that cannot read or validate the file, or a shard started with no registry path, is 500 with the error and leaves the running registry as it was.

---

## Security

**Tailscale Serve only, never Funnel.** Shard services are internal to the tailnet when Serve is used. There is no shard-specific exception and no separate authentication layer (see Authentication and trust, above); the network boundary is the security boundary. [`setup/remote-access.md`](../../guide/remote-access.md) covers reaching Banter from other devices and why https is safer than plain http.
