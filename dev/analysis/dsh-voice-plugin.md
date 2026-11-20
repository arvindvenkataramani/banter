# Banter voice as a dsh plugin — feasibility and effort

**Stage: analysis.** A rough sizing and a sketch of how the plugin would work. Not a plan or a spec. No code exists.

*Read against dsh `66491b05e3` (`dsh-v0.2.2-rc.1`, the npm `latest` release), from [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness). Line citations below are at that commit.*

Companions: [`dev/design/agent-backend-abstraction.md`](../design/agent-backend-abstraction.md) for where dsh sits among Banter's backends, [`dev/design/voice-engine-package.md`](../design/voice-engine-package.md) for the engine package the plugin would consume, and [`docs/reference/protocols/dsh/dsh-web-protocol.md`](../../docs/reference/protocols/dsh/dsh-web-protocol.md) for dsh's wire.

---

## The question

There are two ways to bring Banter's voice to dsh:

- **The adapter.** Banter's dashboard talks to a dsh session through a control-plane proxy. Voice and rendering stay in Banter.
- **The plugin.** A dsh plugin runs Banter's voice loop inside dsh's own web UI. dsh keeps doing all the rendering. The plugin adds a way to turn voice on, a listening/speaking indicator, and the loop itself.

This note covers the plugin, and says which of the two to do first.

## Verdict

**The plugin is feasible without patching dsh, and it is the better one to do first.** Roughly 11–18 working days, with a first working loop after about the first week. Two parts of the estimate carry real uncertainty: the out-of-tree build, which dsh leaves to the plugin author, and single-threaded model inference, because dsh's page is not cross-origin isolated.

The adapter looks like "just match the contract", but it is more than that. It needs a server-side proxy that owns a live agent connection, which Banter's control plane has never done. It needs dsh's launch-token and cookie handled on the server, the RPC envelopes written by hand, a new server-to-browser hop for `RunEvent`, and dsh's events mapped onto Banter's renderers. The plugin skips all of that, because dsh's own browser code already holds the connection and draws the conversation. What the plugin needs from dsh is small: one object per session that gives it the event stream, `prompt` and `cancel`.

Both pathways share the same first step, and it is done: the voice engine is the workspace package `@platform/voice-engine` (`voice-engine/src/`), which reads a conversation through the structural `VoiceSession` type instead of the OpenClaw `Session` class.

The plugin's cost is upkeep. dsh's `latest` is a release candidate, four newer rc tags exist, and the client surfaces the plugin touches change on every release. Everything the plugin depends on is an internal UI contract in a pre-1.0 project.

## How the plugin works

### What dsh gives a browser plugin

- **Install.** `dsh plugin --profile <p> add <pkg>` installs an npm package, a tarball or a linked checkout into a profile (`docs/user/develop/basic/publish.md`). The profile lives at `$DSH_HOME/profiles/<p>` (default `~/.dsh`); `dsh web` boots the `web` profile, which the same command can install into. pnpm must be on PATH. The package declares `dsh.bundle` (a `cordis.patch.yml` that adds the plugin rows) to be activated, and a package declaring `dsh.client` with an `exports["./client"]` bundle has its browser code served under `/plugins/` and booted into the page. dsh is not rebuilt (`packages/client/modules/README.md`).
- **Version gating.** Install and profile start check the package against the running dsh: `engines.dsh` decides when declared, otherwise every `@deepseek-ai/dsh*` peer range must match (`packages/boot/app-boot/README.md:52`). Resolution of linked imports does not validate peer ranges (`publish.md`). The Node floor is `>=24.9.0` (`package.json` `engines`).
- **A session handle outside React.** The client entry exports `inject = [..., 'sessions', ...]` and `apply(ctx)`, as `packages/client/ui-open-in-app/src/client/index.ts:50,85` does. `ctx.sessions.binding(sessionId)` returns `{ session, eventSource, ctx }` (`packages/api/session-controller/src/client/sessions/service.ts:105-112,539`), but only borrows: it returns `undefined` unless something retains the session. The main view retains the open conversation (`packages/client/ui-workspace/src/client/navigation.ts:530`); a plugin that must outlive navigation calls `ctx.sessions.retain(id, { source })` itself (`contract/sessions.ts:46-58`).
  - `session.prompt(content: PromptContentPart[], 'queue' | 'steer', signal?, requestId?)` takes content parts (`{ type: 'text', text }` or an inline image) and returns a `RemoteResult`, so the caller checks `.ok` (`contract/session.ts:98-104`). `'steer'` folds into the nearest step boundary of the running turn, or starts a turn when idle (`packages/api/session-controller/src/commands.ts:338-339`); the client doc comment calling it an interrupt is wrong about the host.
  - `session.cancel()` returns a `RemoteResult` and keeps queued input (`commands.ts:476`). The snapshot carries `running`.
  - `ctx.conversation.send(text)` queues one text block into the caller's session scope and throws from a root context (`packages/client/ui-conversation/src/client/service.ts:209,561-572`). It is reached as `ctx.sessions.scope(id).conversation`.
