# ControlShard

*The platform pattern running on a worker host. Inherits the full three-plane architecture — registry, health checker, event log, API, dashboard assets — and adds the concerns specific to a demand-loaded worker: idle eviction and Tailscale Serve management.*

---

## What it is

A ControlShard is an instance of the platform running on a worker machine. The primary control plane cannot directly manage services on a machine it isn't running on — the shard is its reach into that host.

It is not a lightweight proxy or a thin agent. It is a full platform instance that:
- Maintains its own local service registry, describing only the services on that host
- Runs health checks against its own services
- Manages service lifecycle natively in TypeScript — spawning processes, polling health, retrying on failure
- Appends events to its own local event log
- Exposes the same REST API shape as the control plane
- Serves the dashboard's static assets directly — no separate server process
- Reports state upward to the primary control plane via pull-based polling

For the inherited behavior, see the component docs:
- Registry schema, lifecycle commands, distributed model → `components/registry.md`
- Event log format and health state derivation → `components/event-log.md`
- Health checker behavior → `components/health-checker.md`
- API shape → `components/control-plane-api.md`

---

## Relationship to the control plane

The control plane is the authority. It holds the definitive map of all shards — a `shards` section in its registry, with each shard's address and metadata. A shard is a full platform instance, but the control plane is the one that knows the topology.

### Communication model

**Pull-only.** The control plane periodically calls a shard's API to fetch its assembled view (service list with health state, events). The shard doesn't need to know about the control plane's existence for this to work — it just serves its API.

**Future: push channel.** A shard could push urgent events to the control plane without waiting to be polled, instead of the current pull-only model. Not built. Would need an authentication/trust handshake that also doesn't exist yet (see below).

### Dashboard routing

The dashboard talks only to the control plane. It never queries shards directly. The control plane assembles the global view — shard services appear alongside local services in the same API responses.

When the dashboard requests a lifecycle action (start, stop, restart, etc.) for a service, the control plane checks the service's `hostId`. If the host is a shard, the control plane forwards the request to the shard's API. The shard handles its own concerns (Tailscale Serve, demand-loading) behind its API. The dashboard doesn't know or care whether a service is local or remote.

### Authentication and trust (not built)

There is no authentication between a shard and a control plane today — the shard's API is reachable by anything that can reach it on the network, with the tailnet as the only boundary (see Security, below).

A mutual-approval handshake has been discussed as a prerequisite for the push channel above — the control plane identifying itself to the shard, the shard withholding trust until approved from its own dashboard, then using an issued token to authenticate outbound events. None of this is designed in detail or implemented; treat it as a direction, not a spec.

---

## What's unique to the shard

### Idle eviction

Services that sit unused consume memory other services need. The shard tracks last activity per service and evicts on a configurable idle timeout.

- Background timer checks periodically (default every 60s)
- If `now - last_ping > idle_timeout`: run the stop sequence, emit `service.unloaded`
- On next request: run the start sequence (wake on demand)

**Heartbeat:** consumers of a demand-loaded service call `POST /ping/:service` on each interaction. The shard records `last_ping` per service. No session tracking needed — the heartbeat stream is the signal.

### Tailscale Serve management

A shard manages Tailscale Serve registrations for its own services. This must happen in the right order or ports stay occupied after a process dies.

**On start:**
1. Remove any existing Tailscale Serve entry for this port
2. Stop any existing process (silent — no event emitted)
3. Spawn the process
4. Poll the health endpoint
5. If healthy: register with Tailscale Serve, emit `service.up`
6. If crashed or timed out: retry once, then emit failure

**On stop:**
1. Remove the Tailscale Serve entry *first*
2. Stop the process

Removing the Serve entry before stopping is non-negotiable — Tailscale Serve holds the port at the system level. If the process is killed while the entry is active, the port stays occupied and the process can't rebind on restart.

### Upward event reporting

**Passive.** The shard records events locally in its own event log. The control plane discovers them by polling the shard's `GET /api/events` endpoint. There is no push channel (see above).

Event types a shard can emit include the standard lifecycle events (`service.up`, `service.down`, `service.unloaded`, `service.crashed`, and related states) plus `memory.pressure`, reserved for when a load is refused for lack of free memory. The check that would trigger `memory.pressure` is currently a stub that always allows the load — see Known limits.

---

## Code sharing model

The shard inherits the full platform pattern — registry, health checker, event log, API. Rather than duplicating code, the generic server-side modules are shared.

**Directory structure:**

