# Spec: voice mode as a dsh plugin

The contract for building Banter's voice mode as a DeepSeek Harness (dsh) plugin. Design: [`dev/design/dsh-voice-plugin.md`](../design/dsh-voice-plugin.md). This spec is complete for the build; where it is silent, the decision tiers apply (decide from precedent and log, or write a brief and stop that step).

**Done means:** with the plugin installed into the `web` profile, `npx @deepseek-ai/dsh@0.2.2-rc.1 web` opens dsh, the person turns voice on in a session, and holds a spoken conversation with the agent using the configured STT and TTS services.

**Target:** dsh `dsh-v0.2.2-rc.1`, pinned in every command (`npx @deepseek-ai/dsh@0.2.2-rc.1`), source at `~/Code/contrib/deepseek-harness`, Node `>=24.9.0`. Line references below are at that tag.

---

## 1. Fixed

These are settled. Changing any of them is a tier-2 brief, not a build decision.

- **No patches to dsh.** Everything goes through dsh's plugin surfaces.
- **No change to `@platform/voice-engine`'s contract**: `VoiceSession`, `RunEvent`/`Activity`, the audio-halter registry, `ensureServiceReady` injected into the STT transport, and the engine's root-path asset URLs (`/models/…`, `/tones/voice/…`). The plugin is a second host for that contract. A needed contract change is a brief.
- **No change to the speech servers, their registry or the control plane's config.** The plugin reads the control plane, asks it to start and keep alive the configured speech services exactly as the dashboard does, and relays speech traffic. Nothing else.
- **No live hostnames, URLs or service values in the repo.** Defaults, tests, fixtures, docs and this spec stay generic. Live values are read at install time and written only into the dsh profile.
- **Behaviour is Banter's; look is dsh's.** Where this spec does not state a behaviour, the reference is Banter: [`docs/reference/design/voice-floor.md`](../../docs/reference/design/voice-floor.md), [`docs/reference/design/voice-system.md`](../../docs/reference/design/voice-system.md), [`docs/reference/components/voice-interface.md`](../../docs/reference/components/voice-interface.md), and the dashboard's composer (`dashboard/src/features/chat/chat-composer.tsx`, `use-chat-textarea.ts`). The plugin shows nothing dsh already shows (agent activity, Stop, the model, approvals, the conversation).

## 2. Package