- **The event window.** `eventSource` is a subscribable `SessionEventWindow { entries, hasMore, revision, change }` (`contract/events.ts:68-98`). `change` is the exact delta of the latest notification: `replace`, `prepend`, `append` or `settle-assistant`.
  - Streamed text arrives as transient entries of type `assistant/live-chunk` carrying the raw chunk in `data.chunk`, `text-delta` and `reasoning-delta` separately (`StreamChunk`, `packages/llm/llm/src/types.ts:496-508`), with `attemptId`, `turn` and `step`.
  - An interrupted or failed attempt settles at once, and a cancelled attempt is abandoned (`settle-assistant` with no entry). A successful attempt appends its durable `assistant/message` and keeps its transient rows until the step ends (`sessions/assistant-stream.ts:152-194`, `sessions/session.ts:738-757`). End of text is therefore the durable `assistant/message`, and a consumer dedupes by `attemptId` and chunk `index`.
  - A gap in the frame stream triggers a resync that reinstalls the whole window as one `replace`, replaying the active attempt's chunks already sent. A speech consumer treats `replace` as "reset the position within this attempt", not as new text.
  - Durable `turn/end` events carry a reason: `completed`, `aborted`, `blocked`, `error`, `max-tokens`, `interrupted` or `forked` (`packages/core/session/src/types.ts:206-227,303`).
- **UI slots.** Session-scoped slots receive `sessionId`, `useSession`, `useProjection`, `useAccess`, `useConversation`, `useInput` and `inputActions` as standard props, merged from several packages (`packages/client/ui-session/src/client/index.ts:166`, `packages/client/ui-conversation/src/client/contract/slots.ts:385`). The generated catalog `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` lists every slot with its kind, scope, props and occupants.
- **React 18.3.1, shared.** React, React DOM, cordis, zod, `@tanstack/react-virtual` and dsh's store, slots, primitives and dockkit packages are one module table shared with every plugin (`packages/client/web/src/platform.ts:8`).
- **No CSP.** Nothing on dsh's web path sets a Content-Security-Policy, so WASM, Blob workers and calls to STT/TTS servers are not blocked.
- **Not cross-origin isolated.** dsh sets no COOP or COEP header anywhere; the web server's config has only host, port, TLS and compression, and the SPA responder sets only content type and cache headers (`packages/host/frontend-static/src/index.ts:104-125`). The page is not `crossOriginIsolated`, so `SharedArrayBuffer` is unavailable. See the risks.

### Activation

Three pieces, all with precedent in dsh's own code:

1. **A toggle in the composer tool row.** Use `conversation.input.right`, a list slot for compact controls next to Send (`slots.ts:316`). It renders only when a session exists, and dsh hides it while the activity occupant is expanded (`skeleton/InputBar.tsx:516-520`). `conversation.input.left` is the alternative at the other end of the row. Do not use `conversation.input.activity`, where dsh's own mic sits. That slot takes a single occupant and registration throws when it is taken at the default priority (`packages/client/ui-slots/src/index.ts:1220-1222`), so the plugin would fail to load whenever dsh's voice-input bundle is enabled. The click is also the user gesture the browser needs before it will open the mic and start audio.
2. **A keyboard shortcut** through `ctx.shortcuts.register` (`id`, `label`, `defaults` per platform, `regions`, `resolve`), the same call `ui-open-in-app` uses at `index.ts:85`. It appears in dsh's shortcut settings and the user can rebind it.
3. **The bundle switch.** The plugin shows up in dsh's Plugins sidebar and is turned on there. The keyed slots `plugins.bundle.activation` (a first-run prompt for mic permission and service check) and `plugins.bundle.config` (a settings card) are keyed by the **bundle** package name. dsh's voice-input bundle uses both (`packages/experimental/client-ui-voice-input/src/client/mount.ts:60-69`).

