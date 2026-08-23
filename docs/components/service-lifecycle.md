# Component: Service Lifecycle

*How the platform starts, stops, monitors, and recovers services. This is the unified model — both the control plane and the shard use the same shared module.*

---

## Core principle: the launcher owns Tailscale Serve

The thing that starts a service is responsible for its Tailscale Serve lifecycle. The service itself never manages its own serve binding.

Three launchers exist:

| Launcher | What it starts | Tailscale Serve for |
|----------|---------------|-------------------|
| `control-runner.sh` | Control plane (bun) | Port 4200 on Pi |
| `shard-runner` (Swift) | Control shard (bun) | Port 4200 on Mac |
| **Shared lifecycle module** | All application services | Each service's port |

The runners (shell/Swift) are entry points called by the OS service manager (systemd/launchd). They own serve for the platform processes they launch. The shared lifecycle module runs inside those platform processes and owns serve for application services.

---

## Shared lifecycle module

A single TypeScript module in `control/shared/src/` used by both the control plane and the shard. It handles:

- Starting and stopping services (any runner type)
- Health polling during startup
- Tailscale Serve setup/teardown (atomic with process lifecycle)
- Crash detection via held child references
- Restart with backoffex
- Idle eviction
- Lifecycle locking (one operation at a time per service)

### Start sequence (atomic)

For a service with `tailscaleServe: true`:

1. **Acquire lifecycle lock** — reject concurrent operations on the same service
2. **Stop any existing process** — idempotent cleanup
3. **Teardown stale Tailscale Serve** — remove any leftover serve binding for this port
4. **Start the process** — method depends on runner type (see below)
5. **Poll health endpoint** — `http://localhost:PORT/HEALTH_PATH`, polled every 1s until healthy or `startupTime` elapsed
6. **On health timeout** — stop the process, release lock, return error
7. **Setup Tailscale Serve** — `tailscale serve --bg --https=PORT localhost:PORT`
8. **On serve failure** — emit `tailscale.serve_failed` event, stop the process, release lock, return error
9. **Emit `service.up` event** — health confirmed, serve registered
10. **Record `loadTime`** — for idle eviction tracking
11. **Release lifecycle lock**

For services without `tailscaleServe`, steps 3, 7, and 8 are skipped.

### Stop sequence

1. **Acquire lifecycle lock**
2. **Teardown Tailscale Serve** — best effort; doesn't block stop on failure
3. **Stop the process** — method depends on runner type
4. **Emit `service.stopped` event**
5. **Clear `loadTime`**
6. **Release lifecycle lock**

### Runner types

The lifecycle module derives commands from the runner configuration in the registry:

**`process`** — platform-managed. The module spawns the process directly via `Bun.spawn`, holds the child reference for crash detection. Stop is by terminating the child process. Environment variables and working directory come from `ops.env`.

**`systemd`** — OS-managed on Linux. Start/stop/restart/enable/disable derived from the unit name: `systemctl --user {action} {unit}`. Install/uninstall copies the unit file and reloads the daemon.

**`launchd`** — OS-managed on macOS. Start derived from `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/{label}.plist`. Stop from `launchctl bootout`. Install copies the plist.

**`external`** — observed only. No start/stop commands. Health-monitored but not managed. Start/stop API calls return 400.

---

## Crash recovery

For `process`-type services, the lifecycle module holds the `Bun.spawn` child reference and detects unexpected exit. Recovery behavior is configured per-service in the registry under `lifecycle`:

| Field | Default | Description |
|-------|---------|-------------|
| `restartOnCrash` | `false` | Whether to auto-restart on unexpected exit |
| `maxRestarts` | `3` | Max restarts within the restart window before giving up |
| `restartBackoff` | `5000` | Delay in ms before restart attempt (initial value) |

### Restart sequence

On unexpected process exit, if `restartOnCrash` is true:

1. **Teardown Tailscale Serve** — the process is gone, remove the route
2. **Emit `service.crashed` event** — with exit code
3. **Wait `restartBackoff`**
4. **Check restart budget** — if `maxRestarts` exhausted, emit `service.down` event, mark as down, stop
5. **Run the full start sequence** — teardown serve, start process, health poll, setup serve
6. **On success** — reset restart counter, emit `service.up`
7. **On failure** — increment counter, schedule next attempt with increased backoff

When `restartOnCrash` is false, a crash emits `service.crashed` and the service stays down until manually restarted.

The restart counter and backoff state are in-memory — lost on platform restart. This is acceptable: the platform restarting is itself a recovery event; services with `autoStart: true` will be started fresh.

