# Adapting Banter to another harness

Banter's dashboard talks to one backend today: an OpenClaw gateway, over a WebSocket the browser dials directly. This page names the seams involved in putting Banter's voice in front of a different agent harness, or reusing its voice pipeline (turn-taking, chunking, playback, barge-in) in a different project.

This is not a build guide. For the fuller feasibility analysis — what a second backend actually costs, what's reusable, and what's genuinely new work — read [`dev/design/agent-backend-abstraction.md`](../dev/design/agent-backend-abstraction.md). It's written against a specific candidate (ACP, the Agent Client Protocol) but the seams it identifies are the general ones.

## The seams

### The gateway connection

[`dashboard/src/lib/gateway-connection.ts`](../dashboard/src/lib/gateway-connection.ts)'s `GatewayConnection` class owns the WebSocket to OpenClaw: handshake, reconnect with backoff, request/response correlation, and fan-out of `chat`, `agent`, and `session.tool` events to per-session listeners. It's constructed once, in [`dashboard/src/lib/gateway-context.tsx`](../dashboard/src/lib/gateway-context.tsx), from `{ url, token }` the control plane hands the browser at `GET /api/gateway`. Everything downstream of `connect()` is OpenClaw's own wire vocabulary — `sessionKey`, `idempotencyKey`, `runId`, `agentId` — and stays that way through this file only.

A different backend that speaks its own native protocol (a server your agent harness already exposes, reachable directly) replaces this class with an equivalent for that protocol. A backend reachable only by spawning a subprocess (stdio, the way most ACP agents work today) needs that subprocess owned server-side instead — a browser tab cannot spawn one or read its stdio — with the browser talking to whatever the control plane exposes in its place.

### The RunEvent shape

[`dashboard/src/lib/run-state.ts`](../dashboard/src/lib/run-state.ts) defines `RunEvent`, the shape everything downstream of the wire layer actually consumes:

```ts
export type RunEvent =
  | { kind: 'chat'; runId: string; state: 'delta' | 'final' | 'status' | 'aborted' | 'error'; text: string; errorMessage?: string; at: number }
  | { kind: 'run-status'; runId: string; phase: string; at: number }
  | { kind: 'tool'; runId: string; phase: 'start' | 'update' | 'result'; toolCallId: string; name: string; isError?: boolean; at: number }
  | { kind: 'item'; runId: string; toolCallId: string; title: string; at: number }
  | { kind: 'lifecycle'; runId: string; phase: 'start' | 'finishing' | 'end' | 'error'; aborted?: boolean; stopReason?: string; at: number }
  | { kind: 'thinking'; runId: string; text: string; at: number }
  | { kind: 'compaction'; phase: 'start' | 'end'; completed?: boolean; willRetry?: boolean; at: number }
  | { kind: 'unknown'; runId: string | null; stream: string; raw: unknown; at: number }
```

This union is already independent of OpenClaw's vocabulary — no `sessionKey` or `agentId` in sight. `run-state.ts` also holds the adapter functions (`normalizeAgentEvent`, `normalizeSessionToolEvent`, `chatToRunEvent`) that pattern-match OpenClaw's raw frames into these values, plus `reduceRunEvent`, the state machine that turns a stream of `RunEvent`s into a `RunState` (what's speaking, what tools are open, what's been said).

[`dashboard/src/lib/conversation-store.ts`](../dashboard/src/lib/conversation-store.ts)'s `Conversation` class is what everything else actually holds a reference to: it wraps `reduceRunEvent`, tracks conversation items and compaction state, and exposes `ingest(event: RunEvent)`, `onEvent(cb)`, and `waitForRunEnd(timeoutMs)`. The voice loop's chunker ([`dashboard/src/lib/voice/agent/speech-chunker.ts`](../dashboard/src/lib/voice/agent/speech-chunker.ts)) subscribes via `session.conversation.onEvent(...)`, and turn-admission code (`controls.ts`) calls `waitForRunEnd`. The render layer is just as clean: `MessageBubble`'s props are `{ role, text, isStreaming, senderAgentId, delivery, onResend }` and `ToolCard`'s are `{ title, status }` — no wire-layer type (`ChatEventPayload` and friends) reaches either.

