# Component: Chat

*The Banter conversation surface, and the gateway/session layer it's built on.*

---

## Scope

This doc covers how the dashboard's Chat feature is built — state ownership,
component wiring, session lifecycle. It does **not** re-explain the gateway
wire protocol; that's covered in depth, and kept current, by:

- `../gateway/openclaw/gateway-session-lifecycle.md` — connect handshake, `chat.send`
  / `chat.history` / `sessions.reset` / `sessions.patch`, event ordering.
- `../gateway/openclaw/gateway-tool-and-message-events.md` — the `session.message`
  event family, tool-call dedup, `chat` vs `session.message` vs `agent`
  streams.
- `../gateway/openclaw/openclaw-gateway-protocol.md` — full RPC catalog, the
  `content` string-or-blocks union, `caps`, `__openclaw.id` anchoring,
  reconnect-as-new-projection.

The voice pipeline (mic loop, playback engine, turn manager, and the
`voiceSystem` that runs a voice session) is described in
`voice-turn-taking.md`. This doc only covers how Chat *wires into* that
pipeline, not its internals.

---

## Layer stack

```
GatewayConnection        raw WebSocket, RPC + event dispatch
        │
GatewayProvider           React context — ONE instance for the whole app,
  / useGateway()           mounted in App.tsx above the route switch
        │
SessionManager            agent/session/model catalog, active session
        │
Session                   one per sessionKey — transcript + streaming state
        │
useSessionManager()        bridges both classes into React via
                            useSyncExternalStore
        │
   ChatPage
```

`dashboard/src/lib/gateway-connection.ts`, `gateway-context.tsx`,
`session-manager.ts`, `session.ts`, `use-session-manager.ts`.

There is exactly one `GatewayConnection` for the whole dashboard — Services
and Chat share it via `GatewayProvider`. `SessionManager` is
per-connection; `Session` is per-sessionKey, cached in a `SessionStore` map
so switching back to a previously-visited session reuses its in-memory
transcript rather than rebuilding it.

### Connection

`GatewayConnection` owns the socket, the connect handshake (device-signed via
a local Ed25519 keypair — see `device-identity.ts`), and reconnect
(exponential backoff, capped, gives up after 8 attempts; a public
`reconnect()` resets and retries immediately — what `DisconnectBanner`'s
Retry button calls). `onReconnected` fires only on a *second or later*
connect, distinguishing first-load from recovery, since only recovery needs
history re-fetched.

Event dispatch is a three-way split by event type, each routed to
per-sessionKey listeners: `chat` (streaming deltas), `session.message`
(tool calls / transcript updates), `agent` with `stream: 'compaction'`. Only
`agent.compaction` is subscribed to — raw `agent.assistant`/`agent.item`
streams are not consumed.

### Session catalog — `SessionManager`

Not a React hook — a plain class with `subscribe`/`getSnapshot`, read via
`useSyncExternalStore`. `initialize()` runs once the connection is up:
fetches agents and models in parallel, then switches to the resolved
initial agent.

`switchTo(agentId, sessionName?)` is the core routine: resolve the
sessionKey (`agent:<agentId>:<name>`), get-or-create the `Session`,
re-register the three per-sessionKey listeners, subscribe to
`sessions.messages`, update catalog state, persist the agent choice
server-side if it changed, and kick off `session.loadHistory()`
(unawaited — history streams in after the switch is visually complete).

The session list shown in the UI is filtered: only the agent's default
session or names prefixed `dashboard:` are shown, so cron/channel-backed
sessions stay out of the picker. Titles come from the gateway's
`derivedTitle`, stripped of injected envelope markers.

`patchModel()` can't call `sessions.patch` directly (webchat clients can't),
so it sends a `/model <id>` chat command and verifies the gateway resolved
to the requested model afterward.

### Per-session state — `Session`

One instance per sessionKey. Owns `_messages`, `_isStreaming`, `_isTyping`,
`_errorMessage`, `_compactionPhase`.

**Send → receive mapping**, since the two are not directly correlated:

1. `send(text)` appends an optimistic message under a *client-generated*
   id (`msg-N`) immediately, before any network round trip.
2. `chat.send` fires with a fresh idempotency key. Its RPC response is just
   an ack — it never touches `_messages`.
