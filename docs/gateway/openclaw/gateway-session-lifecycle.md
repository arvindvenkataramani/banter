# Banter — Gateway Session Lifecycle

How Banter connects to the OpenClaw gateway and manages a conversation session. This covers every gateway interaction in the order it happens — from opening the WebSocket to resetting a conversation.

*Created: 2026-04-07 · Updated: 2026-04-08 (verified against openclaw source + working implementation)*
*Last validated against OpenClaw 2026.4.x. Describes our implementation, not
upstream's — see openclaw-gateway-protocol.md for the wire contract.*

---

## About this document

**Structure:** Operations in chronological order of a session's life. Each section is one gateway interaction, with the exact messages to send and expect.

**Source of truth:** Verified against the [openclaw/openclaw](https://github.com/openclaw/openclaw) source code, the [openclaw-studio](https://github.com/grp06/openclaw-studio) web client, and a working implementation in Banter's own dashboard.

**When to update:** When implementation reveals the actual behavior differs from what's described here, or when we add new gateway interactions.

---

## 1. Connect

Open a WebSocket to the gateway. The gateway immediately sends a challenge event:

```json
← { "type": "event", "event": "connect.challenge", "payload": { "nonce": "...", "ts": ... } }
```

Respond with a connect request. **This must be the first `req` frame on the connection** — any other request before `connect` will be rejected with `"invalid handshake: first request must be connect"`.

```json
→ {
    "type": "req",
    "id": "1",
    "method": "connect",
    "params": {
      "minProtocol": 3,
      "maxProtocol": 3,
      "client": { "id": "webchat-ui", "version": "0.1.0", "platform": "web", "mode": "webchat" },
      "role": "operator",
      "scopes": [
        "operator.admin",
        "operator.read",
        "operator.write",
        "operator.approvals",
        "operator.pairing"
      ],
      "caps": ["tool-events"],
      "auth": { "token": "<configured-auth-token>" },
      "locale": "en"
    }
  }
```

The gateway responds with a standard `res` frame (not a separate `hello-ok` frame type):

```json
← { "type": "res", "id": "1", "ok": true, "payload": { "protocol": 4, "policy": { ... }, ... } }
```

The connection is now live.

### Key details (verified)

- **Protocol version is currently `4`** — check `CONNECT_PROTOCOL` in `gateway-connection.ts` for the live value rather than trusting this number. `minProtocol` and `maxProtocol` in the connect request must match whatever that is.
- **Client `id` and `mode`** are stable identity labels (e.g., `webchat-ui`/`webchat`, `gateway-client`/`backend`). Known IDs get specific gateway behavior but custom IDs may work in general WS usage.
- **Device auth fields** (`device.id`, `publicKey`, `signature`, `signedAt`, `nonce`) are tied to the challenge nonce and signed with a locally-generated, persisted Ed25519 keypair (`device-identity.ts` on the dashboard side). Full device auth is implemented and live — this is not skipped via a token-only path.
- **`role` should be `"operator"`** for any client that needs to send chat messages. The `"node"` role can only call 7 node-specific methods and **cannot call `chat.send`**.
- **Scopes are required** — `operator.write` is needed for `chat.send`, `operator.read` for `chat.history` and session operations.
- **`caps: ["tool-events"]`** enables tool execution event streaming.
- The auth token is the shared gateway token from `openclaw.json`.
- **Do not send any other request until the connect response arrives.** The gateway rejects requests during the handshake phase.

### Browser origin check

Browser-origin WS clients trigger an origin check against `gateway.controlUi.allowedOrigins` in `openclaw.json`. This mainly applies to browser/control-ui scenarios — pure Bun/Node WS clients don't send an `Origin` header and are unaffected.

Add the dashboard's origin(s) to the allowlist:
```json
"gateway": {
  "controlUi": {
    "allowedOrigins": [
      "https://control-host.your-tailnet.ts.net",
      "http://control-host.your-tailnet.ts.net:4200"
    ]
  }
}
```

### Reconnection

On unexpected close, reconnect with exponential backoff (1s × 1.7^attempt, max 15s). The full handshake runs again on every new connection. **Events are not replayed after reconnect** — call `chat.history` to restore conversation state.

---

## 2. Target an agent and resume or create a session

The gateway can run multiple agents. Which agent handles messages is determined by the **sessionKey**. Common format is `agent:<agentId>:<sessionName>`, but `main` is valid shorthand, and canonical keys can include channel/group/thread segments.

Examples:

- `main` — shorthand for the default agent, default session
- `agent:main:main` — the default agent, default session (canonical form)
- `agent:banter:main` — the banter agent
- `agent:main:voice` — the default agent, a separate "voice" session

The `agentId` must match a configured agent on the gateway. To list available agents:

```json
→ { "type": "req", "id": "2", "method": "agents.list", "params": {} }
← { "type": "res", "id": "2", "ok": true, "payload": { "agents": [{ "id": "main", ... }, { "id": "banter", ... }] } }
```

**Sessions are created implicitly** — just send `chat.send` to a sessionKey and the gateway creates the session if it doesn't exist. No need for `sessions.get` or `sessions.create` before sending.

---

## 3. Send a message

```json
→ {
    "type": "req",
    "id": "3",
    "method": "chat.send",
    "params": {
      "sessionKey": "agent:main:main",
      "message": "What's the weather like today?",
      "deliver": false,
      "idempotencyKey": "a1b2c3d4-unique-per-send"
    }
  }
```

The gateway responds immediately with an acknowledgment — **this is NOT the assistant's response**:

```json
← { "type": "res", "id": "3", "ok": true, "payload": { "runId": "a1b2c3d4-unique-per-send", "status": "started" } }
```

### Key details (verified)

- **`chat.send` is non-blocking.** The response is just an ack. The assistant's actual text arrives via `event: "chat"` frames (see section 4).
- **`idempotencyKey` is required** and must be unique per send. Use a UUID or `Date.now()-random` format. If the same key is reused, the gateway returns the cached result (`status: "ok"`) instead of dispatching a new run — **no chat events will fire**.
- **`deliver: false`** prevents the message from being forwarded to external channels (Telegram, Discord, etc.). Use this for internal UI clients.
- **`status` values in the ack:**
  - `"started"` — new run dispatched, expect chat events
  - `"in_flight"` — a run with this idempotency key is already active (reused key, run still going)
  - `"ok"` — dedup cache hit, run already completed (reused key, run finished). Call `chat.history` to get the cached result.

---

## 4. Receive the streaming response

After the ack, response tokens stream as `event: "chat"` frames:

```json
← {
    "type": "event",
    "event": "chat",
    "payload": {
      "runId": "a1b2c3d4-unique-per-send",
      "sessionKey": "agent:main:main",
      "seq": 5,
      "state": "delta",
      "message": {
        "role": "assistant",
        "content": [{ "type": "text", "text": "The weather today is" }],
        "timestamp": 1775634493662
      }
    }
  }
```

When generation finishes:

```json
← {
    "type": "event",
    "event": "chat",
    "payload": {
      "runId": "...",
      "sessionKey": "agent:main:main",
      "seq": 42,
      "state": "final",
      "message": {
        "role": "assistant",
        "content": [{ "type": "text", "text": "The weather today is sunny with a high of 72°F." }],
        "timestamp": 1775634493735
      }
    }
  }
```

### Key details (verified)

- **`message` is an object**, not a string. Extract text via `message.content.filter(b => b.type === "text").map(b => b.text).join("")`.
- **Delta text is accumulated**, not incremental. Each delta's `message.content[0].text` contains the full text so far — replace the displayed text on each delta, don't concatenate.
- **Deltas are throttled** server-side (currently ~150ms, treat as implementation detail not protocol guarantee). Not every token produces a delta event.
- **Chat events flow automatically** after `chat.send` — no subscription needed.
- **Chat events are broadcast to ALL connected operator clients** (no scope guard on `chat` events). Match by `runId` and `sessionKey` to filter relevant events.
- **`event: "agent"` frames also arrive** with lower-level lifecycle/tool telemetry. These are NOT the same contract as `chat` — use `event: "chat"` for UI reply rendering.
- **`final` may have empty/omitted `message`** — in that case, use the last buffered delta text.

**State values:**
- `"delta"` — partial response. `message` has accumulated text so far.
- `"final"` — complete. `message` has the full response.
- `"aborted"` — run was cancelled (e.g., by `chat.abort`).
- `"error"` — run failed. Check `errorMessage` in the payload.

---

## 5. Abort (barge-in)

```json
→ { "type": "req", "id": "4", "method": "chat.abort", "params": { "sessionKey": "agent:main:main" } }
```

Omitting `runId` aborts whatever is currently active. If you have the `runId` from the streaming events, include it for precision.

The event stream will emit `"state": "aborted"` for that run.

---

## 6. Reset conversation

Starts a fresh conversation under the same sessionKey. The old transcript is preserved on disk.

```json
→ { "type": "req", "id": "5", "method": "sessions.reset", "params": { "key": "agent:main:main", "reason": "new" } }
```

---

## 7. Retrieve history

```json
→ { "type": "req", "id": "6", "method": "chat.history", "params": { "sessionKey": "agent:main:main", "limit": 200 } }
```

Returns display-normalized transcript. Call this after reconnection (events are not replayed) or to populate the UI on load.

---

## 8. Patch session

Override the model for the current session:

```json
→ { "type": "req", "id": "7", "method": "sessions.patch", "params": { "key": "agent:main:main", "model": "gpt-4" } }
```

---

## Summary of gateway interactions

| Order | When | RPC | Required? |
|-------|------|-----|-----------|
| 1 | Server starts / reconnects | `connect` (handshake) | Yes |
| 2 | After connect | `agents.list` | Recommended (populate agent dropdown) |
| 3 | After reconnect or on load | `chat.history` | Recommended (restore conversation) |
| 4 | Each user message | `chat.send` | Yes |
| 5 | Streaming | (receive `event: "chat"` frames) | Yes |
| 6 | Cancel generation | `chat.abort` | Yes (for that feature) |
| 7 | User says "new conversation" | `sessions.reset` | Yes (for that feature) |
| 8 | Change model | `sessions.patch` | Optional |

## Common pitfalls (from implementation)

1. **Treating `chat.send` response as the answer.** The ack just confirms the run started. Text comes from `event: "chat"` frames.
2. **Reusing idempotency keys.** The gateway caches results per key. Reusing a key returns cached status (`in_flight` or `ok`) — use UUIDs.
3. **Sending requests before connect completes.** The gateway rejects any request that arrives before the connect handshake finishes.
4. **Expecting `message` to be a string.** It's `{ role, content: [{ type: "text", text }] }`. Extract text from the content array.
5. **Browser-origin clients** may need `gateway.controlUi.allowedOrigins` depending on deployment/topology. Not needed for pure Bun/Node WS clients.
6. **Using `role: "node"`.** Node role is not for chat control-plane calls like `chat.send`. Use `operator` + `operator.write` scope.
7. **Empty `final` message.** The `final` event may have empty/omitted `message` — use the last delta text as fallback.
