# OpenCode Server Protocol Reference

How OpenCode's headless HTTP server works, for a client that wants to hold a conversation against it. The reason this document exists: OpenCode ships a server whose sessions are addressable over HTTP and whose event stream is broadcast to every subscriber, which makes it reachable the way the OpenClaw gateway is reachable — dial it, subscribe, send. That property is not available from the ACP path into the same agent, so which door you use decides what the client can do.

Source of truth: the OpenCode source at [`anomalyco/opencode`](https://github.com/anomalyco/opencode). Compiled by reading the server routes, event bus and session machinery, not from the published docs.

*Created: 2026-09-11 · Read against commit `193de13a` (branch `dev`).*

**Verify before trusting.** Pin what you read to a commit and check it against the build you are running. Every claim below is stamped `193de13a`; anything not re-checked against your own build is a claim about a different program.

**The published documentation describes a different architecture.** The codebase was rewritten onto Effect (`effect/unstable/httpapi`); schemas moved to `packages/schema`, and the `Bus.subscribe` module that older write-ups reference no longer exists. Public material describing a Hono server is stale. Treat upstream as authoritative on intent and unreliable on mechanism — the same rule the OpenClaw notes arrived at independently.

**Two event families exist in the source and only one was observed being published.** See "The wire format you actually get" — building against the wrong one is the most expensive mistake available here.

---

## Starting it

```
opencode serve [--port <number>] [--hostname <string>] [--cors <origin>]
```

Defaults to `127.0.0.1:4096`. A runtime-generated OpenAPI document is served at `/doc`, produced from the live route definitions, which makes it the authoritative check on paths and payloads for your build.

Authentication is a single server-wide HTTP basic password: `OPENCODE_SERVER_PASSWORD`, username from `OPENCODE_SERVER_USERNAME` or defaulting to `opencode`. Unset means unauthenticated, and the server says so on startup. There is no per-client credential, which is the root of the ownership property below rather than an oversight to work around.

## The shape of it

A stateful server that clients attach to. Sessions live in the server and are addressed by id; the TUI is one client among several rather than the program that owns them. This is the same topology as the OpenClaw gateway and the reason a voice client can be a peer rather than a host.

| Route | Does |
|---|---|
| `POST /session` | Creates a session (optional `parentID`, `title`) |
| `GET /session` | Lists sessions |
| `GET /session/:id` | One session |
| `GET /session/:id/message` | Message history |
| `POST /session/:id/message` | Sends and waits for the turn to finish |
| `POST /session/:id/prompt_async` | Sends, returns 204 immediately |
| `GET /event` | SSE, scoped to a directory |
| `GET /global/event` | SSE, unfiltered across instances |

SSE frames are `event: message` with `data` a JSON `{ id, type, properties }`.

## Multiple clients on one session

**The event stream is broadcast.** Each HTTP request registers its own listener with its own unbounded queue, released when the connection drops; publishing fans out to all of them. There is no connection limit, no takeover of an existing subscriber, and no per-client filtering. `GET /event` filters only on directory scope (`x-opencode-directory`, and a workspace id when present); `GET /global/event` does not filter at all.

**So a second client sees the first client's turn** — the assistant's streaming output and the user message that prompted it, since the session service publishes both and the filter is scope-based. This is the property that lets a voice client join a conversation someone else is driving.

**No session is owned by a client.** Searches for owner, claim, exclusive, lease and client-id concepts across the session service, session schema and route definitions found nothing. With one shared password the server cannot distinguish callers in principle, so any client may abort any session. There *is* an `ownerID`/claim concept in the event core, but it governs durable event replay between workspaces and is not session access control — a genuine trap for anyone grepping for the word.

### Concurrent prompts are absorbed, not rejected

This is the subtle case, and it matters most for voice.

Sending a prompt to a session that is already running does not error and does not start a second turn. The runner, asked to ensure a run exists while one is `Running`, hands back a handle to the in-flight run and discards the new work argument. There is no lock and no busy rejection: `prompt` declares no busy error at the route layer, while `shell`, `revert`, `unrevert` and `deleteMessage` all do. The omission is deliberate.

What happens instead is absorption through shared persisted state. The new user message is written before the loop is consulted; the loop re-reads messages each iteration and derives the last user message, and its exit condition requires the last assistant message to be parented to the last user message. That no longer holds, so the loop continues and parents a fresh assistant message to the new prompt. The second prompt joins the running turn at the next step boundary.

Consequences worth designing against:

- A synchronous `POST /session/:id/message` from the second caller blocks for the whole combined run and returns the same final assistant message as the first caller.
- A prompt sent during a *shell* run is queued in a single slot and started when the shell finishes; a second pending run overwrites the first rather than queueing behind it.
- A shell started during a prompt run **is** rejected, with a busy error.

For a voice client this is the behaviour to plan around: barge-in mid-turn merges into the turn in progress rather than superseding it. A client that expects interruption semantics has to implement them itself — abort, then send — because the server offers no supersede.

## The wire format you actually get

Two event families exist in the schema package. The rich `session.next.*` family (`text.delta`, `tool.called`, `step.ended`) is **defined but was never observed being published**: a search for publishers across the projectors, session processor, prompt path and LLM path found none. Everything on the prompt path emits the **v1** family.

Build against v1, and re-check this before implementing — absence across the prompt path is strong evidence, not exhaustive proof, and a forward-looking schema is exactly the kind of thing that starts emitting in a later release.

| Type | Payload |
|---|---|
| `session.created` / `.updated` / `.deleted` | `{ sessionID, info }` |
| `message.updated` | `{ sessionID, info }` |
| `message.removed` | `{ sessionID, messageID }` |
| `message.part.updated` | `{ sessionID, part, time }` — the whole part |
| `message.part.delta` | `{ sessionID, messageID, partID, field, delta }` — incremental |
| `message.part.removed` | `{ sessionID, messageID, partID }` |
| `session.diff` | `{ sessionID, diff }` |
| `session.error` | `{ sessionID?, error }` |
| `session.status` | `{ sessionID, status }` — `idle`, `busy`, or `retry` |
| `session.idle` | `{ sessionID }` — marked deprecated in source |
| `session.compacted` | `{ sessionID }` |
| `server.connected`, `server.heartbeat` (10s), `server.instance.disposed` | — |

### Deltas and cumulative parts describe the same content

Streaming text and reasoning both mutate an accumulated part *and* emit a delta. **A consumer that handles both double-counts every token.** Take `message.part.delta` for incremental output and treat `message.part.updated` as reconciliation of state you already hold.

Reasoning streams through the identical mechanism with a `reasoning` part type, so thinking is separable from spoken text by part type — which is what a voice client needs, since reasoning must never reach speech.

### Tool calls are part states, not events

There are no tool lifecycle events. A tool call is a `tool` part carrying `{ callID, tool, state }`, delivered by `message.part.updated`, whose state moves `pending` → `running` → `completed` or `error`. Watch part updates, key by `callID`, switch on status.

Parts in the union: `text`, `reasoning`, `tool`, `step-start`, `step-finish`, `file`, `agent`, `snapshot`, `patch`, `compaction`, `subtask`, `retry`.

Projecting this into a normalised event shape is low-to-moderate work. The union is small and cleanly discriminated; the real effort is de-duplicating delta against cumulative, and reassembling per-part and per-call state from whole-object snapshots.

### Aborts have no event of their own

There is no `aborted` type. Abort interrupts the fiber; an interrupted tool is written into content as aborted text and orphaned tool parts are marked for cleanup. The observable signal is the transition of `session.status` to `idle`. Whether `session.error` always accompanies an abort was not traced through every path — confirm it empirically before depending on it.

## Operational hazards

**The stream cannot be resumed.** Event ids are undefined and no handler reads `Last-Event-ID`, so a client that reconnects has no way to ask for what it missed and the gap is simply lost. A durable replay path exists over the event-sourced tables and is the likely recovery route, but it was only skimmed and is not documented here. Any client on a network that drops — a phone, most of all — needs this settled before it can claim to hold a conversation reliably.

**Slow consumers grow memory rather than being dropped.** The fan-out pubsub and each per-request queue are unbounded, so a client that stops reading causes growth on the server instead of backpressure or eviction. A bounded dropping variant exists in the event core; the SSE handler does not use it.

## What was not established

Honest limits on the reading above, kept because a later reader will otherwise assume they were covered:

- Whether `session.next.*` is emitted anywhere outside the prompt path — background jobs and projectors were not searched.
- What the model actually receives when a second prompt lands mid-stream rather than at a step boundary. Absorption is what the code implies; it was not run.
- Whether `session.error` is emitted on every abort path.
- The durable sync/replay surface, which is the answer to the resume gap and was not read.
- The generated OpenAPI document, which is the authoritative route reference and was not fetched from a live server.

## Confirming it yourself

Everything above comes from reading the source. These steps check the claims a client would be built on, in the order their answers matter. Run them against a scratch directory, not a real project — several of them leave a session mid-turn.

Start the server, and keep its port and directory consistent across every terminal below:

```
opencode serve --port 4096 --hostname 127.0.0.1
```

**1. Routes and payloads, as this build actually defines them.** Fetch the generated document first: it supersedes the route table above wherever the two disagree.

```
curl -s http://127.0.0.1:4096/doc > /var/tmp/opencode-openapi.json
```

**2. Broadcast to multiple subscribers.** Two SSE streams in two terminals, then a prompt from a third:

```
curl -N -H 'x-opencode-directory: /var/tmp/oc-scratch' http://127.0.0.1:4096/event
```
```
SID=$(curl -s -X POST http://127.0.0.1:4096/session -H 'content-type: application/json' -d '{}' | jq -r .id)
curl -s -X POST "http://127.0.0.1:4096/session/$SID/prompt_async" -H 'content-type: application/json' -d '{"parts":[{"type":"text","text":"count slowly to twenty"}]}'
```

Both streams carrying the same `message.part.delta` frames confirms the broadcast claim and, with it, that a voice client can join a conversation another client is driving. One stream receiving nothing refutes the central conclusion of this document.

**3. Delta against cumulative.** In the same capture, compare the concatenated `delta` fields for one `partID` against the `text` on that part's final `message.part.updated`. Equal means the two families describe identical content and a consumer must take one or the other — the double-counting hazard is real. Divergence means the relationship is more complicated than described here and needs its own reading.

**4. Absorption of a concurrent prompt.** The least settled behaviour, and the one a voice client is most exposed to. While the first prompt is still streaming, send a second to the same session:

```
curl -s -X POST "http://127.0.0.1:4096/session/$SID/prompt_async" -H 'content-type: application/json' -d '{"parts":[{"type":"text","text":"stop counting, say the word banana"}]}'
```

Watch for which of these happens: no error and the reply folds the second instruction into the turn already running (absorption, as the source implies); an HTTP error naming a busy session (a lock exists and this document is wrong); or two interleaved assistant messages (parallel turns, also contradicting the source). Note whether `session.status` returns to `idle` once between them, since that is what a client would have to watch to tell turns apart.

**5. Abort, and what signals it.** Abort mid-turn and record which events arrive:

```
curl -s -X POST "http://127.0.0.1:4096/session/$SID/abort"
```

A `session.status` transition to `idle` is the expected signal. Whether `session.error` accompanies it was never traced through every path — this is where to settle it.

**6. The resume gap.** Kill an SSE client mid-turn and reconnect it with a `Last-Event-ID` header. Events emitted during the gap arriving on reconnect would contradict the finding that ids are undefined and the header unread; silence confirms it, and makes the durable replay surface the next thing to read.

Record what these return against the commit you ran them on. A result that contradicts something above should correct this document rather than sit beside it.