- A workspace at `plugins/dsh/voice/`, added to the root `package.json` workspaces. The two deploy scripts' workspace filters (`ops/control-deploy.sh`, `ops/shard-deploy.sh`) drop it as they drop `dashboard` and `voice-engine`.
- It depends on `@platform/voice-engine` through the workspace and imports engine modules by package subpath, as the dashboard does (`dashboard/src/lib/voice/system/index.ts`).
- Two halves: `src/client/` (browser) and `src/host/` (runs in the dsh process).
- **Client build.** Vite, so the engine's `?url` imports and `new URL(…, import.meta.url)` resolve as they do for the dashboard. The output is one script in dsh's client module format: `window.__ModuleLoader__.load({ id, factory: (require) => { … return module.exports } })`, with dsh's shared module table (React, React DOM, cordis and the other entries in `packages/client/web/src/platform.ts:8`) left as `require` calls and everything else bundled.
- **Installable package.** A build script produces a self-contained package directory (no `workspace:` dependencies) that `dsh plugin --profile <p> add <dir>` accepts. It declares `dsh.client`, `dsh.bundle` and `engines.dsh` matching the target (`dev/analysis/dsh-voice-plugin.md` § What dsh gives a browser plugin).
- Scripts: `build`, `test` (vitest), `lint` (the dashboard's eslint config, as `voice-engine/package.json` does), and `install-profile` (section 8).
- Build output (`plugins/dsh/voice/dist/`) is gitignored.

### Modules

The seams the tests import. Logic that needs no browser or dsh runtime lives in pure modules, so tests construct inputs directly.

| Module | Exports | What it is |
|---|---|---|
| `src/client/dsh-types.ts` | `DshSessionLike`, `DshEventWindow`, `DshEntry`, `DshInputActions`, `DshInputState` | Structural types for only the dsh fields the plugin reads, each citing its dsh source line, as `VoiceSession` is structural in the engine. No dsh package is imported. `DshSessionLike` is the session face (`prompt`, `cancel`) plus the binding's `eventSource`, flattened into one object. |
| `src/client/presence.ts` | `followShownSession({ shown, keepOnOutside, isLive, attach, voiceOff }) → dispose` | Section 4's session follow and leaving rules, driven by the shown-session observable (`{ sessionId, panelOpen }`, from `createShownSession`). `keepOnOutside()` reads the setting; `attach(sessionId)` re-attaches the system; `voiceOff()` turns voice off. |
| `src/client/services.ts` | `relayEndpoint(origin, serviceId)`, `createPluginServices({ origin, fetch }) → { ensureServiceReady, ensureTtsReady, ping }` | Section 4's services: the dashboard's readiness logic over the control-plane relay. `ensureServiceReady` resolves to `relayEndpoint(origin, id)`, `<origin>/dsh-voice/speech/<id>`, never the service's own endpoint. |
| `src/client/run-reader.ts` | `initialReaderState`, `readWindow(state, window) → { state, events: RunEvent[], snapshot }` | Pure. Folds an event-window notification into `RunEvent`s and the `VoiceConversation` snapshot (section 5, Reading). |
| `src/client/session-adapter.ts` | `createVoiceSession(session: DshSessionLike, deps: { haltAudio, clearDraft }) → VoiceSession & { dispose() }` | Wires `run-reader` to a live session and implements `controls` (section 5, Writing). |
| `src/client/draft-mirror.ts` | `createDraftMirror(deps) → { onAttach, onDraftChange, onTranscriptChange, onUnmute, onDshSend }` | The rules of section 6, against injected `inputActions`, draft reader, and the engine calls it uses. |
| `src/client/settings-model.ts` | `seedDraft(settings) → Draft`, edit functions (`setProvider`, `setModel`, `setVoice`, `setSpeed`, `setSttService`, `setControlPlaneUrl`, `setKeepVoiceOutside`, `setTakeover`, `setScope`, `editChunking`, `resetChunking`, `setTuning`) each `(draft, …) → Draft`, `roster(draft) → { providers, models, voices, sttOptions, declaresSessions }`, `chunkingView(draft) → { draft, fields, modelName, … }`, `buildWrite(settings, draft) → { ops, next }`, `TUNING_FIELDS` | Pure. The staged draft of section 8: seeded from `PluginSettings`, edited by the engine's `model-settings` and `agent/chunking-setting` helpers, and diffed against the settings it was seeded from into one list of path ops plus the resulting settings. `buildWrite` returns no ops for an unchanged draft and leaves `rest` byte-for-byte as stored unless an edit lands in it. |
| `src/client/settings-card.tsx`, `settings-controls.tsx`, `settings-style.ts`, `settings.css` | `SettingsCard({ form })` | The page of section 8: dsh primitives for tabs, switches, inputs, buttons, tags and tooltips; Radix Select, Slider and RadioGroup for the rest. Not tested: it holds no logic the model does not. |
| `src/host/relay.ts` | `resolveSpeechUpstream(settings, path) → URL \| null`, `isAllowedControlCall(settings, method, path) → boolean`, `upstreamHeaders(incoming) → headers` | Pure upstream selection, allowlist, and the headers forwarded upstream for HTTP and upgrade requests alike (section 7). |
| `src/host/settings.ts` | `PluginSettings`, `settingsFromVoiceConfig(cfg, controlPlaneUrl)`, `voiceConfigFromSettings(settings)` | Pure mapping between the control plane's voice config, the plugin's settings and the engine's `VoiceConfig` (sections 4, 8). `VoiceConfig` has no endpoint field: endpoints reach the engine through `ensureServiceReady` (`services.ts`). |

## 3. Controls

In dsh's composer tool row, slot `conversation.input.right`. Registered from the client half. Banter's desktop composer set, in Banter's order (`chat-composer.tsx:215-320`):

| Voice phase | Buttons |
|---|---|
| off | voice on |
| starting | a spinner; pressing it cancels the start |
| live | speech mute, mic mute, voice off; plus relink, in front, when the mutes are unlinked |
| ended with an error | voice on, in the error colour, with the reason in its tooltip; pressing it retries |

- **Mutes are Banter's** (`voice-engine/src/human/mute-store.ts`): mic mute while linked mutes both and reads "Mute everything"; muting speech alone unlinks; relink restores the link. Tooltips use Banter's wording.
- **State is colour, never text.** The mic button carries the human side: listening, hearing, muted (manual), muted while typing. The speech button carries one state of its own: agent audio playing. Nothing shows agent working or thinking.
- **Shortcut.** Mic mute is registered through `ctx.shortcuts.register` with no default key; bind it in dsh's keyboard shortcuts settings. It is not bare Space.
- **The click is the user gesture** that opens the mic and starts audio.

## 4. The voice system on dsh

The client half builds one `VoiceSystem` per page, as `dashboard/src/lib/voice/system/index.ts` does, with these collaborators:

- `devices`, `player`, `tones`, `loadModels`, `createHuman`, `createAgent`, `now`, `newSessionId`: as the dashboard.
- `services.ensureServiceReady`, `ensureTtsReady`, `ping`: the dashboard's logic (`dashboard/src/lib/voice/voice-service.ts`, `pingService`) with its control-plane calls sent through the host half's control-plane relay (section 7). They return the **relay** endpoint for a service, not the service's real endpoint.
- `services.loadTtsModel`, `loadSttModel`, `fetchSttModelFacts`: unchanged, called against the relay endpoint.
- `createTransport`: `createSttTransport` with the plugin's `ensureServiceReady`.
- `notify`: sets the error shown on the voice button (section 3). No toast.

**Voice config.** The client puts a `VoiceConfig` and `VoiceSelection` into the engine's voice session store, as the dashboard's chat page does after `fetchVoiceConfig()`. Both come from the plugin's settings (section 6), not from `/api/voice`.

**Session follow.** Voice belongs to the page. When the person opens another session while voice is live, the system re-attaches to that session's adapter (`attachSession`), as Banter's page does when the active session changes (`docs/reference/design/voice-system.md`).

**Leaving the conversation.** The setting "Keep voice on outside a conversation" (section 8, off by default) decides what happens when the person goes to a dsh view with no composer (the Plugins page, settings). Off: voice turns off and releases the mic, as the voice-off button does. On: voice keeps running, as Banter's does. A session switch is not leaving: a composer is shown again in the same navigation.

**Hidden tab.** Voice keeps running when the tab is hidden or the window loses focus. The plugin copies none of dsh's dictation handlers for `blur`, `visibilitychange` or Escape.

## 5. The session adapter

Satisfies `VoiceSession` (`voice-engine/src/session.ts`) over a dsh session, read through `ctx.sessions` (`binding`, `retain`; `dev/analysis/dsh-voice-plugin.md` § A session handle outside React). The plugin retains the session voice is attached to and releases it on detach.

**Reading.** From the session's event window (`SessionEventWindow`: `entries`, `revision`, `change`):

- A **run** is one dsh turn. `runId` is the turn's identity. A `turn/start` (or the first live chunk of a turn) makes `runActive` true; `turn/end` with any reason makes it false.
- **Text.** For the current run, `chat` `delta` events carry the run's assistant text so far, cumulative, as the engine expects (`voice-engine/src/agent/speech-chunker.ts:85-97`): the visible text (`text-delta` only) of the run's committed `assistant/message` entries, followed by the current attempt's live text. `reasoning-delta` and `tool-call-delta` never contribute.
- **Deduplication.** A live chunk's entry carries `data: { attemptId, turn, step, chunk }`; `chunk.index` is the content block's index, shared by every delta of a block, not the chunk's position. A chunk is applied once per (`attemptId`, its ordinal among that attempt's chunk entries in window order). A window `change` of `replace` reinstalls an attempt's chunks in the same order, so it resets the ordinal count for the active attempt and re-emits nothing already emitted.
- **Emitted text never shrinks.** The run's text is the text already emitted plus what follows it. An attempt abandoned after some of its text was emitted keeps that text, and the next attempt's text follows it; a committed `assistant/message` that repeats text already emitted from live chunks adds nothing.
- **History is not spoken.** Entries in the first window the adapter reads are history: they set the conversation's state (`runActive`, `runId`) but emit no text. The first run that starts after attach begins from empty text. So a reply already streaming when voice attaches, or when the shown session changes to one mid-reply, is not spoken; the next reply is. A plugin joins a UI that already shows the reply, so it does not read out text already on screen (Banter speaks it).
- **End of a run.** `turn/end` emits `chat` with state `final` and the run's full text for `completed`, `max-tokens` and `blocked`; `aborted` for `aborted`; `error` for `error`. `interrupted` and `forked` emit `aborted`.
- **Tools.** A tool call starting in the run emits `tool` with phase `start` (the chunker flushes on it), and its end emits `tool` with phase `result`.
- **Reasoning.** `reasoning-delta` emits `thinking` with the reasoning text so far; it never reaches `chat`.
- **Activity** is computed as the dashboard computes it (`computeActivity`, `dashboard/src/lib/run-state.ts`): `idle` with no run active, else `tool` while a tool is open, else `speaking` after a text delta, `thinking` after reasoning, otherwise `active`.
- **`runId` after a run ends** keeps the ended run's id, as the dashboard's `endRun` does. A null `runId` with no run active is the engine's reset signal (`speech-chunker.ts` `handleSnapshotChange`) and must occur only when the session is first attached.
- **`known`** is false until the window has first loaded, then true. A `replace` does not make it false: the chunker discards unspoken text when `known` drops, and deduplication already covers a resync.