Voice mode belongs to one session at a time: the one whose toggle was pressed. Switching sessions should pause it.

### Showing listening and speaking

Banter's turn-manager store already knows the floor state (idle, listening, user speaking, thinking, agent speaking). The plugin exposes that store to React the way dsh's voice input exposes its readiness state: as an injected observable that becomes a hook in the slot component.

- **The toggle itself** changes with the state. dsh's primitives include a `StateDot` (`packages/client/ui-primitives/src/index.ts:8`).
- **A strip below the composer** in `conversation.composer.dock` (a list slot for ambient entries, `slots.ts:306`, rendered for the composer variant only) shows the state label, a mic level meter and the partial transcript. `conversation.input.overlay` is the alternative if it should float inside the composer card. Fixed-position overlays must portal to the document body.
- **The user's words need no renderer.** Once an utterance is sent, dsh echoes it as an ordinary user message. The partial transcript before sending is the only text the plugin draws itself.

### The voice loop

The loop lives in the plugin's context, not in a React component, so it survives re-renders. On activation it retains the session, takes the binding and runs Banter's engine against it.

| Step | Banter code, reused | dsh call |
|---|---|---|
| Hear the user | `human/` mic loop, Silero VAD, smart-turn, STT transports | none |
| Send the utterance | turn manager | `session.prompt([{ type: 'text', text }], 'queue')`, or `'steer'` to fold into a running turn; `ctx.sessions.scope(id).conversation.send(text)` queues |
| Read the reply | `agent/` speech and text chunkers | subscribe to `eventSource`; take `text-delta` from `assistant/live-chunk` entries, dedupe by `attemptId` and `index`, reset position on `replace` |
| Speak it | `system/playback-engine.ts` | none |
| Know the turn ended | turn manager | durable `assistant/message` append and `turn/end` events; `session.running` |
| Barge-in | turn manager, `haltAudio()` | `session.cancel()`, then send the new utterance |

Two behaviours to decide rather than discover:

- **Approvals.** A tool that needs approval blocks the turn. For a first version the plugin plays a tone and the user clicks dsh's own approval card. Answering by voice is later work.
- **Hidden tab and focus loss.** dsh's voice input cancels a recording when the page is hidden (`document.hidden`) and also when the window loses focus (`blur`), and on Escape (`packages/experimental/client-ui-voice-input/src/client/VoiceInput.tsx:84-99`). A hands-free loop should keep running, so the plugin must copy neither handler.

### The host half

The plugin needs a small server-side part as well:

- **Model and tone files.** dsh's `/plugins/` route serves each plugin's JavaScript and the images a package publishes through its `./assets/*` export (svg, png, webp, jpg; `packages/client/modules/src/assets.ts`). Anything else under it is 404, so the ONNX models, the ort WASM and the mp3 tones need their own route. Two routes exist: `ctx.webServer.register` with a handler or a Fetch-style `resource` (`packages/host/webserver/src/index.ts:445`), as `packages/host/open-in-app` does, gated with `ctx.connection.requestRejection(req)` (`packages/experimental/inspector/src/host/plugin.ts:93-110` serves a directory of static files this way and sets its own headers); and `ctx.connection.fetch.register`, an owner-authenticated exact route under `/api` (`packages/client/connection/src/rpc.ts:152-176`). Both can set any content type and header and stream binary bodies. The route path is the URL path on dsh's origin. dsh's own references are document-relative (the page carries `<base href="./">`), so the plugin builds its URLs from `document.baseURI`.
- **Voice guidance for the agent.** `ctx.systemPrompt.section({ name, order, text })` adds a prompt section in the calling context's scope (`packages/core/system-prompt/src/index.ts:485`). `text` may be a function evaluated at each prompt assembly with the assembly's scope, so a section that returns an empty string unless the session has voice on switches per session without re-registering. This replaces `plugins/openclaw/voice-mode`, Banter's OpenClaw plugin. The switch needs a browser-to-host call to tell the host which sessions have voice on, and changing the prompt mid-session changes the prompt prefix. Not run.
- **Optional STT/TTS pass-through** on loopback, so the browser stays same-origin and CORS and HTTP/HTTPS mixing stop mattering.

### Where speech models come from

