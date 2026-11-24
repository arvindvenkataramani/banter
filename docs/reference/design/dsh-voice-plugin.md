# Voice mode as a dsh plugin

Banter's voice mode, running inside DeepSeek Harness's (dsh) own web UI as a dsh plugin. dsh keeps the conversation, its rendering, its composer and its run controls. The plugin adds the voice loop and the few controls that only voice needs.

Companions: [`dev/analysis/dsh-voice-plugin.md`](../../../dev/analysis/dsh-voice-plugin.md) (feasibility, the dsh surfaces), [`voice-engine-package.md`](voice-engine-package.md) (the engine the plugin hosts), [`docs/reference/protocols/dsh/dsh-web-protocol.md`](../protocols/dsh/dsh-web-protocol.md) (dsh's wire). The spec is [`dev/specs/dsh-voice-plugin.md`](../../../dev/specs/dsh-voice-plugin.md).

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
- *Session adapter.* Satisfies `VoiceSession`. `conversation` is derived from dsh's session event window: streamed text from `assistant/live-chunk` entries, deduplicated by attempt and chunk index, with a window `replace` treated as a reset of position within the attempt; end of text from the durable `assistant/message`; run boundaries from `turn/end`; activity computed as the dashboard computes it. An ended run keeps its id and the conversation stays known through a resync, because the engine reads either change as a reset and drops unspoken text. `controls.send` prompts the session in `queue` mode with the annotation written as Banter's dashboard writes it, after clearing dsh's text box, so a dsh Send pressed at that moment sends nothing; a refused prompt hands the words back to the box. A reply already streaming when voice attaches is history and is not spoken; the next one is. `controls.abort` halts audio, then cancels the session's turn.
- *Transcript in dsh's text box.* The engine's transcript store is the draft, as in Banter. The client writes its view into dsh's text box through `inputActions` and records the draft revision each write produced. A draft change it did not make is the person editing: the mic mutes ("muted while typing"), and the engine's transcript is updated from the box. The mute holds until the text is sent through dsh's Send or the person unmutes; a manual unmute adopts the box's contents as the transcript. A send through dsh's Send empties the engine's transcript, and marks the words of each still-pending utterance that the box was showing as already sent (the engine's `markWordsSent`), so nothing is sent twice: the marked leading words stop showing and are cut from the utterance's final when it settles, leaving only words said after the Send. The count is of words the box showed, after the word reveal, because the final revises words and punctuation and matching text would miss them. Partials are raw and the final is cleaned of filler words, so a mark also holds the count of the same words once cleaned, and the final is cut by that. When the person types over a box that showed pending words, those words are marked the same way. A refused Send keeps the marks and adopts the box's whole text, with anything that settled during the Send added after it. A failed voice send puts its words ahead of what was said since: in the box while the person types, in the transcript otherwise. The plugin never writes over text it did not put in the box: attaching to a session whose box already holds text starts in the typing mute.
- *Following the shown session.* As in Banter, voice belongs to the page, not to one session: when the person opens another session, the system re-attaches to it. Leaving for a dsh view with no composer turns voice off, unless the setting "Keep voice on outside a conversation" is on; with it on, voice keeps running as Banter's does.

**Relationships.** Reads dsh's session through `ctx.sessions`; writes the draft through `inputActions`; fetches assets and speech traffic from the host half on dsh's own origin.

### Host half

**Role.** The plugin's server code, running in the dsh process.

**Ownership.** The asset routes, the voice config routes, the speech relay, the control-plane relay, the plugin's settings, and the voice-guidance prompt section.

**Key logic.**

- *Assets.* Serves the engine's browser models, tones, ONNX Runtime module and wasm, and mic worklet at the paths the client build bakes in.
- *Voice config.* Fetches the control plane's voice config for the page and records the selected STT and TTS service ids from its own fetch; a second route answers the settings page's connection check and records nothing ([`voice-settings.md`](voice-settings.md)).
- *Speech relay.* The speech servers refuse a page served from localhost, so the browser never calls them. The host relays HTTP and WebSocket traffic to the selected STT and TTS endpoints, and nowhere else.
- *Control-plane relay.* Readiness, start and keep-alive go to the configured control plane exactly as the dashboard's `ensureServiceReady` and `pingService` do, so a demand-loaded TTS service starts when voice starts.
- *Gating.* Every plugin route, the WebSocket upgrade included, refuses a request dsh's own connection check refuses. Routes outside dsh's `/api` carry no authentication otherwise.
- *Voice guidance.* Adds Banter's voice guidance to the system prompt for sessions with voice on, through `ctx.systemPrompt.section`.

**Relationships.** Called only by the client half; calls only the configured control plane and speech endpoints.

### Settings

The voice settings (selection, transcription service, chunking, scope, take-over, tuning) are the Banter server's, edited in Banter's settings dialog and read live by the plugin; [`voice-settings.md`](voice-settings.md) is the design. The plugin's own page in dsh's plugin manager (the bundle config slot) holds what belongs to dsh or to the browser: the Banter server URL, a service status section, a read-only summary of the voice settings in use with Reload and a link into Banter's dialog, keep-voice-outside, the playback method, a pointer to the mute shortcut, and help links. Every setting on it saves itself. There is no input-device setting, as in Banter.

**Storage.** The entry holds two fields: the control-plane URL and the keep-voice-outside flag. The install step writes the URL.

**Controls.** dsh's own primitives (`Switch`, `Input`, `Button`, `Tag`, `Tooltip`) where they exist; Radix Select for the playback method, bundled into the plugin and sharing dsh's React through the module table. A stylesheet scoped under one plugin class styles the Radix parts from dsh's `--dsw-*` tokens, which dsh declares on `body`, so the Select menu, portalled to `body`, inherits them and carries the plugin class itself. The client bundle injects the stylesheet as one `<style>` element the first time the page renders.

### Package

A workspace in this repo at `plugins/dsh/voice/`, beside `plugins/openclaw/voice-mode/`. It imports the engine from source. The client is built with Vite so the engine's `?url` and `import.meta.url` asset references resolve, then wrapped in dsh's client module format. What dsh installs is a built package with no workspace dependencies. Deploy scripts drop the workspace, as they drop the dashboard and the engine.

## Decisions where the obvious approach is wrong

- **Not dsh's `submit()`.** The engine sends a closed human turn itself, with an annotation. `submit()` takes neither text nor annotation and follows dsh's own busy-send rules, so the adapter prompts the session directly and clears the box.
- **`queue`, not `steer`.** Banter supersedes a running turn: abort, then send. `steer` would fold the new words into the turn being cancelled.
- **No engine asset seam.** The engine fetches models and tones by root path and imports ORT and the worklet through Vite. Building the client with Vite and serving those paths from the host keeps the contract unchanged; an asset-base option in the engine would move it.
- **No strip above the composer.** State is colour on two buttons; a separate row of text would compete with the code on screen.

## Differences from Banter's behaviour

| Behaviour | Banter | Plugin | Reason |
|---|---|---|---|
| Auto-mute trigger | Focusing the text field | A draft change the plugin did not make | Chosen in design review: the slot contract gives a plugin the draft and its revision (`slots.ts:395-402`), and a change the plugin did not make is what it can observe without reaching into dsh's editor |
| Auto-mute end | Blur | Send through dsh, or manual unmute | Follows the trigger (impossible) |
| Mute shortcut | Space | No default; bindable in dsh's shortcuts settings | A default key risks conflicts with system and keyboard-layout shortcuts, and dsh already provides the binding UI |
| Save mic samples | A General tab switch posts samples to the control plane's server | Ignored: the plugin removes it from the config it reads | It posts to Banter's own server route, which dsh's origin does not serve |
| Settings change while voice is on | Applied at Save | Applied on the next refetch: focus, visibility, voice start or Reload | The server sends no change event the plugin can receive (impossible) |
| Reply already streaming at attach | Spoken | Not spoken; the next reply is | A plugin joins a UI that already shows the reply, so it does not read out text already on screen |
| Error notice | Toast | Error colour on the voice button, reason in its tooltip | No plugin toast found in dsh's slot contracts (impossible, unconfirmed) |
| Agent activity | Shown by voice UI | Not shown | dsh shows it |
| Glow overlay, screen wake, forced theme, "type instead", scroll-to-bottom, media gate | Present | Absent | Page-wide chrome outside any plugin slot, or dsh's own |

## Out of scope

Any change to how dsh renders or scrolls the conversation; approvals and user questions by voice, including any tone; dsh's zero-setup speech tier; cross-origin isolation of dsh's page (inference runs single-threaded).