**Writing.**

- `controls.send(text, { annotation })`: prompts the session with one text part in `queue` mode. With an annotation, the text is prefixed exactly as the dashboard prefixes it (`dashboard/src/lib/controls.ts:7-10,22`). The plugin empties dsh's text box before the prompt goes out, so a dsh Send pressed at that moment sends nothing. A result with `ok: false` rejects, and the words are handed back to the box.
- `controls.abort()`: calls `haltAudio()` first, then cancels the session's turn. Audio stops before the cancel resolves; this order is the promise.

## 6. The draft and dsh's text box

The engine's transcript store (`voice-engine/src/store/transcript-store.ts`) is the draft, as in Banter. dsh's text box shows it.

- **Mirror.** While voice is live and not muted-while-typing, the client writes the transcript view (settled text plus pending utterances) into dsh's text box with `inputActions.setDraft`, and records the draft revision (`useInput`) each of its own writes produced. It writes only when the box holds exactly its own last write or is empty; `setDraft` removes dsh's reference chips, so the plugin never writes over text it did not put there.
- **Adopt, never overwrite.** When voice attaches to a session (voice on, or a session switch) and that session's box is not empty, voice starts muted-while-typing: the box's text is the person's draft. Unmuting adopts it (below). The engine's transcript becomes the attached session's box text; a previous session's box keeps its own draft, as dsh keeps drafts per session.
- **A change the plugin did not make** (a draft revision it did not produce) is the person editing. The client then: sets the engine's auto-mute (`setMicAutoMuted(true)`), reports composer focus to the turn manager as the dashboard's field does on focus (`reportComposerFocus(true)`), stops writing to the box, and copies the box's text into the transcript (`editTranscript`) on each further change.
- **Ending that mute.**
  - The person sends through dsh's own Send: the client empties the engine's transcript (`takeTranscript`), marks the words of each still-pending utterance that the box was showing as already sent, reports a composer send (`reportComposerSend`, which closes any open human turn as sent with nothing left to deliver), clears the auto-mute and reports focus false. The words are sent once, by dsh. A dsh send is recognised by the input state's `phase` becoming `'sending'`; the revision that then empties the box is the send's own clearing, not an edit, and does not set the mute again.
  - **Pending words at a dsh send.** The box shows the settled text and the pending (still-transcribing) utterances' words, so dsh's Send sends those too. For each pending utterance the client counts its words as the box shows them (after the word reveal, counted from the utterance's first word) and records that count with the engine (`markWordsSent`). While the utterance is pending, those leading words no longer show, and when it settles they are removed from its final; only words said after the Send remain, in the box and in what the engine later sends. An utterance with nothing left sends nothing. Words are counted, not matched, because the final revises words and punctuation. Text the person typed is not a mirror of the transcript, so nothing is marked then. The marks count the words as shown, filler words included, because partials are raw; the final is cleaned of filler words, so each mark also carries the word count of the marked words once cleaned, and that is what is cut from the final (a number the final reformats can still leave the cut a word off). If dsh refuses the send, the marks stay, the box's whole text becomes the transcript, and anything that settled during the send is added after it, in the box and the transcript.
  - **Typing over pending words.** When the person's first keystroke follows a box that held the plugin's own text, the pending words that box showed are marked as sent in the same way: the typed text now holds them, so they must not come again when the utterance settles.
  - **A failed voice send** puts the words ahead of what was said since: in the transcript when the box is not typing (and in the transcript alone when no box is mounted), and at the front of the box's text, in the box and the transcript, while the person types.
  - The person unmutes the mic: the client copies the box's current text into the transcript (`editTranscript`), clears the auto-mute, reports focus false and resumes mirroring. Reporting focus false does not close a held turn (`turn-manager.ts` `reduceComposerReport`: a hold clears only when a new utterance is heard), so nothing is sent at the unmute. Speech then continues from that text, and the engine's own send at the close of the turn sends all of it.
- **A closed human turn** is sent by the engine through `controls.send` (section 5), never through dsh's `submit()`.

## 7. Host half

- **Assets.** Serves, at the paths the client build references: `/models/silero_vad_legacy.onnx`, `/models/smart-turn-v3.2-cpu.onnx`, `/models/whisper-tiny/preprocessor_config.json`, `/tones/voice/*.mp3`, and the ONNX Runtime module, wasm and mic worklet the Vite build emits. Sources are the files the dashboard serves from `dashboard/public/`, copied into the built package. Correct content types (`application/wasm` for wasm).
- **Speech relay.** Under a plugin-owned path prefix, relays HTTP requests and WebSocket upgrades to the configured STT and TTS endpoints only. The upstream is chosen by service id from the plugin's settings; a request naming anything else is refused. No `Origin` header is forwarded upstream. Bodies stream in both directions as they arrive and are never buffered whole: TTS audio is played as it streams, and a buffering relay passes every check while adding the whole synthesis time to each reply.
- **Control-plane relay.** Relays exactly the calls the dashboard's voice code makes: `GET /api/services/:id`, `POST /api/services/:id/start`, `POST /api/services/:id/ping`, for the configured STT and TTS service ids only, to the configured control-plane URL.
- **Gating.** Every plugin route, the upgrade included, refuses any request that dsh's `connection.requestRejection(req)` rejects (precedent: `packages/experimental/inspector/src/host/plugin.ts:93-110`).
- **Voice guidance.** Registers a `ctx.systemPrompt.section` whose text is Banter's voice guidance (`plugins/openclaw/voice-mode/voice-guidance.md`) for sessions with voice live, and empty otherwise. The client tells the host which sessions have voice live.

## 8. Settings and install

- **Settings** (the plugin's page in dsh's plugin manager, the `plugins.bundle.config` slot; not a dialog). Banter's settings dialog, as tabs, with its labels, descriptions, ranges and cascade rules:
  - **Explanations.** They sit inline on the control they explain: what it does and, for a tuning value, which way to move it. One or two short sentences each, in the `dv-help` style. No section intros, troubleshooting paragraphs or general help blocks.
  - Tabs in the order *Speech*, *Listening*, *General*; Speech is selected when the page opens.
  - *General*, one unheaded group: **Banter server URL** (the control plane's address, which is also where the dashboard opens; a help line under it says so, that the install script prints it, that the provider, model and voice lists were copied from this server when the plugin was installed and the install step picks up changes, and links `docs/guide/install.md`; a setting Banter has no counterpart for); "Always take over", shown only when the selected STT option or TTS provider declares `sessions` (speech servers serve one session at a time; the setting takes a server over without asking when another session is using it, otherwise the person is asked); **Keep voice on outside a conversation** (off by default; section 4, also without a Banter counterpart). Help is its own tab, last (below).
  - *Speech*: Voice (TTS provider, then model among the realtime models, then voice, in one row; speed 0.5 to 2.0 in steps of 0.1, shown as `1.0x`; one help line saying only models that can stream speech in real time are listed, with links to the speech-models and voices-and-models docs); Chunking: scope (global or per model; a "How scope works" link to `docs/reference/configuration.md#settings-scope`), mode with a short description each and "asks for this" on the model's own mode, min and max words with descriptions that match `agent/text-chunker.ts`, provenance of each value as a badge whose tooltip says where the value comes from, "Reset to model defaults"; in per-model scope the section's aside reads "Changes here apply only to <model>"; last, an unheaded **Playback method** (auto, MMS, MSE or Blob, saved to the browser's storage as soon as it changes, through the engine's `saveStreamingBackend`; its help line says what it is, that Auto is right unless speech stutters or cuts out, that the choice is saved in this browser apart from Save and takes effect on reload, and which method is active now).
  - *Listening*: an unheaded **Transcription provider** (the STT provider, shown when `stt.options` lists at least one, with a help line linking `docs/guide/stt.md` and the transcription-models doc); Speech detection and Turn taking, the seven sliders with Banter's ranges and units and a description each that says which way to move it, and a "What these do" link in each section's heading row to `docs/reference/components/voice-interface.md#what-the-settings-mean`. A field the stored config does not set shows an enabled slider at the engine's own default, with the value label "default (<value><unit>)"; dragging it sets the field. A set field has a "Reset" button that clears it back to unset, and Save writes that removal into `rest`. The defaults are the ones `human/mic-loop.ts` applies when the config leaves a field out (`minSpeechDurationS` 0.75, `minSpeechProb` 0.7, `pauseThresholdMs` 250, `commitMinDelayMs` 250, `commitMaxDelayMs` 2000, `smartTurnThreshold` 0.7, `smartTurnLowCutoff` 0.15). A heading that would name a single control is left out.
  - *Help*, the fourth tab: links under small headings, each opening in a new tab (`target="_blank" rel="noreferrer"`), to files in the repository at `https://github.com/arvindvenkataramani/banter/blob/main/<path>`: General (plugin docs `docs/guide/plugins/dsh-voice/README.md`, install Banter `docs/guide/install.md`, speech servers `docs/guide/speech-servers.md`, configuration reference `docs/reference/configuration.md`); Speech (TTS) (TTS setup `docs/guide/tts.md`, speech models `docs/guide/models.md#text-to-speech-models`, voices and models `docs/guide/voices-and-models.md`); Transcription (STT) (STT setup `docs/guide/stt.md`, transcription models `docs/guide/models.md#speech-to-text-models`); Project (the repository). Links take dsh's `--dsw-*` accent colour.
  - **Spacing.** Within an item the label, control and description sit close; items sit further apart than that, and sections further apart again, so each item reads as a group. The same on every tab.
  - Changing the TTS provider selects its first realtime model and that model's first voice; changing the model selects its first voice. The STT model is not shown and is left as stored. There is no input-device setting: the engine uses the browser's default microphone, as Banter does.
- **Staging and saving.** Every edit is staged in a draft seeded from the stored settings; one Save writes it, one Cancel drops it. The write is a single `mutate(ops, expectedRevision)` on dsh's config form for the plugin's entry, fenced by the revision the draft was seeded at, so a page that went stale is refused rather than overwriting. A refused or failed write keeps the draft. Nothing reaches the voice system until it is saved.
- **Storage.** The selection, STT service, control-plane URL and keep-voice-outside setting are the entry's typed fields. Everything else Banter's dialog edits lives in `rest`, the JSON of the control plane's `VoiceConfig` remainder (rosters `tts.providers` and `stt.options`, `tts.options`, `tts.modelPrefs`, `tts.settingsScope`, `takeover`, `stt.vad`, `stt.turnTaking`), merged as the control plane merges a `PATCH /api/voice/selection`: global chunk options replace by key, a model's preference entry replaces whole and an empty one is removed, `vad` and `turnTaking` merge by key. The dropdowns read their rosters from `rest`.
- **No Save mic samples setting, no Debug tab.** The engine posts mic samples to Banter's own server route, which dsh's origin does not serve. `voiceConfigFromSettings` drops `rest.debug`, so the engine never sees the setting whatever `rest` holds; the stored `rest` is left as it is and the page never edits it.
- **Activation prompt** (`plugins.bundle.activation`): asks for microphone permission and checks the configured services through the relay.
- **`install-profile <profile> <control-plane-url>`**: builds the package, installs it into the named profile with `dsh plugin --profile <profile> add`, reads `GET <control-plane-url>/api/voice` once, and writes the plugin's settings from it into the profile. It writes nothing anywhere else.

## 9. Proving the plumbing (spike)

Run first, in a throwaway dsh profile (`DSH_HOME` under `/var/tmp`), launched with `--no-open`. No sign-in, no prompt, no model call. Each check either passes, takes its named degradation (logged), or stops the run with a tier-2 brief.

| Check | Passes when | If not |
|---|---|---|
| Package loads | The built package installs; dsh starts with it; the voice-on button appears in `conversation.input.right` | Stop |
| Assets | Every asset route answers with the right type; Silero VAD and smart-turn load in dsh's page | Stop |
| Gating | A request without dsh's browser cookie is refused on an asset route, a relay route and the upgrade | Stop |
| STT relay | Through the relay: fluid STT's health and model list answer; a WebSocket upgrade to the STT endpoint opens | Upgrade fails: batch STT only (the engine supports it), logged |
| Draft | A plugin write to the box is visible in `useInput`; typing into the box produces a revision the plugin did not record | Stop |
| Send recognised | A send through dsh's Send can be told apart from the person clearing the box (for example a user message appearing in the window that the plugin did not prompt, or the input state's submission) | The box going from non-empty to empty while muted-while-typing counts as a send, logged |
| Session follow | With two sessions created (creating one makes no model call), one page-level object is reachable from each session's slot after switching, and the plugin learns the shown session's id; voice is never started | Voice turns off on a session switch, logged |
| Leaving the conversation | The plugin can tell a dsh view with no composer (the Plugins page) apart from a session switch, without starting voice | The setting is left out and voice keeps running outside a conversation, logged |
| Settings | The plugin's settings page shows the tabs and fields, and one Save persists across a dsh restart | Stop |

The spike calls no start, no load and no TTS endpoint. Behaviour that needs a live turn (live-chunk mapping against a real stream, cancel, prompt mid-turn, a switch during a turn) is covered by unit tests over recorded or constructed event windows and is checked by the person at the first stop.

## 10. Tests

Under `plugins/dsh/voice/`, vitest, following `TESTING.md`: promises, not wiring; no UI tests. The suite covers:

- **Adapter reading:** cumulative text across steps; visible text only; dedup by attempt and index; `replace` re-emits nothing and leaves `known` true; abandoned attempt keeps emitted text; each `turn/end` reason maps as section 5 states; an ended run keeps its `runId`; tool start and result; activity as the dashboard computes it.
- **Adapter writing:** `queue` mode; annotation prefixes exactly the dashboard's; box emptied before the prompt goes out; failed prompt rejects and hands the words back; `haltAudio` precedes the cancel.
- **Draft rules:** own writes never trigger the mute; one foreign revision does; while muted the plugin writes nothing; attaching to a session with text in its box starts muted and does not write; a dsh send empties the transcript, reports a composer send and ends the mute, and the box-clearing that follows it does not mute again; a dsh send while an utterance is pending makes the engine later send only the words said after the send, nothing twice, and nothing for an utterance fully sent; a final with a different word count than its partial (filler stripped) loses no word after a dsh send; the same on the word-reveal path; typing over a shown pending utterance keeps its words from coming again; a refused dsh send keeps the marks, adopts the whole draft and keeps words that settled during the send; a failed voice send puts the words back while typing, and with no box; the input phase's `sending` start and its end with text left are recognised as a send and a refusal (`box-phase.ts`); the box is brought up to date when the engine takes the transcript for a voice send; a manual unmute adopts the box text and sends nothing; the engine's turn send after an unmute carries the adopted text.
- **Session follow:** a live system re-attaches to the shown session's adapter.
- **Leaving the conversation:** with the setting off, a view with no composer turns voice off; with it on, voice keeps running; a session switch never turns it off.
- **Relay:** only configured service ids reach an upstream; an unknown id is refused; no `Origin` forwarded; control-plane relay allows only the three calls.
- **Relay headers:** `upstreamHeaders` never carries `Origin`, for HTTP and upgrade requests.
- **Mic samples:** `voiceConfigFromSettings` never turns mic-sample saving on, whatever `rest.debug` holds.
- **Install seeding:** a `/api/voice` response maps to the plugin's settings and stored remainder.
- **Settings draft** (`settings-model.ts`): seeding from `PluginSettings`; a provider change selects the first realtime model and its first voice, a model change its first voice; a chunking edit goes into `rest` through the engine's helpers and the result round-trips through `voiceConfigFromSettings`; per-model edits write only the touched model's preference and an emptied one is removed; scope, takeover and the tuning fields land in their own `rest` paths and leave their siblings; an unchanged draft writes nothing and leaves `rest` as stored, a stored `debug` section included; the STT model survives an STT provider change; control-plane URL and keep-voice-outside write their own typed fields and not `rest`; the speed, voice and provider edits write only their own fields.
- **Services:** `ensureServiceReady` resolves to the relay endpoint, never the service's own.

Stays green throughout: `voice-engine/src/boundary.test.ts` and the dashboard suite (`cd dashboard && bunx tsc -b && bunx vitest run`).

## 11. Not tested, binding anyway

Slot placement and button order (section 3); colours and tooltips; that the plugin draws nothing dsh already shows and changes nothing in how dsh renders or scrolls the conversation; nothing at approvals; no text state label; no strip above the composer; no hostnames in the repo; comments describe how the code works, not how it came to be.

## 12. For the person to check in use

The relay and its gating; the install into the `web` profile; turn-taking, latency and audio quality; the settings page's look beside dsh's own pages (select menus layered above the page, sliders, spacing, light and dark), and that one Save persists across a dsh restart.
