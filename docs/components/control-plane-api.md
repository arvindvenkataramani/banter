# Component: Control Plane API

*Thin translation layer between the registry/event log and consumers.*

---

## What it is

The API is a thin HTTP layer. It reads from the in-memory registry and event log, delegates mutations to the registry and event modules, and shells out lifecycle commands. It contains no business logic of its own.

Hono on Bun, port 4200 prod / 4201 dev (configurable via `BANTER_CONTROL_PORT`). Serves both the REST API and the dashboard static files.

---

## Construction

The app is created via a factory function that accepts dependencies: in-memory registry state, event log path, health check function, lifecycle action runner. Tests inject controlled dependencies; the real entry point injects production values. No globals, no environment variables inside route handlers.

---

## Endpoints
An automatically generated, up-to-date endpoint reference is in [docs/api-reference.md](../api-reference.md).

---

## Lifecycle action runner

Commands are executed by shelling out to the command string from the registry (split on spaces). Stderr is captured. Non-zero exit code = failure, stderr returned as error message.

No assumptions about the underlying init system — the registry owns that knowledge via the command strings.

---

## Response shape

Services are always returned as `ServiceWithHealth`:
```typescript
{ ...Service, health: HealthState, lastEvent: Event | null }
```

Disabled services get `health: "disabled"` and `lastEvent: null` without event log lookup.

---

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `BANTER_CONTROL_PORT` | `4200` (prod) / `4201` (dev) | HTTP port |
| `BANTER_REGISTRY_PATH` | `control/control-plane/data/registry.json` | Registry file |
| `BANTER_EVENTS_PATH` | `logs/events.jsonl` inside the deployment | Event log |
