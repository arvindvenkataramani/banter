# Components

One file per component, describing **what is built and how it works** — routes, modules, data shapes, failure paths, the mechanics someone needs to change the code or debug it in production.

## These files are implementation detail, and that is the point

**Do not thin these documents out.** They are the only written record of how the system actually works. A cleanup pass that removes "implementation details" from a component doc destroys the thing the doc exists for. Some of this detail was recovered from specs that no longer exist; there is nowhere else to read it.

What lives here: route shapes and status codes, header and validator handling, file and folder layout, atomic-write ordering, derivation rules, module names and their responsibilities, what fails and how it is reported.

## What lives elsewhere instead

| | Holds | Example |
|---|---|---|
| `docs/reference/components/` | **What is built, and how it works** | The audio route serves single-range requests, clamps them, and falls back to a full body on a multi-range header |
| `docs/reference/design/` | **Why it is shaped this way** — intention, workflow, experience. `dev/design/` holds the same for work not yet built | Voice outlives the page because a session that ends when you navigate is not a session |
| `docs/reference/architecture.md` | **The shape of the whole system** — planes, hosts, ownership | The control plane never touches audio |

The test: a component doc answers *how does this work*; a design doc answers *why is it like this, and what is it for*. Neither is a summary of the other, and a fact that belongs in one is not redundant because it appears in the other in different words.

## When you change the code

Update the component doc in the same change. It states the current state, never the path taken to reach it — no "previously", no superseded-decision chains, no dated revision notes. Where a rationale prevents a future mistake, keep it: *"no heartbeat from the player, because inference cannot see a paused player"* earns its place because without it someone proposes the heartbeat again.

## The files

- [`registry.md`](registry.md) — hosts, capabilities, service config; load, validate, atomic write
- [`event-log.md`](event-log.md) — the append-only JSONL ground truth and how state derives from it
- [`health-checker.md`](health-checker.md) — check rounds, the Tailscale-then-localhost path, failure thresholds
- [`service-lifecycle.md`](service-lifecycle.md) — start, stop, demand-loading, idle eviction
- [`control-plane-api.md`](control-plane-api.md) — the REST surface and the app factory
- [`dashboard.md`](dashboard.md) — the React SPA, its build and how it is served
- [`dashboard-views.md`](dashboard-views.md) — view structure, state ownership, the add-a-view checklist
- [`chat.md`](chat.md) — the gateway session, message handling, the composer
- [`voice-turn-taking.md`](voice-turn-taking.md) — one record per voice actor, each reporting to the turn manager: [human turn](voice-turn-taking.md#human-turn--voice-enginesrcturn-managerts-voice-enginesrcstoreturn-manager-storets), [agent turn and floor](voice-turn-taking.md#agent-turn-and-floor--voice-enginesrcturn-managerts-voice-enginesrcstoreturn-manager-storets), [MicLoop](voice-turn-taking.md#micloop--voice-enginesrchumanmic-loopts), [HumanVoice](voice-turn-taking.md#humanvoice--voice-enginesrchumanhuman-voicets), [transcript store](voice-turn-taking.md#transcript-store--voice-enginesrcstoretranscript-storets), [PlaybackEngine](voice-turn-taking.md#playbackengine--voice-enginesrcsystemplayback-enginets), [AgentVoice](voice-turn-taking.md#agentvoice--voice-enginesrcagentagent-voicets), [SpeechChunker](voice-turn-taking.md#speechchunker--voice-enginesrcagentspeech-chunkerts), [composer](voice-turn-taking.md#composer--dashboardsrcfeatureschatuse-chat-textareats-dashboardsrcfeatureschatvoice-controls-mobiletsx)
- [`stt.md`](stt.md), [`tts.md`](tts.md) — the transcription and speech services the voice loop calls
