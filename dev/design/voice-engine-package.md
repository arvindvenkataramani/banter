# Voice engine package

The browser voice engine is a workspace package, `@platform/voice-engine`, at `voice-engine/` beside `shared/`. The dashboard imports it as it imports `@platform/shared`, from source, through Vite.

## The boundary

The package imports nothing from the dashboard. Its dependencies are `@platform/shared`, `zustand`, `onnxruntime-web` and browser APIs. `voice-engine/src/boundary.test.ts` fails on any import that resolves outside `voice-engine/src/` other than a declared dependency or a Node builtin, and the package's tsconfig has no `@/` alias.

The dashboard keeps what talks to the control plane or owns the page's wiring, in `dashboard/src/lib/voice/`:

- `system/index.ts` builds the page's one `VoiceSystem` from real collaborators: `sonner` for notifications, `pingService` and `ensureServiceReady` for the speech services, the devices, the browser models.
- `voice-service.ts` starts and loads speech services through `/api/services`.
- `apply-voice-settings.ts` writes the selection through the API and pushes it into the running system.
- `index.ts` re-exports the package and `voice-service.ts`, so `@/lib/voice` imports reach both. Other imports of engine modules use package subpaths, such as `@platform/voice-engine/human/mute-store`.

`devices.ts` and `mic-frames-worklet.js` belong to the package; only voice code uses them.

The host serves what the engine fetches by absolute path on its own origin: the browser models under `/models/` (`silero_vad_legacy.onnx`, `smart-turn-v3.2-cpu.onnx`, `whisper-tiny/preprocessor_config.json`) and the tones under `/tones/voice/`. The dashboard serves both from `public/`. The boundary test checks imports only and cannot see these.

## What the host supplies

- **A session.** The engine reads a chat session through the structural `VoiceSession` type in `session.ts`: `conversation.getSnapshot()` (`known`, `runActive`, `runId`, `activity`), `conversation.subscribe`, `conversation.onEvent`, and `controls.send`/`controls.abort`. The dashboard's `Session` class satisfies it without an adapter.
- **Run events.** `RunEvent` and `Activity` are defined in `run-event.ts`; the dashboard's `run-state.ts` re-exports them and maps gateway frames onto them.
- **A stop control.** `audio-halters.ts` holds the one registry of audio halters. `AgentVoice` registers its player's cancel; the dashboard's `SessionControls.stop()` calls `haltAudio()` before aborting, so audio goes silent before the abort RPC resolves.
- **Service readiness.** `BatchSttTransport` re-resolves its endpoint after a failure through an `ensureServiceReady` it is given. `createSttTransport` requires it, and the dashboard's wiring passes the control-plane implementation.
- **Voice API types.** `VoiceSelectionPatch` and `VoiceUpdateResult` are defined in `voice-config.ts`, and `SttModelKind` in `human/stt-transport.ts`; `api.ts` and `voice-service.ts` import them.

## Tests and tooling

Tests live with the code they cover. Three stay in the dashboard because they need its objects or files: `agent/speech-chunker.test.ts` builds a real `Conversation`, `human/whisper-features.test.ts` reads the `public/models` fixture, and `voice-service.test.ts` covers dashboard code.

The dashboard's vitest config includes `../voice-engine/src/**/*.test.{ts,tsx}`, so `cd dashboard && bunx vitest run` covers all voice code under one setup file. The dashboard's `tsc -b` references the package's tsconfig, which carries `vite/client` types for the engine's `?url` imports and `new URL(..., import.meta.url)`. The root tsconfig excludes `voice-engine` as it excludes `dashboard`. The `ManagedMediaSource` declaration lives in the package; the dashboard's tsconfig includes it because the settings page uses the global too.

ESLint scopes a config to its own directory, so the dashboard's `eslint .` does not reach the package. The package lints with the dashboard's config through its own script: `cd voice-engine && bun run lint`.

The deploy scripts drop `voice-engine` from the production `package.json` workspaces, as they drop `dashboard`: production runs the built dashboard, and the engine is inside that build.
