# Component: Dashboard

*The face of Banter. Owns no data, computes no state.*

---

## What it is

A React PWA served directly by the control plane via `serveStatic()` middleware — no separate server process. Built by Vite into `dashboard/dist/`, deployed alongside the control plane. The control shard does not serve it — the shard is API-only; the dashboard talks to it only through the control plane.

Every dashboard response carries `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, which make the page cross-origin isolated so the voice models can run multi-threaded WASM ([turn-taking.md](../design/turn-taking.md#one-multi-threaded-ort-runtime-never-bundled)). Browsers isolate only a secure context, the condition the microphone already needs. The settings dialog warns when the page is not a secure context, since voice can't start there, and notes when a secure page is not isolated, since the models then run on one thread. Under these headers the browser refuses any cross-origin image, script or frame whose server does not opt in, which is why chat shows remote images as links.

**Serving rule:** the Hono app handles `/api/*` routes first; everything else falls through to static file serving with an `index.html` fallback for client-side routing.

**Frontend rule:** if the API says a service is healthy, it shows green. The dashboard never invents state.

---

## Stack

Vite + React + Tailwind + shadcn/ui. Two stylesheets and no more: `src/styles/tokens.css` holds the design tokens, `src/index.css` the shared component vocabulary. No other `.css` files, no `style={{}}`, no one-off styles inside components; they're unauditable and drift. Need a style the system doesn't have? Add a new shared token to `tokens.css` and use that.

---

## Nav bar

Title ("Banter") + tab navigation + commit SHA display (in a development build) + theme toggle (light/dark/system). Theme preference persisted in `localStorage`, applied before first paint to avoid flash.

---

## Routes

| Path | Surface |
|------|---------|
| `/` and `/chat` | Banter conversation, including the voice interface (see [`voice-interface.md`](voice-interface.md)) |
| `/services` | Service registry — cards grouped by host, controls |

Routing is a `path` switch in `App.tsx`, not a router library. `/chat` renders full-bleed; the others share the nav chrome.

Deep links are first-class — each route is saveable as a standalone PWA icon. `/chat` is designed to be saved separately and opened without the rest of the dashboard.

Settings are a dialog opened from the chat page, not a route.

---

## Services view

Service cards in `flex flex-wrap`, grouped by host. Filter by health state via query param, with a clear button.

### Service card

Three-row layout:
- **Row 1:** Display name + capability badge
- **Row 2:** host:port + health badge (online/offline/timed_out/disabled/unknown)
- **Row 3:** Controls (enable/disable toggle, start/stop, restart, details)

### Health badges

| State | Label | Visual |
|-------|-------|--------|
| `healthy` | Online | Green (healthy palette) |
| `down` | Offline | Red (down palette) |
| `timed_out` | Timed Out | Amber (warn palette) |
| `disabled` | Disabled | Grey (muted palette, solid border) |
| `unknown` | Unknown | Grey (muted palette, dashed border) |

Badge styling uses shared `health-badge.ts` utility for consistent classes and labels.

### Controls

- **Enable/Disable toggle** — `Switch` component. Calls enable/disable commands (survives reboot). Label shows current state.
- **Play/Pause** — single toggle button. Shows play (start) when the service is down/stopped, shows pause (stop) when running. Only renders if the service has `startCommand`/`stopCommand`.
- **Restart** — only renders if the service has `restartCommand`.
- All action buttons disabled while a request is in-flight. After any action, trigger an immediate health re-check.

### Protected services

Services with `protected: true` (`control`): lock icon, muted background, no toggle or start/stop buttons. The API rejects stop and disable actions, so the UI reflects the constraint.

### Disabled services

All action buttons grayed out. Toggle still available to re-enable.

### Service detail

Dialog (672px wide) triggered from service card. Shows:
- **Network section:** endpoint, port, healthPath
- **Lifecycle section:** load strategy, idle unload, commands
- Editable fields with save via PATCH
- Recent events for this service

`features/services/widgets/health-summary.tsx` exists but is currently imported nowhere.

---

## Polling

The frontend polls the API on an interval rather than using a WebSocket or SSE — at this number of services, push would buy nothing.

---

## PWA

Installable. Each major route (`/chat`, `/services`) saveable as a separate icon. A browser installs the PWA and exposes the microphone only on a secure origin, so a LAN install over plain http gets neither; [`../setup/remote-access.md`](../../guide/remote-access.md) covers serving over https with Tailscale.

---

## Adding new views

All feature areas live under `dashboard/src/features/<name>/` with a required `page.tsx`. Each page receives a `navigate(path, filter?)` callback and fetches its own data — no shared global state. See [`dashboard-views.md`](dashboard-views.md) for the full checklist (route registration, nav options, optional widgets and sidebar).

---

## Shard services in the primary dashboard

A ControlShard serves no dashboard of its own — it's API-only. The primary dashboard is the only place shard services are visible: it fetches `GET /api/shards` on mount, displays shard hosts in groups even when offline, and offers a "Recheck" button per offline shard.