This decides how easy the plugin is for other people, more than the plugin code does. There are two tiers:

- **Full quality: Banter's services.** Streaming STT and TTS from fluid, kokoro and the rest, either dialled directly or through the host pass-through. The user has to install and run them, with or without Banter's control plane.
- **Zero setup.** STT through dsh's own SenseVoice provider, which handles its own model download. It is batch-only and is called as `ctx.remote.speech.transcribe` with a base64 WAV (`packages/experimental/api-speech-to-text/src/index.ts:89`), so it needs a new transport behind Banter's `SttTransport` interface, sending one VAD-cut utterance at a time. Banter's existing batch transport posts to an HTTP endpoint and does not fit as is; the audio encoder is reusable. TTS through the browser's `speechSynthesis`, behind Banter's four-method `SpeechPlayer` interface. Quality and latency are worse, but it installs with one command. It needs dsh's experimental voice-input bundle enabled, which mounts the speech remote and also puts dsh's own mic button in the composer next to the plugin's toggle.

Shipping the zero-setup tier as the default and Banter's services as the upgrade is what makes "easier for most people" true.

## Where Banter's voice code stands

The engine is `@platform/voice-engine` at `voice-engine/src/`, about 7.8k lines of non-test code. It imports nothing from the dashboard, and a boundary test enforces that (`dev/design/voice-engine-package.md`). The dashboard keeps what talks to the control plane or owns the page's wiring, in `dashboard/src/lib/voice/`: `system/index.ts` (builds the page's `VoiceSystem`), `voice-service.ts`, `apply-voice-settings.ts` and `index.ts`. Most of the engine should move to a plugin untouched: `human/`, `system/playback-engine.ts`, `turn-manager.ts`, and the chunkers. The seams the host supplies:

| Seam | In the package | On dsh |
|---|---|---|
| Conversation source | structural `VoiceSession` in `session.ts` (`conversation.getSnapshot/subscribe/onEvent`, `controls.send/abort`); the dashboard's `Session` class satisfies it | adapter over the session binding |
| Run events and activity | `RunEvent` and `Activity` in `run-event.ts`; the dashboard's `run-state.ts` maps gateway frames onto them | derived from the event window: live chunks, `assistant/message`, `turn/end`, `session.running` |
| Abort and audio stop | `audio-halters.ts`, one registry; `AgentVoice` registers its player's cancel and the host's stop control calls `haltAudio()` before aborting | `haltAudio()`, then `session.cancel()` |
| Service readiness | `ensureServiceReady` is injected into `createSttTransport`; the dashboard passes the control-plane implementation | the plugin passes its own, for example a ping of the configured endpoint |
| Voice config | `voice-config.ts` reads `GET /api/voice` (`:214`); `model-settings.ts`; the dashboard's `apply-voice-settings.ts` writes selections through the API | dsh plugin settings and a config card |
| Page support gate | `dashboard/src/features/settings/voice-page-support.ts` reports `not-isolated` when `crossOriginIsolated` is false | not reusable on dsh as written: it would report every dsh page unsupported |
| Static assets | root-absolute `/models/silero_vad_legacy.onnx`, `/models/smart-turn-v3.2-cpu.onnx`, `/models/whisper-tiny/preprocessor_config.json` and `/tones/voice/*.mp3` (`human/silero-vad.ts:12`, `human/smart-turn.ts:4-5`, `system/tones.ts:12-14`); ORT module and wasm through Vite `?url` imports (`human/ort-init.ts:2-3`); the mic worklet through `new URL('./mic-frames-worklet.js', import.meta.url)` (`devices.ts:58`) | the host half's route, with the URLs resolved against dsh's origin |
| System-prompt guidance | `plugins/openclaw/voice-mode` | `ctx.systemPrompt.section` |

Banter's voice UI (`voice-controls-mobile.tsx`, `voice-settings.tsx`) is not ported. The plugin's UI is a toggle, a status strip and a short settings card, written against dsh's primitives.

## Effort, rough

