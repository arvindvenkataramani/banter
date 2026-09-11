# OpenClaw Gateway Protocol Reference

How the OpenClaw gateway's native WebSocket protocol works. This is a reference for any OpenClaw component that needs to talk to the gateway directly — voice interfaces, external integrations, tooling, debugging.

Source of truth: the TypeBox schema definitions in `src/gateway/protocol/schema/` in the [OpenClaw repo](https://github.com/openclaw/openclaw). This document was compiled from those schemas plus the official docs. Where the two diverge, the schemas win.

Official docs, all three worth reading before client work:

- [`/gateway/protocol`](https://docs.openclaw.ai/gateway/protocol) — wire format, framing, version policy
- [`/gateway/clients`](https://docs.openclaw.ai/gateway/clients) — **building a client**: pairing, device identity, caps, reconnect, events
- [`/gateway/external-apps`](https://docs.openclaw.ai/gateway/external-apps) — integration overview and RPC entry points

`/gateway/clients` is the one that documents `GATEWAY_CLIENT_CAPS` and the
pairing flow. It did not exist when this document was started.

*Created: 2026-04-07 · Updated: 2026-08-20*
*Validated against OpenClaw 2026.7.1 (commit `2d2ddc4`), protocol v4.*

Verify before trusting: `openclaw --version` against the version above. The
clone at `~/code/openclaw` drifts from the installed CLI — check it out to the
matching commit before reading its source.

**Every upstream source describes a build ahead of the one you are
running.** Observed three times now, in three different channels:

| Source | Claimed | Actual on 2026.7.1 |
|--------|---------|--------------------|
| Official docs | ~10 client `caps` | `GATEWAY_CLIENT_CAPS` has 1 |
| npm `latest` | usable client package | `0.0.0` stub; real code on `beta` |
| Upstream help bot | `@openclaw/gateway-client/browser` published | not on `latest` |

Treat upstream as authoritative on **intent and design**, and as
unreliable on **what exists in your version**. Design guidance transfers;
factual claims about the present need checking against the installed
build before you act on them. One command settles the package class:
`npm view <pkg> version dist-tags`.

---

## About this document

**Structure:** Connection lifecycle first, then message format, then RPCs grouped by domain (chat, sessions), then streaming events. Each RPC includes the schema-verified parameter and response shapes.

**Rationale:** The official protocol docs are deliberately not a full schema dump — they describe patterns and point to source. This document fills the gap with concrete field names and types so that implementers don't have to read TypeScript to know what to send.

**When to update:** When the gateway protocol version changes, or when implementation reveals undocumented behavior. Always verify against the TypeBox schemas, not just observed gateway responses.

---

## Transport

WebSocket, text frames with JSON payloads. The gateway multiplexes HTTP and WebSocket on the same port, so the connection URL is the gateway's main address (e.g., `ws://<gateway-host>:<port>`).

The default gateway port is not specified in public docs. Check your deployment's configuration.

---

## Connection handshake

The WebSocket connection isn't usable until a challenge-response handshake completes. This is the first thing that happens after the TCP/WebSocket upgrade — you cannot send RPCs until the handshake succeeds.

### 1. Gateway sends challenge

Immediately after the WebSocket opens, the gateway sends:

```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": { "nonce": "<string>", "ts": <number> }
}
```

### 2. Client sends connect request

```json
{
  "type": "req",
  "id": "<unique-id>",
  "method": "connect",
  "params": {
    "minProtocol": <number>,
    "maxProtocol": <number>,
    "client": {
      "id": "<client-identifier>",
      "version": "<version-string>",
      "platform": "<platform-string>",
      "mode": "<mode-string>"
    },
    "role": "operator",
    "scopes": ["<scope-string>", ...],
    "auth": { "token": "<auth-token>" },
    "locale": "<locale-string>",
    "userAgent": "<user-agent-string>"
  }
}
```

Key fields:

- `role`: `"operator"` for clients that send messages on behalf of users. `"node"` for compute nodes (not relevant here).
- `scopes`: permissions the client is requesting.
- `auth`: either `{ "token": "<token>" }` or `{ "password": "<password>" }`.
- `client.id`, `client.version`, `client.platform`: identify the connecting application. For Banter, something like `{ "id": "banter", "version": "0.1.0", "platform": "server" }`.
- `caps`: **operator clients must send this too.** It gates which event
  families the connection receives — see "Capability-gated event families"
  below. `commands` and `permissions` are node-only.

### 3. Gateway responds with hello-ok

On the wire (observed 2026-08-07 against 2026.7.1), the reply is a normal
`res` frame answering the connect request; the hello-ok object is its
payload, not a separate frame type:

```json
{
  "type": "res",
  "id": "<matching connect request id>",
  "ok": true,
  "payload": {
    "type": "hello-ok",
    "protocol": <number>,
    "server": { "version": "<string>", "connId": "<uuid>" },
    "features": { "methods": ["..."] },
    "policy": { "tickIntervalMs": <number> },
    "auth": {
      "deviceToken": "<token>",
      "role": "<role>",
      "scopes": ["..."],
      "deviceTokens": [...]
    }
  }
}
```

A client should key on the `res` for its connect request (accepting a bare
`hello-ok` frame defensively costs nothing). After it arrives, the
connection is live and RPCs can be sent.

### Heartbeat

The gateway sends `tick` frames at the interval specified by `policy.tickIntervalMs`:

```json
{ "type": "tick", "ts": <milliseconds> }
```

The client should monitor for ticks to detect connection liveness. If ticks stop arriving, the connection is probably dead.

### Shutdown

The gateway may send a shutdown notification before closing:

```json
{ "type": "shutdown", "reason": "<string>", "restartExpectedMs": <number> }
```

`restartExpectedMs` is optional — if present, the client can schedule reconnection accordingly.

---

## Message format

All frames are JSON objects with a `type` discriminator.

### Request (client → gateway)

```json
{
  "type": "req",
  "id": "<unique-request-id>",
  "method": "<rpc-method>",
  "params": { ... }
}
```

The `id` must be unique per connection. The gateway uses it to correlate responses.

### Response (gateway → client)

Success:
```json
{
  "type": "res",
  "id": "<matching-request-id>",
  "ok": true,
  "payload": { ... }
}
```

Error:
```json
{
  "type": "res",
  "id": "<matching-request-id>",
  "ok": false,
  "error": { ... }
}
```

### Event (gateway → client, asynchronous)

```json
{
  "type": "event",
  "event": "<event-name>",
  "payload": { ... },
  "seq": <number>,
  "stateVersion": <number>
}
```

`seq` and `stateVersion` are optional. `seq` is used for ordering within a stream (e.g., streaming chat tokens). `stateVersion` is used for state synchronization.

---

## Idempotency

Side-effecting RPCs accept an `idempotencyKey` parameter. On `chat.send` this field is **required** (NonEmptyString). On `sessions.send` it is optional.

The key prevents duplicate processing when a request is retransmitted after a connection interruption. The exact server-side deduplication behavior (whether it returns cached results, status codes for in-flight vs completed runs, etc.) is not fully specified in the schemas — verify empirically during implementation.

---

## Agent targeting

An OpenClaw gateway can run multiple agents. Each agent is a fully scoped runtime with its own workspace, state directory, session store, and model configuration. When you send a message, the gateway needs to know which agent should handle it.

### Agent IDs

Every agent has an `agentId` string. The default agent is `"main"`. Agents are configured in `~/.openclaw/openclaw.json` and can be listed via the `agents.list` RPC or the `GET /v1/models` HTTP endpoint (which returns agents as `openclaw/<agentId>`).

### How targeting works

Agent targeting is encoded in the **sessionKey**. The session key format is `agent:<agentId>:<mainKey>`, so the agent is determined by which session you're talking to. To target a specific agent, use a sessionKey that includes that agent's ID:

- `agent:main:main` — default agent, default session
- `agent:coding:main` — the "coding" agent, default session
- `agent:main:voice` — default agent, a session named "voice"

When creating a session explicitly via `sessions.create`, the `agentId` parameter determines which agent owns the session. When sending to an existing sessionKey via `chat.send` or `sessions.send`, the agent is implicit in the key.

### Default agent resolution

If the gateway needs to pick an agent and no explicit target is provided (e.g., from a channel binding), the fallback order is:

1. Explicit binding match — peer, then guild/roles, then channel-level default
2. First agent with `default: true` in `agents.list`
3. First entry in `agents.list`
4. Built-in fallback: `"main"`

### Agent targeting over HTTP

The HTTP compatibility endpoint uses the `model` field as an agent selector:

- `"openclaw"` or `"openclaw/default"` → default agent
- `"openclaw/<agentId>"` → specific agent
- Legacy aliases `"openclaw:<agentId>"` and `"agent:<agentId>"` are also supported

The `x-openclaw-agent-id` header is a compatibility override for agent selection. The `x-openclaw-model` header (e.g., `openai/gpt-5.4`) overrides the backend LLM model without changing which agent handles the request. The `x-openclaw-session-key` header fully controls session routing.

### Bindings (channel-based routing)

For integrations that receive messages from external channels (Discord, Slack, etc.), the gateway uses **bindings** — deterministic routing rules that map incoming messages to agents based on channel, account, peer identity, or guild. Most-specific match wins. This is less relevant for direct WebSocket clients like Banter, which construct their own sessionKeys explicitly.

### Agent-related RPCs

- `agents.list` — returns all configured agent entries
- `agents.create`, `agents.update`, `agents.delete` — manage agent records
- `agent.identity.get` — returns the effective assistant identity for an agent or session
- `agent.wait` — waits for a run to complete

---

## Session concepts

Three identifiers matter.

**`agentId`** identifies which agent owns a session. Each agent has its own isolated session store. The agent is encoded in the sessionKey and determines the workspace, model config, and tools available during a run.

**`sessionKey`** is a routing string that identifies a conversation bucket scoped to an agent. Format: `agent:<agentId>:<mainKey>` where `mainKey` defaults to `main`. Other patterns exist for group chats, channels, cron jobs, webhooks. The sessionKey is what you pass to `chat.send` and other RPCs.

**`sessionId`** is a UUID that identifies a specific session instance within a sessionKey. A single sessionKey can have multiple sessionIds over time — every reset creates a new sessionId. The gateway manages sessionIds; clients mostly interact via sessionKeys.

**Session storage:** Each agent's sessions live under `~/.openclaw/agents/<agentId>/sessions/`. Metadata is in `sessions.json`. Transcripts are in `<sessionId>.jsonl`.

**Session creation:** Sessions can be created explicitly via `sessions.create` (with optional `agentId` to target a specific agent) or implicitly by sending a message to a sessionKey that doesn't have an active session. The Talk Mode native apps just use `chat.send` against key `main` without an explicit create step.

**Session expiry:** By default, sessions reset daily at 4:00 AM local gateway time (new sessionId, old transcript preserved). Idle reset is configurable via `session.reset.idleMinutes`. Manual reset via `sessions.reset` or the `/new` and `/reset` user commands.

---

## Chat RPCs

These are the UI-facing chat methods. They use `sessionKey` as the session identifier.

### chat.send

Sends a user message into a session and triggers an agent run. Non-blocking — returns an acknowledgment immediately, then streams response tokens as events.

**Params:**
```
sessionKey:               string (1–512 chars, required)
message:                  string (required)
idempotencyKey:           string (non-empty, required)
thinking:                 string (optional)
deliver:                  boolean (optional)
originatingChannel:       string (optional)
originatingTo:            string (optional)
originatingAccountId:     string (optional)
originatingThreadId:      string (optional)
attachments:              array (optional)
timeoutMs:                integer >= 0 (optional)
systemInputProvenance:    InputProvenance (optional)
systemProvenanceReceipt:  string (optional)
```

**Response payload** includes `messageId` and session metadata.

**Streaming:** After the acknowledgment, response tokens arrive as `chat` events. See "Streaming events" below.

### chat.abort

Halts an in-flight agent run.

**Params:**
```
sessionKey:  string (non-empty, required)
runId:       string (non-empty, optional)
```

If `runId` is omitted, aborts whatever is currently active on the session.

### chat.inject

Appends a message to the session transcript without triggering an agent run. The message enters history but does not cause the LLM to respond.

**Params:**
```
sessionKey:  string (non-empty, required)
message:     string (non-empty, required)
label:       string (max 100 chars, optional)
```

### chat.history

Retrieves the display-normalized transcript for a session.

**Params:**
```
sessionKey:  string (non-empty, required)
limit:       integer 1–1000 (optional, default 200, max 1000)
maxChars:    integer 1–500,000 (optional)
```

**Response payload:**
```
sessionKey:    string
sessionId:     string (UUID) | undefined
messages:      Message[]
thinkingLevel: string | undefined
fastMode:      boolean | undefined
verboseLevel:  string | undefined
```

Each `Message` object has:
```
role:       "user" | "assistant" | "tool" | "tool_result" | ...
content:    string | ContentBlock[]
timestamp:  number (optional)
provenance: InputProvenance (optional — see "Inter-agent messaging" below)
senderLabel: string (optional — extracted from inbound message envelope)
```

Where `ContentBlock` is `{ type: "text", text: string }` or other typed blocks (tool_use, tool_result, etc.). UIs should filter to `role === "user" | "assistant"` and extract only `type === "text"` blocks for display.

---

## Session RPCs

These are the session management methods. They use `key` (not `sessionKey`) as the parameter name.

### sessions.create

Creates a new session explicitly.

**Params:**
```
key:               string (non-empty, optional — auto-generated if omitted)
agentId:           string (non-empty, optional)
label:             string (optional)
model:             string (non-empty, optional)
parentSessionKey:  string (non-empty, optional)
task:              string (optional)
message:           string (optional)
```

**Response** includes `sessionId` (UUID), timestamps, and metadata.

### sessions.get

Returns the full stored session row.

**Params:**
```
key:  string (non-empty, required)
```

### sessions.send

Sends a message into a session. This is the session-oriented alternative to `chat.send`.

**Params:**
```
key:             string (non-empty, required)
message:         string (required)
thinking:        string (optional)
attachments:     array (optional)
timeoutMs:       integer >= 0 (optional)
idempotencyKey:  string (non-empty, optional)
```

Key differences from `chat.send`: uses `key` instead of `sessionKey`, `idempotencyKey` is optional (not required), and the delivery routing fields (`originatingChannel`, etc.) are absent.

### sessions.steer

Abort-and-replace, not mid-run injection. Verified in source at 2026.7.1 (`2d2ddc4`), `src/gateway/server-methods/sessions.ts`: `sessions.steer` is the same handler as `sessions.send` with `interruptIfActive: true`. If a run is active it calls `chat.abort`, **clears all queued follow-up messages** for the session, waits for the run to end, then dispatches a fresh `chat.send` with the new message.

Scope caution: this establishes the `sessions.steer`/`sessions.send` RPC path only. A queue-mode system (`steer | followup | collect | interrupt`) with mid-run injection machinery reportedly exists at the embedded-runner level (`handle.queueMessage`); whether any path our clients hit resolves to genuine mid-run injection is **unresolved** — the webchat UI observably queues. See `platform/plans/voice-interaction-design-ideas.md` § Gateway facts.

By contrast, `sessions.send` during an active run queues the message; the queue is delivered after the run completes (this is the queue that steer discards).

**Params:** same shape as `sessions.send` (shared validator); `key` required. Steering requires an existing session row — unlike send, it does not auto-create an empty agent main session.

Related but separate surface: `talk.session.steer` / `talk.client.steer` exist for OpenClaw's built-in Talk Mode; not examined.

### sessions.abort

Aborts active work on a session.

**Params:**
```
key:  string (non-empty, required)
```

### sessions.reset

Creates a new sessionId under the same sessionKey. The old session's transcript is preserved on disk — this does not delete history, it starts a fresh conversation.

**Params:**
```
key:     string (non-empty, required)
reason:  "new" | "reset" (optional)
```

### sessions.compact

Summarises older conversation history to free context window space. Recent messages (after `firstKeptEntryId`) are kept intact. Tool call / tool result pairs are preserved across chunk boundaries.

**Params:**
```
key:       string (non-empty, required)
maxLines:  integer >= 1 (optional)
```

Note: auto-compaction runs when `contextTokens > contextWindow - reserveTokens` (default reserve: 16,384 tokens, enforced floor: 20,000). Manual compaction may be unnecessary if auto-compaction is enabled.

### sessions.patch

Updates metadata and overrides on a session.

**Params include (all optional except key):**
```
key:                    string (non-empty, required)
label:                  string (optional)
model:                  string (optional)
thinkingLevel:          (optional)
fastMode:               (optional)
verboseLevel:           (optional)
reasoningLevel:         (optional)
execHost, execSecurity: (optional, execution controls)
responseUsage:          "off" | "tokens" | "full" | "on" (optional)
```

Plus subagent and group configuration fields.

### Other session RPCs

These exist but are less likely to be needed by typical integrations:

- `sessions.list` — returns the session index
- `sessions.preview` — returns bounded previews
- `sessions.resolve` — canonicalizes a session target
- `sessions.delete` — removes a session
- `sessions.subscribe` / `sessions.unsubscribe` — toggle session-level event subscriptions
- `sessions.messages.subscribe` / `sessions.messages.unsubscribe` — toggle transcript event subscriptions
- `sessions.usage`, `sessions.usage.timeseries`, `sessions.usage.logs` — usage reporting

---

## Inter-agent messaging

Agents can send messages directly into another agent's session. When this happens, the receiving session gets a `user` role message with a `provenance` field identifying the source.

### InputProvenance

```ts
{
  kind:             "external_user" | "inter_session" | "internal_system"
  originSessionId?: string   // UUID of the originating session instance
  sourceSessionKey?: string  // session key of the sender, e.g. "agent:researcher:main"
  sourceChannel?:   string
  sourceTool?:      string
}
```

When `kind === "inter_session"`, the message came from another agent. `sourceSessionKey` identifies the sender — parse the agentId out of it with the `agent:<agentId>:<mainKey>` format.

### What the streaming event carries

The live `chat` event payload (`ChatEvent`) has **no provenance field** — it only carries `runId`, `sessionKey`, `seq`, `state`, `message`, etc. There is no way to identify the sender from a streaming event alone.

Provenance is only available from `chat.history`. To show sender attribution for inter-agent messages, reload history after the run completes (`state === "final"`).

### Identifying inter-agent messages in history

```ts
function getSenderAgentId(message: { role?: string; provenance?: unknown }): string | null {
  if (message.role !== 'user') return null
  const p = message.provenance as { kind?: string; sourceSessionKey?: string } | undefined
  if (p?.kind !== 'inter_session' || !p.sourceSessionKey) return null
  // sourceSessionKey format: "agent:<agentId>:<sessionName>"
  const match = p.sourceSessionKey.match(/^agent:([^:]+):/)
  return match ? match[1] : null
}
```

### Effect on the receiving session

An inter-agent message triggers a normal agent run in the receiving session — the receiving agent reads the message and generates a response. From the UI's perspective, a new `user` message appears (from the sender agent) followed by the receiving agent's `assistant` response. Both arrive via the same `sessionKey` as normal messages.

When `chat.send` (or `sessions.send`) triggers an agent run, response tokens stream back as events with the `chat` event family.

### ChatEvent schema

```json
{
  "type": "event",
  "event": "chat",
  "payload": {
    "runId":        "<string>",
    "sessionKey":   "<string>",
    "seq":          <integer>,
    "state":        "delta" | "final" | "aborted" | "error",
    "message":      <content>,
    "errorMessage": "<string, optional>",
    "usage":        <object, optional>,
    "stopReason":   "<string, optional>"
  }
}
```

**`state` values:**

- `"delta"` — partial response. `message` contains the incremental token(s). These arrive in `seq` order.
- `"final"` — generation complete. `message` contains the full assembled response. `usage` and `stopReason` may be populated.
- `"aborted"` — run was cancelled (e.g., via `chat.abort`).
- `"error"` — run failed. `errorMessage` describes what went wrong.

**Event subscription:** `chat` events flow automatically after `chat.send` —
no subscription, no capability. Every other event family must be asked for.
See "Capability-gated event families".

### Other event families

- `session.message` — message-granular transcript updates
- `session.tool` — session-scoped structured tool lifecycle
- `agent` (`stream: "tool"`) — run-scoped structured tool lifecycle
- `sessions.changed` — session index/metadata changes

The three streams that carry an agent run, and which to use for what, are
covered in `gateway-tool-and-message-events.md`.

---

## Capability-gated event families

Some event families are delivered **only** to connections that asked for
them. Asking has two separate mechanisms, and missing either one produces
silence rather than an error.

**1. `caps` in the connect params.** `GATEWAY_CLIENT_CAPS` in 2026.7.1
contains exactly one entry, `tool-events`. Omit it and the gateway never
registers the connection as a recipient for structured tool events. The
handshake succeeds, `hello-ok` looks normal, and no tool events arrive.

**2. Explicit subscription RPCs.** `sessions.subscribe` (session events,
including `session.tool`) and `sessions.messages.subscribe` (per-session
`session.message`). Both are per-connection, both fire-and-forget.

`chat` events are the exception — they flow as a side effect of `chat.send`
with no subscription and no capability. That asymmetry is the trap: the one
stream that arrives unbidden is the one that teaches you streams arrive
unbidden.

**Consequence for investigation:** you cannot discover these families by
watching your own traffic. A client that never advertised `tool-events` sees
an event stream that looks complete and is not. Enumerate the surface from
source before concluding anything about what the gateway sends:

| What | Where |
|------|-------|
| Capability constants | `src/gateway/protocol/client-info.d.ts` |
| Event families + scopes | `src/gateway/server-broadcast.ts` |
| Method / event name list | `src/gateway/server-methods-list.ts` |
| Tool event payload types | `src/infra/agent-events.ts` |

This cost us three weeks once — see the postmortem in
`gateway-tool-and-message-events.md`.

---

## The HTTP compatibility endpoint

The gateway can optionally serve OpenAI-compatible HTTP endpoints on the same port. Disabled by default.

**Endpoints (when enabled):**

- `POST /v1/chat/completions` — chat interface
- `GET /v1/models` / `GET /v1/models/{id}` — model listing
- `POST /v1/embeddings` — embedding generation
- `POST /v1/responses` — agent-native alternative

**Session behavior:** Stateless by default (new session per request). If the `user` field is populated, the gateway derives a stable sessionKey from it, allowing repeated calls to share a session.

**Limitations:** No session management operations (reset, compact, abort, history). No streaming events beyond what SSE provides. Exists for third-party tool compatibility, not as a primary interface.

**Configuration:**
```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: true }
      }
    }
  }
}
```

---

## Talk Mode (native voice)

The gateway has a built-in voice mode ("Talk Mode") that uses a different architecture from Banter. Documented here for context — Banter intentionally does its own STT/TTS rather than delegating to Talk Mode.

Talk Mode's loop: listen for speech → submit transcript via `chat.send` against session key `main` → receive response → speak via `talk.speak` RPC using the configured Talk provider.

The `talk.speak` RPC supports voice configuration (voice ID, speed, stability, output format) and provider-specific settings (ElevenLabs params, etc.). Audio format defaults to pcm_44100 on macOS/iOS and pcm_24000 on Android.

Banter's approach differs: it runs its own STT (Parakeet) and TTS (three-tier provider registry) and only uses the gateway for LLM chat via `chat.send`. This gives Banter control over the voice pipeline while still sharing the session with WebChat and other clients.

---

## Future refinements

### Per-agent TTS voice assignment

Currently `use-speech.ts` voices all `assistant` messages with a single globally-selected voice, regardless of which agent produced them. In a multi-agent session this is fine for the receiving agent's responses, but there's no way to give different agents distinct voices.

**Proposed config shape** (under `voice.tts` in `config.json`):
```json
"agents": {
  "banter":  { "serviceId": "tts-mlx-audio", "model": "...", "voice": "neutral_male" },
  "researcher": { "serviceId": "tts-mlx-audio", "model": "...", "voice": "neutral_female" }
}
```

**What would change:**
- `VoiceConfig` gains an optional `agents` map: `Record<string, VoiceSelection>`
- `use-speech.ts` receives the active `currentAgent` and uses `agents[currentAgent]` selection, falling back to `default`
- The voice settings UI would show per-agent overrides
- User per-session localStorage overrides remain supported on top

**Deferred because:** The immediate TTS bug (inconsistent voicing when inter-agent messages arrive) is a message-tracking issue, not a routing issue — fixing that comes first.

---

## Client requirements learned in practice

Things the official docs don't state, or state for a newer release than
stable. All verified against 2026.7.1 on 2026-08-06 while fixing the
dashboard's history rendering.

**`content` is a union** — `string | ContentBlock[]`, documented above. Typed
user messages arrive as plain strings; assistant messages are always block
arrays. Handling only the array form renders every user message blank on
reload. The union is not in the official docs.

**Declare `caps` or lose tool events silently.** Without `tool-events` in the
connect params no live tool events arrive and the handshake reports no error.
`GATEWAY_CLIENT_CAPS` in 2026.7.1 contains only `tool-events`; the docs list
around ten, describing a newer build. This is one instance of a general rule —
see "Capability-gated event families".

**The official client packages are stubs on `latest`, real on `beta`.**
`/gateway/clients` recommends `@openclaw/gateway-client` and
`@openclaw/gateway-protocol`. Checked 2026-08-07:

```
@openclaw/gateway-client  latest: 0.0.0   beta: 2026.7.2-beta.7
@openclaw/gateway-protocol latest: 0.0.0
```

So `npm install` gets the placeholder; the real package exists only on a
beta tag *ahead of the installed CLI* (2026.7.1). Upstream will describe
the beta as available — it is, but not on a version you are running.

The in-repo package is `private: true`, built `--platform node`, and
depends on `ws`, so it would not run in a browser regardless. A
`@openclaw/gateway-client/browser` subpath is said to exist on the beta;
unverified. Build against the WebSocket protocol directly.
`protocol.schema.json` inside the repo is still the machine-readable
contract.

Note the monorepo's own web UI does **not** use the client package — it
has an independent `GatewayBrowserClient` on the native WebSocket
(`ui/src/api/gateway.ts`). There is no shared client between CLI/SDK and
browser.

**`chat.history` is display-normalized.** Directive tags and tool-call XML are
stripped, envelopes removed from user rows, and user rows whose text strips to
empty are dropped entirely — the assistant branch deliberately isn't
symmetric. Media-only rows arrive as `content: ""` with a sibling `MediaPath`.
Base64 image data is replaced with `{omitted: true, bytes: N}`.

**Anchor history on `__openclaw.id`**, not array position — ids must survive a
reload to reconcile against live events. Page with `hasMore` / `nextOffset`;
a single response caps at 200 messages.

**Reconnect is a new projection**, not a resumption: re-subscribe and re-fetch
history rather than trusting in-memory state.

**Subscribe, don't poll** — `sessions.subscribe` once per connection, then
merge `sessions.changed` by `sessionKey`.

**Device naming** — send `client.displayName` in the connect params. It is
persisted into the pairing record and shown by `openclaw devices list`;
without it devices appear as anonymous hex. Written once at pairing and never
refreshed, so it must not carry anything that goes stale. `operatorLabel` and
`devices rename` are documented upstream but absent from 2026.7.1.

**Pairing approval takes the request id, not the device id.** A first
connect from an unpaired device fails with "pairing required: device is
not approved yet" and leaves a pending request; approve it with
`openclaw devices approve <request-uuid>` (the UUID from
`openclaw devices list`), then reconnect.

**`openclaw-probe` is a first-class client id** (`GATEWAY_CLIENT_IDS.PROBE`,
client mode `probe` in `client-info.d.ts`) — measurement clients can
identify honestly instead of masquerading as a UI. The platform probe at
`control/probe/` uses it.

**Derived session titles** come from the first user message, which for some
sessions is an injected metadata envelope rather than anything typed. Titles
arrive whitespace-collapsed and truncated, so a fenced block often loses its
closing fence.

**`protocol.schema.json`** ships in `@openclaw/gateway-protocol` and is the
machine-readable contract. Generating types from it would turn shape
mismatches into compile errors.

**Two different credentials share the name "token."** The `auth.token` sent in
connect params is a long-lived gateway token, configured out of band; it is
what `config.json` holds. The `auth.deviceToken` returned in `hello-ok` is
per-device, issued at pairing, and is what `openclaw devices` manages. Rotating
one does not touch the other.

**Rotation is a CLI operation, not an RPC** (2026.7.1): `openclaw devices
rotate --device <id> --role <role> [--scope <scope>...]`, with `revoke` as the
companion. Both take `--device` and `--role` rather than a token value, so
rotation is per device-role — there is no single call that rolls every
credential at once. `openclaw devices list` shows the device table, including
entries whose tokens are already `(revoked)`.

---

## Still open

1. **`chat.send` vs `sessions.send`:** Which should Banter use? `chat.send`
   has required idempotency and delivery routing fields. `sessions.send` is
   simpler. The native apps and Talk Mode use `chat.send`. We use `chat.send`.
2. **Abort behavior on history:** When a run is aborted, does the partial
   response stay in the transcript, get truncated, or get removed?
3. ~~**`sessions.steer` for barge-in:** Better fit than abort + new send for
   voice interruptions?~~ Answered 2026-08-08: steer *is* abort + send in one
   RPC, plus queue-clearing (see §sessions.steer). Whether mid-run injection
   exists on any path remains open — see the scope caution in that section.
