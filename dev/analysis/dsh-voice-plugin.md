# Banter voice as a dsh plugin — feasibility and effort

**Stage: analysis.** A rough sizing and a sketch of how the plugin would work. Not a plan or a spec. No code exists.

*Written 2026-09-29 against dsh `639ed01` (`dsh-0.2.0-rc.2`). Revised 2026-10-12 against `d743267` (`dsh-v0.2.1-alpha.2`), checked out at `~/Code/contrib/deepseek-harness`. Everything below was re-read at the later commit.*

Companions: [`dev/design/agent-backend-abstraction.md`](../design/agent-backend-abstraction.md) for where dsh sits among Banter's backends, and [`docs/gateway/dsh/dsh-web-protocol.md`](../../docs/gateway/dsh/dsh-web-protocol.md) for dsh's wire.

---

## The question

There are two ways to bring Banter's voice to dsh:

- **The adapter.** Banter's dashboard talks to a dsh session through a control-plane proxy. Voice and rendering stay in Banter.
- **The plugin.** A dsh plugin runs Banter's voice loop inside dsh's own web UI. dsh keeps doing all the rendering. The plugin adds a way to turn voice on, a listening/speaking indicator, and the loop itself.

This note covers the plugin, and says which of the two to do first.

## Verdict

**The plugin is feasible without patching dsh, and it is the better one to do first.** A first working loop is about a week and a half of work, and a shippable first version is **about 3–4 weeks**.

The adapter looks like "just match the contract", but it is more than that. It needs a server-side proxy that owns a live agent connection, which Banter's control plane has never done. It needs dsh's launch-token and cookie handled on the server, the RPC envelopes written by hand, a new server-to-browser hop for `RunEvent`, and dsh's events mapped onto Banter's renderers. The plugin skips all of that, because dsh's own browser code already holds the connection and draws the conversation. What the plugin needs from dsh is small: one object per session that gives it the event stream, `prompt` and `cancel`.

Both pathways share the same first step: putting Banter's voice engine behind a conversation-source interface instead of the OpenClaw `Session` class. Do that first either way.

The plugin's cost is upkeep. dsh moved 935 commits in the two weeks between the two readings, with 86 files changed in the client surfaces the plugin touches. Everything it depends on is an internal UI contract in a pre-1.0 project.

## How the plugin works

### What dsh gives a browser plugin

- **Install.** `dsh plugin --profile <p> add <pkg>` installs an npm package or a linked checkout into a profile (`docs/user/develop/basic/publish.md`). A package declaring `dsh.client` with an `exports["./client"]` bundle has its browser code served under `/plugins/` and booted into the page. dsh is not rebuilt (`docs/subsystems/client-modules.md`).
- **A session handle outside React.** `ctx.sessions.binding(sessionId)` returns `{ session, eventSource }` (`packages/api/session-controller/src/client/sessions/service.ts:101`). `session` has `prompt(content, 'queue' | 'steer')`, `cancel()` and a snapshot with `running`. `eventSource` is a subscribable window of session events, and each notification carries the incremental `change`, so nothing has to be diffed.
- **Streamed text.** dsh folds stream frames into that event source as transient `assistant/live-chunk` entries carrying the raw chunks, `text-delta` included. It also publishes settlement when a turn commits and abandonment when it is cancelled. Resync after a gap is already handled.
- **UI slots.** Session-scoped slots receive `sessionId`, `useSession`, `useInput` and `inputActions` as standard props (`packages/client/ui-conversation/src/client/contract/slots.ts`).
- **React 18 and no page-wide CSP.** onnxruntime-web WASM and calls to STT/TTS servers are not blocked by dsh.

### Activation

Three pieces, all with precedent in dsh's own code:

