# Voice Interface — UI Structure and Implementation State

*Last updated: 2026-08-06*  
*Implementation: `dashboard/src/lib/voice/`, `dashboard/src/features/chat/`*

The voice interface is the primary interaction mode for Banter. It lives inside the Chat page (`/chat`) as the default input mode on mobile, and as an optional mode on desktop. There is no standalone voice page — voice is part of the chat surface.

---

## Architecture Overview

The voice pipeline splits into two actor loops that run independently behind Zustand stores, with a single arbiter owning what happens to audio:

**Mic loop** (`mic-loop.ts`) — continuously captures audio, runs VAD (Silero) and turn detection (SmartTurn), and emits transcription results via the `LlmStore`. Managed by `useMicLoop` inside `useVoiceLoop`.

**Playback loop** (`playback-engine.ts`) — consumes TTS audio chunks from the backend and plays them sequentially. Managed by `PlaybackEngine`, tracked in `PlayerStore`.

**Audio disposition** (`playback-arbiter.ts`) — the single owner of pause / resume / hold / release / drop / cancel. Every other actor reports *facts* (what state the player and mic were observed in) and this module decides the command; nothing else drives the playback engine. It exists because five call sites each used to decide on their own local reading, with no shared model and no arbitration between them.

**Mute** (`store/mute-store.ts`) — mic mute, speech mute, and their linkage as one store. The two mutes travel together (LINKED) until set individually, and re-link on landing back at both-unmuted. Speech mute is a playback control, not a synthesis one: muting speech pauses audio rather than suppressing generation.

**Coordination** (`use-voice-loop.ts`) — top-level hook that wires the loops together, manages voice config loading, and handles mic ↔ playback coordination (e.g. muting the mic while the agent is speaking).

**Config** (`voice-config.ts`) — `fetchVoiceConfig()` loads TTS/STT config from `GET /api/voice`; the chat page holds the resolved provider, model, voice, speed and chunk strategy in component state and passes them into `useVoiceLoop`.

---

## Chat Page Layout

```
┌─────────────────────────────────────────┐
│  Control bar (agent · model · session)  │
├─────────────────────────────────────────┤
│                                         │
│  Message area (scrollable)              │
│  - Assistant messages: full-width,      │
│    serif, no bubble                     │
│  - User messages: right-aligned bubble, │
│    rust-brown tint                      │
│  - Typing indicator                     │
│  - Disconnect banner (when offline)     │
│                                         │
├─────────────────────────────────────────┤
│  Input bar (pinned bottom)              │
│  Mobile: voice dock (default)           │
│  Desktop: text input + voice toggle     │
└─────────────────────────────────────────┘
```

### Voice dock (mobile)

`voice-chat-input.tsx` — the mobile voice input component. Three states:

**Idle (voice mode):** Pill row with three equal pills — Mic · Speech · Pause. A "Mute All" + "Type" row below.

**Listening (mic active):** Visual indication that mic is capturing. VAD and turn-taking running in the background.

**Speaking (agent talking):** Mic muted. Playback engine active. Visual indication (glow overlay on the chat page).

The `chat-glow-overlay` div on `.chat-page` shows a warm glow (`data-glow-state="hearing"`) while user is speaking, and a cool glow (`data-glow-state="playing"`) while the agent is speaking.

### Desktop input

`voice-chat-input-desktop.tsx` — text input with a voice toggle button. Same underlying voice loop, but surfaced differently. Text input is primary on desktop; voice is activated by button.

---

## Voice Pipeline Components

### VAD: Silero (`silero-vad.ts`)

Runs Silero VAD ONNX model on 512-sample frames (16kHz, ~32ms each). Returns speech probability per frame. Used to detect when user is speaking vs. silent.

Status: implemented and working.

### Turn detection: SmartTurn (`smart-turn.ts`)

Runs a custom ONNX model on an 8-second sliding audio window. Returns turn-completion probability — whether the user has finished their turn. Higher probability → transcript the current audio and send.

Requires `onnxruntime-web@1.18.0` with the `ort.all` bundle (`onnxruntime-web/experimental`). **Do not upgrade ort.** Versions ≥1.19 dropped single-threaded WASM and require COOP/COEP headers.

Status: implemented and working.

### STT (`stt-client.ts`)

`transcribeAudio(endpoint, wavBytes)` — POST to whichever STT service is configured. Returns transcript text. The client is model-agnostic; it just calls whatever OpenAI-compatible endpoint the registry resolves to (see `docs/models.md` for what "OpenAI-compatible" means here).

The endpoint URL comes from voice config / service registry, and may be demand-loaded (e.g. on a shard) rather than always running.

Status: implemented and working with a properly registered STT service.

### TTS: Streaming backend (`streaming-backend.ts`, `playback-engine.ts`)

TTS requests stream audio chunks from a demand-loaded provider on the worker host. The `PlaybackEngine` feeds these into either MSE streaming or a blob queue, depending on browser support.

Text → TTS path:
1. `text-chunker.ts` splits LLM output into speakable chunks at sentence boundaries
2. `text-cleaner.ts` strips markdown for clean TTS input
3. `streaming-backend.ts` POSTs each chunk to the TTS endpoint
4. `PlaybackEngine` queues and plays audio chunks in order

Status: implemented. Which TTS/STT services are actually registered is
deployment-specific — see the running instance's registry, or `docs/models.md`
for the models this repo has adapters or setup snippets for.

---

## Voice Settings

`voice-settings.tsx` — a dialog (accessible from the nav bar shortcut or chat control bar), in three tabs:

**General** — transcription (the STT picker, shown only when more than one STT service is registered), TTS provider + model + voice, speed, and the playback streaming mode (auto / MMS / MSE / blob).

**Speech** — chunking: strategy and min/max word counts. Chunking is currently the only setting that can vary per model, so it is the whole tab.

**Debug** — diagnostic controls, including mic sample saving.

### Settings scope

Chunking resolves through `settingsScope`, stored once and app-wide:

| Scope | Chain, per field |
|---|---|
| `global` | your saved options only |
| `per-model` | model override → the model's own declared defaults → your options |

Global is the backstop in both, so a partial override never leaves a field unfilled. Overrides live in `config.json` under `voice.tts.modelPrefs[serviceId][modelId]` and hold only the fields actually changed. Anything other than an explicit `"global"` — the field being absent included — resolves as per-model; with nothing overridden the two behave identically.

The resolution logic is `model-settings.ts` (generic over a setting descriptor) with chunking's descriptor in `chunking-setting.ts`.

All settings read from `GET /api/voice` and write back via `PATCH /api/voice/selection`. Server-authoritative — localStorage is not used for voice selection state.

---

## Design reference

The actor model — the stores, the cross-actor reports, and the
mute/pause/hold semantics — is specified where it is enforced:
`playback-arbiter.ts` states the rules turning a reported fact into an audio
command, and `store/mute-store.ts` states the mute coupling. Those files are
the authority on intended behaviour; this page describes the surface.

The settings model — scope, per-model overrides, and the resolution order — is
specified in `model-settings.ts`, with chunking's descriptor in
`chunking-setting.ts`. `docs/models.md` covers it from the user's side.

---

## What this document does NOT cover

- Gateway protocol (WebSocket session lifecycle, RPC details) — see `../gateway/gateway-session-lifecycle.md`
- Voice settings API shape — see `/api/openapi.json`, or `docs/api-reference.md`
- Audio encoding details — see `wav-encoder.ts` inline