3. The assistant's reply streams in later as `chat` events keyed by the
   gateway's `runId`. The first `delta` creates a new message under that
   id; later frames update it in place.
4. The outgoing optimistic id and the incoming `runId` are unrelated id
   spaces — one is client-generated, one is the gateway's.
5. A `final` event with no matching message, while idle, triggers a full
   `loadHistory()` — the fallback for "a run from another device/tab just
   completed."

History rows are anchored on `__openclaw.id` (falling back to `seq`, then
positional index) so identity survives pagination and reload, matching the
protocol doc's guidance. Tool activity reaches the transcript through the structured streams rather than through transcript scraping: `agent` events with `stream: "tool"` and their `session.tool` mirror are normalized by `run-state.ts` into `RunEvent`s carrying `phase` and `toolCallId`, and `lib/voice/agent/speech-chunker.ts` calls `recommendFlush()` on `phase === "start"` so speech flushes at the tool boundary. Historical tool cards are a separate path: `conversation.ts` parses `toolCall` / `tool_use` blocks out of `chat.history` when reloading a session.

### Run signalling — what opens a run, and what must not end one

A run's first events arrive *before* `lifecycle:start`, so several event kinds have to be able to open one: `lifecycle:start` itself, a `chat` delta or `status`, an `agent` `run_status`, and a non-empty `thinking` event. A run that cannot open drops the activity it exists to signal.

Two rules earn their place because breaking them is silent and looks like something else:

- **`chat` `state: "status"` is progress, not an outcome.** It carries no content and arrives before the first delta. Treating it as terminal ends the run on its own first event: the activity indicator goes dark for the rest of the turn, and the finalize path re-lays the list.
- **A tool event never opens a run.** A tool event for an unseen `runId` is ignored, so a stray event from another device cannot conjure a local run.

`run_status` phases (`preparing_workspace`, `preparing_context`, `starting_model`) are normalized and keep the run alive, but are deliberately **not** surfaced as labels. They fire on every inference turn and carry nothing distinguishing a cold model load from a warm one, so naming them would describe the common case wrongly. The indicator stays generic.

### Run state — `run-state.ts`

`normalizeAgentEvent` and `normalizeSessionToolEvent` turn gateway payloads into `RunEvent`s, and `reduceRunEvent` folds them into one `RunState` per session. The gateway's streams are open-ended, so normalizing never throws. A payload carrying neither a `runId` nor a `sessionKey` is dropped. A stream the dashboard does not recognise, or a recognised one with malformed data, becomes an `unknown` event and is kept. An `item` event becomes a title for a tool call only when its kind is `tool`.

An event for the run already open never restarts it; one opening a different run replaces the whole state. An event that cannot open a run, arriving for one that is not open, changes nothing.

A run ends on `lifecycle` `end` or `error`, or on a `chat` `final`, `aborted` or `error`. Any tool still open is marked interrupted. A terminal chat event's text replaces the assembled text, unless it carries none.

Activity is `idle` with no run open and `tool` while any tool call is open. Otherwise the latest event decides it: a chat delta is `speaking`, reasoning is `thinking`, and anything else is `active`. A stream the dashboard does not recognise reads as `active`, never as `thinking`, because a run with no recognised stream may be doing anything.

Each tool call leaves a mark at the length of the text when it started, so the transcript can place its card. Its result marks it `done`, or `error` when the gateway flags one. Each phase of a tool call counts once, because the `agent` tool stream and its `session.tool` mirror deliver the same event twice. Compaction events never touch run state; `Session` handles them.

`applyLiveRun` rebuilds a run's items on every event and splices them back at the position they held. Appending instead moves a reply below anything the reader sent since it started — which a reader sees as their own message jumping upward.

### The conversation and sending — `conversation-store.ts`, `controls.ts`

`Conversation` holds a session's items and run state. Every event folds into the run state; while the run is open its items are rebuilt live, and when it ends they settle and stop streaming. The gateway regularly sends `lifecycle:end` before the trailing chat `final` of the same run, so a chat event for the run just ended settles its text again, and the reply is not cut short. Listeners registered with `onEvent` receive every event in order, after the snapshot already reflects it; voice mode reads the conversation this way.