1. **A toggle in the composer tool row.** Use `conversation.input.right`, a list slot for compact controls next to Send. Do not use `conversation.input.activity`, where dsh's own mic sits. That slot takes a single occupant and registration throws if it is taken (`packages/client/ui-slots/src/index.ts:1218`), so the plugin would fail to load whenever dsh's voice-input bundle is enabled. The click is also the user gesture the browser needs before it will open the mic and start audio.
2. **A keyboard shortcut** through `ctx.shortcuts.register`, the same call `ui-open-in-app` uses. It appears in dsh's shortcut settings and the user can rebind it.
3. **The bundle switch.** The plugin shows up in dsh's Plugins sidebar and is turned on there. `plugins.bundle.activation` gives a first-run prompt (mic permission, service check) and `plugins.bundle.config` gives a settings card. dsh's voice-input bundle uses both (`packages/experimental/client-ui-voice-input/src/client/mount.ts`).

Voice mode belongs to one session at a time: the one whose toggle was pressed. Switching sessions should pause it.

### Showing listening and speaking

Banter's turn-manager store already knows the floor state (idle, listening, user speaking, thinking, agent speaking). The plugin exposes that store to React the way dsh's voice input exposes its readiness state: as an injected observable that becomes a hook in the slot component.

- **The toggle itself** changes with the state. dsh's primitives include a `StateDot`.
- **A strip below the composer** in `conversation.composer.dock` (a list slot for ambient entries) shows the state label, a mic level meter and the partial transcript. `conversation.input.overlay` is the alternative if it should float inside the composer card.
- **The user's words need no renderer.** Once an utterance is sent, dsh echoes it as an ordinary user message. The partial transcript before sending is the only text the plugin draws itself.

### The voice loop

The loop lives in the plugin's context, not in a React component, so it survives re-renders. On activation it takes the session binding and runs Banter's existing engine against it.

| Step | Banter code, reused | dsh call |
|---|---|---|
| Hear the user | `human/` mic loop, Silero VAD, smart-turn, STT transports | none |
| Send the utterance | turn manager | `ctx.conversation.send(text)` for the scoped session, or `session.prompt(..., 'steer')` to fold into a running turn |
| Read the reply | `agent/` speech and text chunkers | subscribe to `eventSource`, take `text-delta` from `assistant/live-chunk` entries |
| Speak it | `system/playback-engine.ts` | none |
| Know the turn ended | turn manager | `turn/end` events and `session.running` |
| Barge-in | turn manager, `player.cancel()` | `session.cancel()`, then send the new utterance |

Two behaviours to decide rather than discover:

- **Approvals.** A tool that needs approval blocks the turn. For a first version the plugin plays a tone and the user clicks dsh's own approval card. Answering by voice is later work.
- **Hidden tab.** dsh's voice input cancels when the page is hidden. A hands-free loop should keep running, so the plugin must not copy that.

### The host half

The plugin needs a small server-side part as well:

- **Model files.** dsh's `/plugins/` route serves JavaScript only. The ONNX models and the ort WASM need their own route through `ctx.webServer.register`, as `packages/host/open-in-app` does.
- **Voice guidance for the agent.** `ctx.systemPrompt.section(...)` adds a prompt section, and sections can be scoped. This replaces `plugins/voice-mode`, Banter's OpenClaw plugin. Whether a section can be switched on per session at runtime is not yet checked.
- **Optional STT/TTS pass-through** on loopback, so the browser stays same-origin and CORS and HTTP/HTTPS mixing stop mattering.

### Where speech models come from

This decides how easy the plugin is for other people, more than the plugin code does. There are two tiers:

- **Full quality: Banter's services.** Streaming STT and TTS from fluid, kokoro and the rest, either dialled directly or through the host pass-through. The user has to install and run them, with or without Banter's control plane.
- **Zero setup.** STT through dsh's own SenseVoice provider, which handles its own model download. It is batch-only and is called as `ctx.remote.speech.transcribe` with a base64 WAV, so it needs a new transport behind Banter's `SttTransport` interface, sending one VAD-cut utterance at a time. Banter's existing batch transport posts to an HTTP endpoint and does not fit as is; the audio encoder is reusable. TTS through the browser's `speechSynthesis`, behind Banter's four-method `SpeechPlayer` interface. Quality and latency are worse, but it installs with one command. It needs dsh's experimental voice-input bundle enabled, which also puts dsh's own mic button in the composer next to the plugin's toggle.