**The test for a clean adapter:** adding a backend should mean writing a new frame-parsing function next to the existing one in `run-state.ts` (or an equivalent module, if the parsing has to live server-side — see below), translating that backend's native events into `RunEvent` values. It should never mean a change to `conversation-store.ts`, `MessageBubble`, or `ToolCard`. If any of those three needs to know which backend produced an event, the abstraction has leaked.

One thing to expect: a backend with concepts OpenClaw doesn't have (a plan, a thought distinct from a tool call) may need `RunEvent` to grow a variant. That's expected schema growth, not a sign the abstraction is wrong.

### Where the parsing runs

OpenClaw's frames arrive straight into the browser, so `run-state.ts`'s adapter functions run client-side. A backend reached only via a subprocess's stdout can only be read server-side — so for that kind of backend, the frame-to-`RunEvent` translation has to happen in the control plane (or a process it manages), and the resulting `RunEvent` values need a new hop from there to the browser. Nothing today carries `RunEvent` across a server-to-browser boundary; that hop doesn't exist yet.

### The protocol notes

[`docs/gateway/`](gateway/) holds reverse-engineered wire documentation, one directory per backend: [`docs/gateway/openclaw/`](gateway/openclaw/) for what Banter speaks today (the gateway protocol, session lifecycle, tool/message event shapes, and the run-state model OpenClaw itself uses), and [`docs/gateway/opencode/opencode-server-protocol.md`](gateway/opencode/opencode-server-protocol.md) for a second server that's dialable the same way OpenClaw's gateway is — reachable directly, without a subprocess. Read the relevant one before writing a frame parser for a new backend; each documents what its actual wire frames look like, which is what the parsing functions above have to match.

### The voice-mode plugin

[`plugins/voice-mode/`](../plugins/voice-mode) is a small OpenClaw plugin ([`index.ts`](../plugins/voice-mode/index.ts)): it hooks `before_prompt_build` and, for any session whose key starts with the configured `sessionKeyPrefix`, appends [`voice-guidance.md`](../plugins/voice-mode/voice-guidance.md) to the system prompt — telling the agent it's being spoken to rather than read, so replies work out loud instead of reading like a chat transcript. It's OpenClaw-specific (built against `openclaw/plugin-sdk`) and has nothing to do with the transport or event seams above; adapting to a harness without a plugin mechanism means finding whatever equivalent hook that harness offers for injecting system context per session, or dropping this piece and accepting replies written for a reader rather than a listener.

## No tool approvals

Banter deliberately ships no tool-use or action-approval UX. `gateway-connection.ts` requests the `operator.approvals` scope from OpenClaw as part of its handshake, but nothing in this repo — dashboard or control plane — ever renders an approval request or answers one. Whether a tool call actually runs unconfirmed is between your agent and its own configuration; per [`dev/design/agent-backend-abstraction.md`](../dev/design/agent-backend-abstraction.md), OpenClaw has its own approval RPC surface (observed present but off by default on the build that document was written against). Banter itself neither shows you the request nor gets in its way.

This is a deliberate omission, not an oversight. Tool-permission approval design is still evolving, and a hastily built gate in a voice interface — where the "confirm" step has to work by ear, under time pressure, against a spoken command that may be ambiguous — would be insecure and could let real damage through while giving a false sense of safety. Building one properly is a real design problem this repository does not attempt to solve.

If your harness needs approvals, build your own gate against it — don't assume voice input into this repo carries any protection. Two working references, cited because they've actually built the mechanism rather than sketched it:

- **[Cicero](https://github.com/5uck1ess/cicero)** — a voice daemon carrying a single agent over ACP. Its `src/brain/acp.ts` implements a fail-closed tool-permission confirmation gate: a request to run something risky is held pending a spoken yes, and the default on ambiguity is to refuse rather than proceed.
- **[Grimoire](https://github.com/sandsaber/Grimoire)** — an Obsidian plugin carrying ten agents over ACP. It takes a different approach: a session-level mode (ask before writes, auto-approve, plan-first) rather than per-call risk classification, surfacing ACP's own `permissionOptions` to the user.

Neither is a drop-in for Banter — both assume a UI or an interaction model Banter doesn't have — but both are real, running code for the mechanism, worth reading before inventing your own.