History seeds the items, replacing what was there, and an older page is prepended without repeating an id already held. A row is identified by `__openclaw.id`, else its `seq`, else its position counted across pages. A row with no text is dropped. A tool card from history starts `unknown` and takes its status from a matching result: `done`, `error`, or `interrupted` when the result is one of the gateway's abort artifacts ("inserted synthetic error result", "This operation was aborted"). A call aborted in flight usually gets no result row at all, and its card stays `unknown`.

The snapshot's `known` turns false when the connection drops, and the next event or history load restores it. `setError` sets the error and also appends an error item to the flow; clearing the error leaves that item where it was. Compaction sets its own phase without touching items or the run: `active` on start; at the end, `retrying` if the gateway will retry, `complete` for five seconds if it completed, and cleared at once otherwise. A new compaction cancels a pending clear.

`SessionControls.send` adds the user's message at once as `pending`. If a run is active it aborts the run, waits up to five seconds for the run to end, and then sends whether or not it ended: the gateway's mid-run send kills the run without a reply, and dropping the user's words would be worse. A voice annotation is prefixed to both the shown message and the sent text. A send that succeeds marks the message `confirmed`; one that fails marks it `failed` and sets the error, and the message stays where it is. `resend` returns the same message to `pending` and sends it again. `stop` silences voice playback at once, before the abort completes, because a stop control that keeps talking for half a second feels broken.

### React bridge — `useSessionManager()`

Double `useSyncExternalStore`: one subscription to the `SessionManager`
(catalog), one to the currently-active `Session` (transcript), re-subscribed
whenever the active session changes. Returns a flattened object — this is
what `ChatPage` destructures directly.

---

## `ChatPage`

Owns UI-local state only: scroll position and the voice chrome. Everything
about the conversation itself — messages, streaming state,
agent/model/session — comes from `useSessionManager()`. The voice session
is not page state: it is the module-level `voiceSystem`
(`lib/voice/system/`), and the page reads it through two stores.

- `useVoiceSystemStore` — `phase` (`off`, `starting`, `live`, `ending`),
  `reconfiguring` (a saved provider change is readying a service under a
  live session) and `lastEnd` (why the last session ended).
- `useVoiceSessionStore` — what outlives a session: `voiceConfig`,
  `voiceSelection`, the service endpoints, and the gateway session the page
  publishes with `publishSession`.

### Voice vs. text input

A single derived flag: `voiceLoopEnabled = phase === 'live' && !reconfiguring`.
While `phase === 'starting'`, or `live` and `reconfiguring`, the composer
shows its waiting state and the voice-on chrome is held back.

`ChatComposer` always renders and carries both text entry and the voice
on/off control, so there is no swap between a text input and a voice one.
When `voiceLoopEnabled`, `VoiceControlsMobile` renders *in addition* as a
fixed control block on mobile; the desktop controls live in the composer
itself, chosen by CSS breakpoint rather than JS device detection.

The voice control calls `voiceOn()` from `lib/media-voice-mode.ts`, which
calls `voiceSystem.voiceOn()`. The mic is acquired by `acquire()` in
`lib/system/devices.ts`, which `voiceSystem` calls synchronously from the
tap, before any `await`: iOS Safari drops the user-activation context across
an await, so `getUserMedia` has to run in the same tick as the tap.

The page publishes its active `Session` to `useVoiceSessionStore`; the
voice system reads the gateway session from there. This is the whole
connection between the gateway session and the voice pipeline. The composer
and the mobile control block are pure presentation: they only render the
props `ChatPage` passes down. When `lastEnd.reason` is `held` (another
client holds the transcription slot), the page shows a dialog whose Take
over action calls `voiceOn({ takeover: true })`.

### Voice settings

The settings dialog (`features/settings/*`) is a config *editor*, not a live
control: `useVoiceSettings` stages provider/model/voice/speed/chunking
choices locally, and only on Save does it PATCH the selection server-side.
It then calls `applySavedVoiceSettings()` (`lib/voice/apply-voice-settings.ts`),
which merges the PATCH result into `useVoiceSessionStore` and calls
`voiceSystem.reconfigure(...)` to ready the services it now names.

---

## Known gaps in the protocol docs

- `models.list` (used by `SessionManager.initialize()`) isn't documented in
  `openclaw-gateway-protocol.md`.
- `sessions.list`'s `includeDerivedTitles`/`includeLastMessage` params
  aren't documented — the dashboard only requests them in one place to
  avoid the transcript-read cost elsewhere.