```
<repo root>/
├── shared/              ← types (used by dashboard + all server code)
├── control/
│   ├── shared/          ← server-side platform modules (registry, events, health, services, tailscale)
│   ├── control-plane/   ← the control host entry point + systemd install/uninstall
│   └── control-shard/   ← the worker host entry point + idle eviction, tailscale serve
├── dashboard/            ← React frontend
```

`control/shared/` contains the generic modules that both control-plane and control-shard import: registry loading/validation, event log append/read/health derivation, health checker loop, lifecycle action runner, Tailscale Serve helpers, and the API factory (`createApp` with dependency injection).

Each host's entry point (`control-plane/index.ts`, `control-shard/index.ts`) wires up host-specific concerns — systemd for the control host, Tailscale Serve/idle eviction for the worker host — and passes them into the shared modules via the existing dependency injection pattern in `createApp`.

The shard extends the shared API with shard-specific endpoints (`/status`, `/ping/:service`, and demand-load-aware overrides of the start/stop lifecycle routes). These are defined in the shard's own code, not in the shared API module.

---

## Runtime

TypeScript, Bun. Consistent with the control plane on the control host.

On macOS, a shard can be supervised by a compiled Swift binary (`shard-runner`) managed by launchd rather than run directly. The binary:
- Tears down any stale Tailscale Serve entry for the shard's port
- Spawns the shard's Bun process (serves both API and dashboard assets)
- Sets up Tailscale Serve for that port
- Restarts the shard process if it exits
- On SIGTERM/SIGINT: stops the child process, tears down Tailscale Serve, exits

This supervision layer is macOS-specific; the shard's own service code is platform-neutral TypeScript and does not require it. A shard on another OS needs an equivalent process supervisor (see Known limits).

**Debugging tool:** `control/control-shard/ops/service-control.sh` provides manual lifecycle control for platform-managed services — `run` (foreground exec), `start` (background with stop-first), `stop`, `status`. The shard itself does not call this script; it manages services natively. The script is for use in coding sessions and debugging.

**Startup sequence:**
1. If supervised, the supervisor handles Tailscale Serve and process lifecycle
2. The shard loads its registry
3. Starts the health check loop and idle eviction loop
4. For each auto-start service: run the start sequence (stop existing → spawn → health poll → retry once on failure)

**Shutdown:**
1. For each `shutdown: true` service: run the stop sequence
2. If supervised, the supervisor tears down Tailscale Serve
3. Exit

---

## Additional HTTP endpoints (shard-specific)

Beyond the standard API shape, a shard adds:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/status` | Free memory reading, all service states, last-ping times |
| `POST` | `/ping/:service` | Heartbeat — updates `last_ping` for the named service |
| `POST` | `/api/services/:id/start` | Start a demand-loaded service (memory check, start with retry) |
| `POST` | `/api/services/:id/stop` | Explicitly evict a demand-loaded service |

The start/stop overrides above apply only to services configured with a demand load strategy; other services fall through to the shared lifecycle routes.

---

## Security

**Tailscale Serve only — never Funnel.** Services on a worker host are internal to the tailnet. This is the same rule that applies to the platform as a whole — see the [Network model](./README.md#network-model) section of the architecture overview. There is no shard-specific exception and no separate authentication layer today (see Authentication and trust, above); the tailnet boundary is the security boundary.

---

## Status

Built and in use. Idle eviction and Tailscale Serve management work as described. A macOS supervisor (`shard-runner`) exists and manages process lifecycle and Tailscale Serve when used; a shard can also be run without it.

A shard is optional — a single-machine install does not need one, and the control plane runs standalone with an empty `shards` array.

---

## Known limits

**Pull-only.** The control plane polls the shard; the shard cannot push. Urgent
events surface at the next poll rather than immediately. A push channel would
need an authentication handshake that does not exist yet.

**No real memory budget check.** The shard can read current free memory and has
a hook (`checkMemoryBudget`) meant to refuse loads under memory pressure, but
that check is currently a stub that always allows the load — it does not yet
implement real memory pressure detection. `memory.pressure` is a real event
type but is not emitted in practice until that check does something.

**macOS supervisor is optional and platform-specific.** `shard-runner` is a
compiled Swift binary managed by launchd. It is one way to run a shard on
macOS, not a requirement of the shard architecture itself. A shard on another
OS needs an equivalent supervisor (e.g. a systemd unit) to get the same
crash-restart and Tailscale Serve teardown behavior; nothing in the shard's own
code depends on launchd.

**Wake latency is unmeasured.** Cold-start times for demand-loaded services
have not been benchmarked, so default idle timeouts are estimates rather than
tuned values.

---

*Created: 2026-03-28.*
