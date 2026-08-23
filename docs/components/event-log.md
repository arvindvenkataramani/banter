# Component: Event Log

*Append-only ground truth for all state transitions in the platform.*

---

## What it is

The event log records what happened. Current state is always derived from it — never stored directly. This means you can reconstruct, debug, and audit. The dashboard can't show you stale data it invented.

---

## Format

One JSON object per line (`events.jsonl`). Append-only — nothing is ever edited or deleted.

```jsonl
{"id":"evt_abc123","timestamp":"2026-03-25T10:00:00.000Z","type":"service.up","subjectType":"service","subjectId":"embedding","data":{"latencyMs":12},"actor":"system"}
{"id":"evt_def456","timestamp":"2026-03-25T10:05:00.000Z","type":"service.down","subjectType":"service","subjectId":"tts-piper","data":{"reason":"connection_refused"},"actor":"system"}
```

Fields:
- `id` — `crypto.randomUUID()`
- `timestamp` — ISO 8601, generated on append
- `type` — event type (see below)
- `subjectType` — what changed. Currently always `"service"`.
- `subjectId` — the id of the subject
- `data` — type-specific payload (latency, error message, etc.)
- `actor` — `"system"` (health checker) or `"user"` (API action)

---

## Event types and health state mapping

Health state is derived from the most recent event per service, via a fixed
event-type → health-state switch (`shared/src/events.ts`). Any event type
not in the switch, or no event at all, maps to `unknown`.

Notably: `service.up` → `healthy`, `service.degraded` → `degraded`
(Tailscale endpoint unreachable but localhost responded — process up, Serve
broken), `service.down` / `service.stopped` / `service.unloaded` → `down`.

The full `EventType` union — including non-health-state events like
`memory.pressure` and `tailscale.serve_failed` — is `shared/types.ts`
itself; don't hand-copy it here, it will drift.

---

## Storage

Path: `logs/events.jsonl` inside the deployment (configurable via `BANTER_EVENTS_PATH`; the shard uses `BANTER_SHARD_EVENTS_PATH` instead, defaulting to `$BANTER_SHARD_ROOT/banter/logs/events.jsonl`). Not checked into git — runtime state, not config.

---

## Reading

The API reads the entire log once per request and builds a map of `serviceId → most recent event`. One file read per API call, not per service. The dashboard gets derived health state, never raw log data.

---

## Log pruning

The log is unbounded and grows continuously. Pruning strategy: age-based truncation — keep the most recent ~24 hours, write to a temp file, rename into place. This preserves inspectability without unbounded growth.

**Not yet implemented.** Should be added before the log becomes a performance concern (roughly: >100 services × 30s interval × 24h ≈ ~300k lines, which is manageable but worth pruning).

---

## Open questions

- [ ] Pruning implementation — age threshold, who triggers it (startup? cron? size-based?)
- [ ] Multi-subject events — when shards start reporting, events may span hosts or capabilities