### Interaction with idle eviction

A service that crashes and restarts keeps its `loadTime`. Idle eviction is based on the last ping, not the last start. If nobody is pinging a crashed-and-restarted service, it will still be idle-evicted after its timeout.

---

## Startup time

`lifecycle.startupTime` declares how long a service is expected to take to start, in milliseconds. This is the grace period during which:

- Health polling continues (to detect when the service is actually ready)
- But no failure events are emitted
- The restart/backoff clock has not started

Only after `startupTime` elapses without a healthy response does the system treat it as a failed start.

This separates "how long this service takes to load a model into VRAM" from `network.healthTimeout` which is the per-request timeout for routine health checks.

---

## Health checking

Periodic observation of service availability. The health checker is pure observation — it records what it sees and emits events. Recovery decisions are made by the crash recovery system (for process-type services) or left to operators (for systemd/launchd/external services).

### Probing

For each enabled service, fetch `endpoint + healthPath` with `healthTimeout`. Map the outcome:

- 2xx response -> `service.up` (with `latencyMs`)
- Non-2xx response -> `service.down`
- Timeout exceeded -> `service.timed_out`
- Connection refused / unreachable -> `service.down`

Disabled services are skipped.

### Endpoint resolution

Primary: Tailscale HTTPS endpoint (`https://HOSTNAME:PORT/HEALTHPATH`). If primary fails and the service is local to the checking node, fallback to `http://localhost:PORT/HEALTHPATH`. If fallback succeeds, emit `service.degraded` — the process is alive but Tailscale routing is broken.

### Consecutive failure threshold

A single failed probe does not emit a `down` event. The health checker tracks consecutive failures per service in memory. It only emits `service.down` or `service.timed_out` after N consecutive failures (default: 2). Success emits immediately and resets the counter.

Counter is lost on restart — intentional. First round after restart re-establishes state.

### Concurrency and scheduling

All services in a round are checked in parallel (`Promise.allSettled`). The next round does not begin until the current round finishes and the interval elapses. No overlapping rounds.

### On-demand checks

`POST /api/services/:id/check` triggers a single health check, bypassing the failure threshold. Returns the result immediately.

### Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `BANTER_HEALTH_INTERVAL_MS` | `900000` | Check interval |
| (threshold) | `2` | Consecutive failures before emitting down event |

---

## Idle eviction

For services with `lifecycle.idleUnload: true`, the platform monitors activity and stops services that have been idle too long.

### Activity tracking

Services (or their consumers) ping `POST /ping/:serviceId` to record activity. The lifecycle module tracks the last ping timestamp per service in memory.

### Eviction loop

Runs every `BANTER_IDLE_INTERVAL_MS` (default: 60s). For each loaded service with `idleUnload: true`:

1. Calculate idle time: `now - (lastPing OR loadTime)`
2. If idle time > `lifecycle.idleTimeout`: run the stop sequence, emit `service.unloaded` event

### Override at load time

Callers can pass flags when starting a service to override default lifecycle behavior for that session — e.g., suppress idle eviction while actively using the service. The ping mechanism is the primary way to signal "still in use."

---

## Lifecycle locking

An in-memory `Set<string>` of service IDs with in-progress lifecycle operations. Prevents concurrent start/stop/restart on the same service. API returns 409 if a lock is held.

The lock lives in shared code, used by both control plane and shard.

---

## Runners (control-runner.sh and shard-runner)

These are not part of the shared lifecycle module. They are OS-level entry points that supervise the platform processes themselves.

### control-runner.sh (Pi, systemd)

1. Read control port from registry
2. Teardown stale Tailscale Serve for that port
3. Setup Tailscale Serve
4. `exec` into bun (becomes PID 1 of the systemd unit)

systemd handles restart-on-crash (`Restart=always`). `ExecStopPost` tears down serve on stop.

### shard-runner (Mac, Swift, launchd)

1. Read shard port from registry
2. Teardown stale Tailscale Serve
3. Spawn bun (async, with termination handler for restart)
4. Setup Tailscale Serve
5. On SIGTERM/SIGINT: kill child, teardown serve, exit

launchd keeps shard-runner alive (`KeepAlive: true`). shard-runner keeps bun alive (termination handler with 2s delay).

---

## service-control.sh (debugging tool)

A standalone shell script for manual service management, not called by the platform in production. Reads registry, can start/stop/status a service by ID. When used manually, the operator is the launcher and is responsible for Tailscale Serve.

Usage: `service-control.sh <start|stop|status> <service-id>`
