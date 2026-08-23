# Architecture

Banter is a self-hosted voice chat interface for an OpenClaw gateway, plus the
orchestration needed to keep the speech models it depends on from sitting
resident in memory all day.

Two things, tightly coupled by necessity rather than design ambition:

1. **A browser voice interface.** Voice activity detection, semantic turn
   detection, streaming text-to-speech with barge-in — all running in the page,
   talking to model servers over HTTP and to an OpenClaw gateway over WebSocket.
2. **A control plane.** Knows every model server, health-checks them, and starts
   them on demand so a machine with finite memory can host more models than it
   can run at once.

If you only want the first, the second is still hard to avoid: a 3B parameter
speech model that loads in eight seconds is not something you want resident
permanently, and something has to decide when to load it.

---

## The pieces

**Control plane.** The always-on process. Serves the dashboard, holds the
registry of every known service and host, runs periodic health checks, and
exposes an HTTP API the dashboard uses. Written in TypeScript, runs under Bun,
managed by systemd. See [components/control-plane-api.md](../components/control-plane-api.md).

**Registry.** A JSON file per host describing services: what they are, where
they run, how to start them, how to check their health. This is the source of
truth — the control plane reads its own listening port from its own entry.
See [components/registry.md](../components/registry.md).

**Control shard.** Optional. A full second instance of the control plane on a
worker machine — its own registry, health checker, event log, and API — because
a control plane cannot start processes on a machine it isn't running on. The
primary polls it and merges its services into one view. The shard adds idle
eviction, Tailscale Serve management, and memory reporting on top of that base.
Its own code is platform-neutral; the macOS coupling sits in the supervisor, the
launchd deploy path, and the free-memory probe. See
[control-shard.md](./control-shard.md).

**Dashboard.** A React SPA served directly by the control plane. Two pages: chat
(the root route) and services. Everything voice-related happens here, in the
browser — the control plane never touches audio.

**Model servers.** STT and TTS processes, each exposing an OpenAI-compatible
HTTP API. Banter ships adapter code for several (see `services/`) but starts
nothing itself; a registry entry points at whatever you have installed.

**OpenClaw gateway.** Not part of banter. The LLM lives behind it, and banter
talks to it over an authenticated WebSocket. The only coupling is a URL and a
token in the config file — banter knows nothing about how OpenClaw is installed
or laid out on disk. See [../gateway/](../gateway/).

---

## How a turn works

Worth following once end to end, because it explains why the pieces are shaped
the way they are.

1. The browser captures microphone audio and runs **voice activity detection**
   locally, in WASM. Nothing leaves the machine while you are silent.
2. When speech is detected, a **semantic turn detector** decides whether you
   have finished a thought or merely paused. This is a model, not a timeout —
   "I was thinking that…" and "I was thinking that." differ.
3. The utterance is sent to the **STT service** as a WAV. If that service is
   demand-loaded and not running, the control plane starts it first and waits
   for its health check to pass.
4. The transcript goes to the **gateway** over WebSocket, which routes it to an
   agent and streams back tokens.
5. Tokens are chunked into speakable units and sent to the **TTS service** as
   they arrive, so speech begins before the response is complete.
6. Audio streams back and plays. If you start speaking again, playback stops —
   **barge-in** — and the loop returns to step 2.

Steps 1, 2, 5, and 6 are browser-side. Step 3 and 4 cross the network. The
control plane participates only in "is this service up, and if not, start it."

---

## Why the control plane exists

A voice interface needs an STT model and a TTS model resident to respond
quickly. Keeping both loaded costs several gigabytes continuously. On a machine
that is also doing other work, that is the difference between a system that
works and one that swaps.

So services are **demand-loaded**: started on first use, health-checked until
ready, and evicted after an idle timeout. That requires something that knows
what exists, what is running, and what it costs — which is the registry, the
health checker, and the lifecycle manager.

See [components/service-lifecycle.md](../components/service-lifecycle.md) and
[components/health-checker.md](../components/health-checker.md).

---

## Network model

The default and only configuration we run is a [Tailscale](https://tailscale.com/)
tailnet, with services exposed via `tailscale serve`. The code does not require
it.

A service's endpoint is derived at load time from its host, its port, and how it
is exposed:

- `tailscaleServe: true` — the platform registers the service with `tailscale
  serve` on start and tears it down on stop. Serve terminates TLS, so the
  endpoint is `https://`.
- Otherwise — nothing is registered, `tailscale` is never invoked, and the
  endpoint is plain `http://`. A service already running at a known address can
  simply be declared and observed.
- `scheme` overrides that derivation for a service behind some other TLS
  terminator. `listenAddress` overrides the address only, not the scheme.

The control plane reaches a shard by hostname and the browser reaches model
servers directly, so both need to be routable from wherever you use the
dashboard. A tailnet handles that; so does a LAN, at the cost of owning the
transport security Serve would otherwise provide. Nothing here belongs on the
public internet.

Model servers keep CORS allowlists naming the dashboard's origin. Change the
port the dashboard runs on and voice breaks with an error the browser refuses to
explain.

---

## Configuration

Two files, both per-deployment and both gitignored:

- **`registry.json`** — hosts, capabilities, services. Includes the control
  plane's own entry, from which it reads its listening port.
- **`config.json`** — the gateway URL and token, voice settings (which TTS voice,
  VAD thresholds, turn-taking tuning), and a `runtime` block for the process
  itself.

A normal run needs no environment variables. Every runtime setting has an
environment override, but the files are the source of truth. See the
configuration reference in the README.

---

## What is deliberately absent

**No database.** The registry is a file; the event log is JSONL. Both are
readable and editable with an editor, which matters when a service will not
start at two in the morning.

**No service discovery.** Services are declared, not discovered. A machine that
appears on the tailnet does not automatically become part of the platform.

**No multi-user model.** One operator, one tailnet. Authentication is the
gateway's device pairing, and the tailnet boundary is the security boundary.

**No cloud dependency.** Speech models run on your hardware. The only external
dependency is whatever the OpenClaw gateway itself talks to.

---

## Reading order

For understanding the system: this document, then
[components/registry.md](../components/registry.md) (the data model everything
else reads), then [components/service-lifecycle.md](../components/service-lifecycle.md)
(what makes demand-loading work).

For writing an adapter for a different agent harness: [../gateway/](../gateway/)
documents the OpenClaw wire protocol in detail — connection, authentication,
session model, and the streaming event shapes. It is the most complete
description of what banter actually requires from an agent backend, and the
right starting point for replacing it with something else.

For operating it: the README's configuration and deployment sections, then
[components/health-checker.md](../components/health-checker.md) and
[components/event-log.md](../components/event-log.md).