Shipping the zero-setup tier as the default and Banter's services as the upgrade is what makes "easier for most people" true.

## Where Banter's voice code stands

`dashboard/src/lib/voice/` is about 7.6k lines of non-test code. Most of it is backend-neutral and should move largely untouched: `human/`, `system/playback-engine.ts`, `turn-manager.ts`, and the chunkers. The coupling points are few:

| Seam | Today | On dsh |
|---|---|---|
| Conversation source | concrete `Session` class bound to OpenClaw's `GatewayConnection` (`lib/session.ts`); read by `agent-voice.ts`, `speech-chunker.ts`, `voice-system.ts`, `voice-session-store.ts` | adapter over the session binding |
| Abort | `lib/controls.ts` → `session.abort()` | `session.cancel()` |
| Activity | `run-state.ts` `Activity` into `turn-manager.ts` | derived from turn events and stream frames |
| Voice config | `GET /api/voice` from Banter's control plane (`voice-config.ts:185`), plus `model-settings.ts` and `apply-voice-settings.ts` (~650 lines) | dsh plugin settings and a config card |
| Static assets | same-origin `/models/*.onnx`, ort WASM, tone files | the host half's route |
| System-prompt guidance | `plugins/voice-mode` | `ctx.systemPrompt.section` |

Banter's voice UI (`voice-controls-mobile.tsx`, `voice-settings.tsx`) is not ported. The plugin's UI is a toggle, a status strip and a short settings card, written against dsh's primitives.

## Effort, rough

| Work | Size | Notes |
|---|---|---|
| Spike: an out-of-tree package that builds, installs and puts a button in the composer | 2–3 d | The main unknown. See the first risk. |
| Conversation-source interface in Banter's voice engine; OpenClaw `Session` behind it; dashboard stays green | 3–5 d | Shared with the adapter pathway |
| dsh adapter and loop wiring: text-delta fold, turn boundaries, send, cancel, barge-in | 2–3 d | Tests from recorded events |
| Activation and indicator: toggle, shortcut, status strip | 2–3 d | |
| Host half: asset route, prompt section | 1–2 d | |
| Settings card and first-run setup | 2–3 d | Endpoints and voice selection only |
| Packaging and install docs | 1–2 d | |
| **Total** | **~13–21 d** | A hard-coded demo of the loop is reachable after the first three rows |

Not in the total: the zero-setup tier (3–4 d, two new components), the STT/TTS pass-through (1–2 d), and approvals or user-questions by voice (3–5 d).

## Risks and ongoing cost

- **Building outside dsh's monorepo is undocumented.** Client bundles are built by a monorepo-internal helper (`packages/client/tsdown.client.ts`) that emits a CommonJS bundle wrapped to register with dsh's module table. dsh's docs only cover adding a client package inside the monorepo (`docs/cookbook/adding-a-package.md`), and the out-of-tree plugin tutorial only shows a host-side plugin. The plugin must either reproduce that build or be built from within a dsh checkout. The spike exists to settle this.
- **Fast churn and unvalidated versions.** dsh went from `0.2.0-rc.2` to `0.2.1-alpha.2` in two weeks. Its publish doc says peer version ranges are not checked, so a plugin built against one version installs cleanly on the next and then fails at runtime.
- **Internal contracts.** The plugin depends on slot names, `ctx.sessions.binding`, the event window and the live-chunk entry shape. None carries a stability promise. The services are `declare module` augmentations, so a dsh bump means a rebuild.
- **Toolchain mismatch.** dsh is pnpm and tsdown on Node ≥22.19; Banter is bun.
- **Two copies of the voice engine.** Unless the engine becomes a package that both the dashboard and the plugin consume, fixes land twice. The seam refactor makes that extraction cheap; decide it before porting.
- **Spoken and recorded text can differ.** On cancel, dsh commits the text it had streamed, which can run ahead of what was actually spoken aloud. The protocol doc's claim that the two agree holds only for text delivered to the client, not for audio played.