| Work | Size | Notes |
|---|---|---|
| Spike: an out-of-tree package that builds, installs and puts a button in the composer | 2–3 d | Includes the asset-URL seam below. See the first risk. |
| Asset-URL seam in the engine: ORT module and wasm, worklet, model and tone URLs supplied by the host instead of imported | 1–2 d | A judgement from the five URL sites in the seam table, not measured |
| dsh adapter and loop wiring: text-delta fold, turn boundaries, send, cancel, barge-in | 2–3 d | Tests from recorded events |
| Activation and indicator: toggle, shortcut, status strip | 2–3 d | |
| Host half: asset route, prompt section | 1–2 d | |
| Settings card and first-run setup | 2–3 d | Endpoints and voice selection only |
| Packaging and install docs | 1–2 d | |
| **Total** | **~11–18 d** | A hard-coded demo of the loop is reachable after the first three rows |

The conversation-source interface and the engine package are in place and are not in the total. Also not in the total: the zero-setup tier (3–4 d, two new components), the STT/TTS pass-through (1–2 d), and approvals or user-questions by voice (3–5 d).

## Risks and ongoing cost

- **Building outside dsh's monorepo is the author's job.** Client bundles are built by a monorepo-internal helper (`packages/client/tsdown.client.ts`) that is not in any published package. dsh's cookbook says a package outside the repository "reproduces that build itself" (`docs/cookbook/adding-a-settings-card.md:60`). The format is a CommonJS bundle wrapped as `window.__ModuleLoader__.load({ id, factory: (require) => { ... return module.exports; } })`, with the shared module table's specifiers left as `require` calls and everything else inlined. A small tsdown config reproduced that wrapper in a scratch build. The preset's CSS-modules injection, `process.env.NODE_ENV` defines and dynamic-import chunking are separate pieces, and a live dsh has not loaded such a bundle.
- **Vite-specific imports in the engine do not survive that build.** In a scratch tsdown build, `import x from './f.wasm?url'` (and `.onnx?url`, `.js?url`) fails with `UNLOADABLE_DEPENDENCY`, and a plain `import './f.wasm'` fails to parse as JavaScript. `new URL('./w.js', import.meta.url)` builds but compiles to `require("url").pathToFileURL(__filename)`, which throws in a browser, and no worker or worklet file is emitted. That all follows from dsh's preset by reading it, not by running it. The preset's own asset mechanism accepts only svg, png, webp and jpg under the package's `src/client/assets/`. Under Vite the engine works because the dashboard's build inlines the mic worklet as a `data:` URL, so it does not depend on the page's origin; under tsdown nothing equivalent happens. Options for the seam: the engine takes its asset URLs from the host (the dashboard supplies Vite imports and public paths, the plugin supplies host-route URLs); a build plugin rewrites `?url` imports into a runtime URL helper; or the worklet and worker source are inlined as strings and loaded from Blob URLs. dsh sets no CSP, so Blob and data URLs are not blocked.
- **Single-threaded inference on dsh.** The engine runs ORT with up to four threads only when `self.crossOriginIsolated`, and one thread otherwise (`voice-engine/src/human/ort-init.ts:27`). dsh's page is not isolated, no plugin API sets headers on the index response (the fallback seat is single-owner and `tapIndex` transforms HTML only), and a `<meta>` tag cannot set COOP or COEP. Latency of Silero VAD and smart-turn on one thread is unmeasured. Two ways to force isolation exist on paper and are both untested: plugin routes that shadow the index and add COOP/COEP (`readResource` follows the HTTP match order, exact routes first, so shadowing both `/` and `/index.html` would also hide the SPA fallback it needs to call), and a service worker served from a plugin route that adds the headers to navigations. COEP can break cross-origin embeds, `credentialless` is not in Safari, and either approach changes the page for every user of the profile.
- **Fast churn and a release-candidate target.** dsh's contracts carry no stability promise, and the services are `declare module` augmentations, so a dsh bump means a rebuild. Declaring `engines.dsh` makes an incompatible dsh refuse the plugin at install and start. A change inside a compatible range can still fail at runtime.
- **Internal contracts.** The plugin depends on slot names, `ctx.sessions.binding`, the event window and the live-chunk entry shape. None carries a stability promise.
- **Toolchain mismatch.** dsh is pnpm and tsdown on Node `>=24.9.0`, and `dsh plugin` needs pnpm on PATH; Banter is bun.
- **One copy of the voice engine.** The engine is a workspace package that the dashboard imports from source. The plugin would consume the same package, so the build above has to resolve it, including the `?url` and `import.meta.url` sites.
- **Spoken and recorded text can differ.** On cancel, dsh commits the text it had streamed, which can run ahead of what was actually spoken aloud. The protocol doc's claim that the two agree holds only for text delivered to the client, not for audio played.
