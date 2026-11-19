# Component: Health Checker

*Periodic observation of service availability. Records what it finds; makes no decisions.*

---

## What it does

The health checker probes enabled services on a configurable interval and appends an event to the event log when a result differs from the service's last health-deciding event. It skips a demand-loaded service unless its run intent is to run — started or restarted more recently than it was stopped, unloaded or disabled (see [event-log.md](event-log.md#reading)). It is pure observation — it doesn't route traffic, trigger recovery, or make decisions. It just records what it sees.

---

## Probing

Each node checks only its own services; the control plane learns a shard's service health from the shard, and never probes a shard service itself. Disabled services are skipped entirely.

The process is probed first, because only it can say whether the service is up. For a service behind Tailscale Serve that means `http://localhost:<port><healthPath>`; for any other service, nothing sits between the checker and the process, so it is the derived endpoint (`scheme://host:port`, `http` unless the entry sets `scheme: "https"`) plus `healthPath`. Map the outcome:
- 2xx response → `service.up` (with `latencyMs`); for a service with `healthExpect: "reachable"`, any response
- Any other response → `service.down`
- Timeout exceeded → `service.timed_out`
- Connection refused / unreachable → `service.down`

For a service behind Serve whose process is up, the route is then probed at `https://<host's hostname>:<port><healthPath>`, whatever the entry's `scheme`, since Serve always terminates TLS. The route works when it relays the status the process gave. Anything else is `service.degraded`: refused, timed out, or a status of Tailscale's own, such as a 404 or a 502. A response at the Tailscale address never decides whether the service is up, since Serve answers on its own whether or not the process is behind it.

Every probe opens a new connection. Over a connection that is already open, Serve keeps answering after its route is removed, so a reused connection would report a stopped service as up.

"Healthy" therefore means the process is up and reachable by the rest of Banter.

---

## Concurrency

All services in a round are checked in parallel (`Promise.allSettled`). One slow or failing service does not block the others. Unexpected throws in individual checks don't abort the round.

---

## No overlap

The next round does not begin until the current round has finished and the interval has elapsed. If a round takes longer than the interval, the next starts immediately after — but never concurrently. This means no `setInterval`; the loop `await`s completion then sleeps for the remaining time.

---

## Consecutive failure threshold

A single failed probe does not immediately emit a `down` event. The health checker tracks a consecutive failure count per service **in memory**. It only emits `service.down`, `service.timed_out` or `service.degraded` after N consecutive failures (default: 2). Success always emits immediately and resets the counter.

The counter is lost on restart — intentional. The first round after restart re-establishes state quickly.

This prevents dashboard flapping from transient network hiccups.

---

## On-demand checks

The API can trigger a one-off health check for a single service (`POST /api/services/:id/check`). This bypasses the consecutive failure threshold — it's a deliberate user action, not automated observation. Returns the updated health state immediately.

---

## Configuration

| Setting | Default | Purpose |
|----------|---------|---------|
| `intervals.healthMs` in `registry.json` | `900000` | Check interval; `BANTER_HEALTH_INTERVAL_MS` overrides it, and a change takes effect on restart |
| (threshold) | `2` | Consecutive failures before emitting down event |
