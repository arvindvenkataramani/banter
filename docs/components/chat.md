# Component: Chat

*The Banter conversation surface, and the gateway/session layer it's built on.*

---

## Scope

This doc covers how the dashboard's Chat feature is built — state ownership,
component wiring, session lifecycle. It does **not** re-explain the gateway
wire protocol; that's covered in depth, and kept current, by:

- `../openclaw/gateway-session-lifecycle.md` — connect handshake, `chat.send`
  / `chat.history` / `sessions.reset` / `sessions.patch`, event ordering.
- `../openclaw/gateway-tool-and-message-events.md` — the `session.message`
  event family, tool-call dedup, `chat` vs `session.message` vs `agent`
  streams.
- `../openclaw/openclaw-gateway-protocol.md` — full RPC catalog, the
  `content` string-or-blocks union, `caps`, `__openclaw.id` anchoring,
  reconnect-as-new-projection.

The voice pipeline (mic loop, playback engine, playback arbiter, turn
manager) is described in `../architecture/voice-pipeline.md`. This doc only
covers how Chat *wires into* that pipeline, not its internals.

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

There is exactly one `GatewayConnection` for the whole dashboard — Home,
Services, and Chat all share it via `GatewayProvider`. `SessionManager` is
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
protocol doc's guidance. Tool-call detection in the `session.message`
stream fires `onToolCall`, which the voice pipeline uses to flush buffered
speech before a tool-call pause.

### React bridge — `useSessionManager()`

Double `useSyncExternalStore`: one subscription to the `SessionManager`
(catalog), one to the currently-active `Session` (transcript), re-subscribed
whenever the active session changes. Returns a flattened object — this is
what `ChatPage` destructures directly.

---

## `ChatPage`

Owns UI-local state only: scroll position, and the voice *service*
lifecycle (`voiceStatus: 'off'|'loading'|'ready'|'error'`, endpoints,
`speechEnabled`). Everything about the conversation itself —
messages, streaming state, agent/model/session — comes from
`useSessionManager()`.

### Voice vs. text input

A single derived flag: `voiceLoopEnabled = speechEnabled && voiceStatus === 'ready'`.

`ChatComposer` always renders and carries both text entry and the voice
on/off control, so there is no swap between a text input and a voice one.
When the loop is live, `VoiceControlsMobile` renders *in addition* as a fixed
control block on mobile; the desktop controls live in the composer itself,
chosen by CSS breakpoint rather than JS device detection.

`useVoiceLoop()` is always called; its own `enabled` option gates whether the
mic/VAD/playback machinery actually spins up.

Mic permission is requested *synchronously* inside the toggle's click
handler, before any `await` — iOS Safari drops the user-activation context
across an await, so the `MediaStream` has to be acquired in the same tick
as the tap. It's stored and handed to `useVoiceLoop` for `MicLoop` to
consume on first start.

`useVoiceLoop({ session: activeSession, messages, isStreaming, ... })` is
fed straight from `useSessionManager()` — this is the whole connection
between the gateway session and the voice pipeline. The composer and the
mobile control block are pure presentation; neither calls `useVoiceLoop` nor
touches the pipeline — they only render the props `ChatPage` passes down.

### Chat-launch (cross-page handoff)

Another page (e.g. Home's "Talk about this") can call
`setPendingChatLaunch()` before navigating to `/chat`. On mount, if a
launch is pending, `ChatPage` runs once: switch to the main agent/session,
start a new session, enable speech if needed, then send the opening
message. Gated on the gateway and voice config both being ready, so it
can't fire early.

### Voice settings

`VoiceSettings` is a config *editor*, not a live control — it stages
provider/model/voice/speed/chunking choices locally, and only on Save does
it PATCH the selection server-side and report back via callbacks.
`ChatPage`'s save handler is what actually hot-swaps the live TTS/STT
service; `VoiceSettings` itself never touches `useVoiceLoop`.

---

## `ChatFab`

Lives in the shared `components/` dir, not `features/chat/` — mounted once
in `App.tsx` outside the route switch, so it renders on every route except
`/chat` itself. Pure navigation shortcut to `/chat`; does not use
chat-launch.

---

## Known gaps in the protocol docs

Found while mapping this — worth fixing there, not here:

- `gateway-session-lifecycle.md` states protocol version 3; code
  (`CONNECT_PROTOCOL = 4`) and `openclaw-gateway-protocol.md` both say 4.
- `gateway-session-lifecycle.md` describes device-signed auth as skipped in
  favor of a token-only path. The dashboard implements full Ed25519
  device auth (`device-identity.ts`) — that path is live, not skipped.
- `models.list` (used by `SessionManager.initialize()`) isn't documented in
  `openclaw-gateway-protocol.md`.
- `sessions.list`'s `includeDerivedTitles`/`includeLastMessage` params
  aren't documented — the dashboard only requests them in one place to
  avoid the transcript-read cost elsewhere.
