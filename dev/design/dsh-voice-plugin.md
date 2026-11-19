# Voice mode as a dsh plugin

Banter's voice mode, running inside DeepSeek Harness's (dsh) own web UI as a dsh plugin. dsh keeps the conversation, its rendering, its composer and its run controls. The plugin adds the voice loop and the few controls that only voice needs.

Companions: [`dev/analysis/dsh-voice-plugin.md`](../analysis/dsh-voice-plugin.md) (feasibility, the dsh surfaces), [`voice-engine-package.md`](voice-engine-package.md) (the engine the plugin hosts), [`docs/gateway/dsh/dsh-web-protocol.md`](../../docs/gateway/dsh/dsh-web-protocol.md) (dsh's wire). The spec is [`dev/specs/dsh-voice-plugin.md`](../specs/dsh-voice-plugin.md).

## Principles

- **Behaviour follows Banter; look follows dsh.** States, transitions, mute rules, what happens while the agent works, on a hidden tab, while editing and on a session switch are Banter's. Layout, components and styling are dsh's. A behaviour differs from Banter only where Banter's pattern would be fragile or need hacks in dsh, or is impossible there; each such difference is listed below with its reason.
- **Show only what dsh cannot.** dsh already shows the agent working, its Stop control, the model, approvals and the conversation. The plugin shows the microphone, the agent's spoken audio, the mutes, starting and errors, and nothing else.
- **One engine, two hosts.** The plugin is a second host for `@platform/voice-engine`, beside the dashboard. It supplies the same seams the dashboard does and changes none of the engine's contract.
- **No patches to dsh, and no changes to the speech servers or their registry.**

## Components

### Client half

**Role.** The plugin's browser code: the voice controls in dsh's composer, the voice system, and the adapter that lets the engine read a dsh session.

**Ownership.** The page's one `VoiceSystem`, its player, tone queue and browser models; the dsh-session adapter; the mirror between the engine's transcript and dsh's text box.

**Key logic.**

- *Controls.* Banter's composer button set sits in dsh's composer tool row (`conversation.input.right`): voice on; a spinner while starting, which cancels on press; while on, speech mute, mic mute, a relink button when the mutes are unlinked, and voice off. State is carried by colour on the mic and speech buttons, never by text. An error turns the voice button to the error colour with the reason in its tooltip, and pressing it retries.
- *Session adapter.* Satisfies `VoiceSession`. `conversation` is derived from dsh's session event window: streamed text from `assistant/live-chunk` entries, deduplicated by attempt and chunk index, with a window `replace` treated as a reset of position within the attempt; end of text from the durable `assistant/message`; run boundaries from `turn/end`; activity computed as the dashboard computes it. An ended run keeps its id and the conversation stays known through a resync, because the engine reads either change as a reset and drops unspoken text. `controls.send` prompts the session in `queue` mode with the annotation written as Banter's dashboard writes it, then clears dsh's text box. `controls.abort` halts audio, then cancels the session's turn.
- *Transcript in dsh's text box.* The engine's transcript store is the draft, as in Banter. The client writes its view into dsh's text box through `inputActions` and records the draft revision each write produced. A draft change it did not make is the person editing: the mic mutes ("muted while typing"), and the engine's transcript is updated from the box. The mute holds until the text is sent through dsh's Send or the person unmutes; a manual unmute adopts the box's contents as the transcript. A send through dsh's Send empties the engine's transcript so nothing is sent twice. The plugin never writes over text it did not put in the box: attaching to a session whose box already holds text starts in the typing mute.
- *Following the shown session.* As in Banter, voice belongs to the page, not to one session: when the person opens another session, the system re-attaches to it. Leaving for a dsh view with no composer turns voice off, unless the setting "Keep voice on outside a conversation" is on; with it on, voice keeps running as Banter's does.

**Relationships.** Reads dsh's session through `ctx.sessions`; writes the draft through `inputActions`; fetches assets and speech traffic from the host half on dsh's own origin.

### Host half

**Role.** The plugin's server code, running in the dsh process.

**Ownership.** The asset routes, the speech relay, the control-plane relay, the plugin's settings, and the voice-guidance prompt section.

**Key logic.**

- *Assets.* Serves the engine's browser models, tones, ONNX Runtime module and wasm, and mic worklet at the paths the client build bakes in.
- *Speech relay.* The speech servers refuse a page served from localhost, so the browser never calls them. The host relays HTTP and WebSocket traffic to the configured STT and TTS endpoints, and nowhere else.
- *Control-plane relay.* Readiness, start and keep-alive go to the configured control plane exactly as the dashboard's `ensureServiceReady` and `pingService` do, so a demand-loaded TTS service starts when voice starts.
- *Gating.* Every plugin route, the WebSocket upgrade included, refuses a request dsh's own connection check refuses. Routes outside dsh's `/api` carry no authentication otherwise.
- *Voice guidance.* Adds Banter's voice guidance to the system prompt for sessions with voice on, through `ctx.systemPrompt.section`.

**Relationships.** Called only by the client half; calls only the configured control plane and speech endpoints.

### Settings

The plugin's settings live in dsh's bundle config card: control-plane URL, STT service and model, TTS service, model, voice and speed, and input device. The install step seeds them by reading the control plane's voice config once; after that the plugin reads its own settings. The engine receives them in its `VoiceConfig` shape, with endpoints pointing at the relay.

### Package

A workspace in this repo at `plugins/dsh-voice/`, beside `plugins/voice-mode/`. It imports the engine from source. The client is built with Vite so the engine's `?url` and `import.meta.url` asset references resolve, then wrapped in dsh's client module format. What dsh installs is a built package with no workspace dependencies. Deploy scripts drop the workspace, as they drop the dashboard and the engine.

## Decisions where the obvious approach is wrong

- **Not dsh's `submit()`.** The engine sends a closed human turn itself, with an annotation. `submit()` takes neither text nor annotation and follows dsh's own busy-send rules, so the adapter prompts the session directly and clears the box.
- **`queue`, not `steer`.** Banter supersedes a running turn: abort, then send. `steer` would fold the new words into the turn being cancelled.
- **No engine asset seam.** The engine fetches models and tones by root path and imports ORT and the worklet through Vite. Building the client with Vite and serving those paths from the host keeps the contract unchanged; an asset-base option in the engine would move it.
- **No strip above the composer.** State is colour on two buttons; a separate row of text would compete with the code on screen.

## Differences from Banter's behaviour

| Behaviour | Banter | Plugin | Reason |
|---|---|---|---|
| Auto-mute trigger | Focusing the text field | A draft change the plugin did not make | Chosen in design review: the slot contract gives a plugin the draft and its revision (`slots.ts:385-392`), and a change the plugin did not make is what it can observe without reaching into dsh's editor |
| Auto-mute end | Blur | Send through dsh, or manual unmute | Follows the trigger (impossible) |
| Mute shortcut | Space | A registered dsh shortcut | Space types in dsh's editor (fragile) |
| Settings saving | One staged Save | Each field saves | dsh's bundle card has no Save (impossible) |
| Error notice | Toast | Error colour on the voice button, reason in its tooltip | No plugin toast found in dsh's slot contracts (impossible, unconfirmed) |
| Agent activity | Shown by voice UI | Not shown | dsh shows it |
| Glow overlay, screen wake, forced theme, "type instead", scroll-to-bottom, media gate | Present | Absent | Page-wide chrome outside any plugin slot, or dsh's own |

## Out of scope

Any change to how dsh renders or scrolls the conversation; approvals and user questions by voice, including any tone; dsh's zero-setup speech tier; cross-origin isolation of dsh's page (inference runs single-threaded).
