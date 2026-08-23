# Component: Health Checker

*Periodic observation of service availability. Records what it finds; makes no decisions.*

---

## What it does

The health checker probes every enabled service on a configurable interval and appends events to the event log. It is pure observation — it doesn't route traffic, trigger recovery, or make decisions. It just records what it sees.

---

## Probing

For each enabled service: fetch `endpoint + healthPath` with a timeout. Map the outcome:
- 2xx response → `service.up` (with `latencyMs`)
- Non-2xx response → `service.down`
- Timeout exceeded → `service.timed_out`
- Connection refused / unreachable → `service.down`

Disabled services are skipped entirely.

The Tailscale HTTPS endpoint is probed first. If that fails and the service
is local to the checking node, localhost is tried as a fallback: reachable
there but not over Tailscale means the process is up and Serve is broken, so
the outcome is `service.degraded` rather than `service.down`.

"Healthy" therefore means reachable by the rest of the platform, not merely
that the process is alive.

---

## Concurrency

All services in a round are checked in parallel (`Promise.allSettled`). One slow or failing service does not block the others. Unexpected throws in individual checks don't abort the round.

---

## No overlap

The next round does not begin until the current round has finished and the interval has elapsed. If a round takes longer than the interval, the next starts immediately after — but never concurrently. This means no `setInterval`; the loop `await`s completion then sleeps for the remaining time.

---

## Consecutive failure threshold

A single failed probe does not immediately emit a `down` event. The health checker tracks a consecutive failure count per service **in memory**. It only emits `service.down` or `service.timed_out` after N consecutive failures (default: 2). Success always emits immediately and resets the counter.

The counter is lost on restart — intentional. The first round after restart re-establishes state quickly.

This prevents dashboard flapping from transient network hiccups.

---

## On-demand checks

The API can trigger a one-off health check for a single service (`POST /api/services/:id/check`). This bypasses the consecutive failure threshold — it's a deliberate user action, not automated observation. Returns the updated health state immediately.

---

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `BANTER_HEALTH_INTERVAL_MS` | `900000` | Check interval |
| (threshold) | `2` | Consecutive failures before emitting down event |
