# Agent Backend Abstraction (ACP) — Design

**Stage: explore/design.** Feasibility analysis and architectural sketch. Not a build plan or a spec; no code exists.

The tool-permission approval layer (item 5 below) can be built on its own, against OpenClaw's gateway, with no ACP work.

Wire-level detail lives with the protocol notes: [`docs/gateway/openclaw/`](../../docs/gateway/openclaw/) for what Banter speaks today, and [`docs/gateway/opencode/opencode-server-protocol.md`](../../docs/gateway/opencode/opencode-server-protocol.md) for a second server it could attach to.

---

## The question

Banter's README calls it adaptable to other agent harnesses. This document asks what that costs. The dashboard talks to one backend today: an OpenClaw gateway, over a WebSocket the **browser dials directly**. Could it talk to Claude Code, Codex, Gemini CLI and the rest through [ACP](https://agentclientprotocol.com) (Agent Client Protocol), the way [`5uck1ess/cicero`](https://github.com/5uck1ess/cicero) does?

Three implementations inform what follows. Cicero is a voice daemon carrying a single agent over ACP — the closest parallel to Banter, and the best source for turn admission and approval mechanics. [`sandsaber/Grimoire`](https://github.com/sandsaber/Grimoire) is an Obsidian plugin carrying ten, which shows where the seams belong once more than one agent is in play, and what stdio ACP can do about session durability. OpenCode is an agent shipping its own HTTP server, reachable without ACP at all.

ACP is a transport into an agent, not the abstraction itself. Where an agent offers a native server that accepts clients, attach to it rather than spawning it over stdio. ACP's costs — subprocess ownership, a server-side host, a session with one client — are worth paying only for agents that offer nothing else. The stable centre is Banter's own `RunEvent` shape, and every backend translates into it.

## Effort

Most of this is not new work. Working implementations cover nearly all of it: Cicero's `src/brain/acp.ts` for the ACP half, and Banter's own `run-state.ts`/`RunEvent`/`conversation-store.ts` chain for the schema half, which already does this job for OpenClaw. What remains is integration against known-working code, plus a refactor of Cicero's bundled class into separate layers.

New work, small in scope:

- The control-plane route or process that constructs and owns an adapted ACP brain per session, and whatever carries its output to the browser. Wiring, not new mechanism. An agent reached through its own server needs none of it.
- The dashboard-side branch that picks which adapter a session uses.
- One frame-parsing function per backend (ACP's `SessionUpdate` → `RunEvent`, or OpenCode's `message.part.*` → `RunEvent`).

Everything else — subprocess spawn, handshake, restart, cancel, turn admission and serialization, the tool-permission approval gate — has a working port source in Cicero. The unbundling is real effort, but it restructures correct logic with a reference to refactor *from*.

## What ACP is

Built by Zed to decouple editors from agents the way LSP decoupled editors from language tooling. JSON-RPC over stdio; one side is the **client** (an editor, or a voice daemon), the other is the **agent**. Spun out to an independent spec/org (`agentclientprotocol.com`) with SDKs in five languages. Native support is broad — Gemini CLI, OpenClaw, Hermes, Cursor, GitHub Copilot, Qwen Code and two dozen more. Claude Code and Codex are bridged via adapter packages (`claude-code-acp`, maintained by Zed, wraps the Claude Agent SDK directly rather than shelling out to the CLI).

Agents that speak ACP differ widely in what they support. Grimoire's provider contract declares support across roughly a dozen independent axes — persistent runtime, native history, plan mode, rewind, fork, provider commands, image input, MCP tools, turn steering, reasoning control — and its ten agents differ on most. OpenCode supports native resume and compaction but neither fork nor rewind; only Claude Code offers rewind. Capability negotiation is therefore a design surface for any multi-backend client: the UI has to degrade per agent rather than assume a floor.

I checked the ACP JSON schema (`schema/v1/schema.json` in the spec repo). The wire protocol carries more than Cicero uses. The `SessionUpdate` union includes `tool_call` / `tool_call_update` as first-class kinds — a `ToolCall` carries `toolCallId`, `title`, `kind`, `status`, `content` (text, file diff, or embedded terminal) and `locations` — plus `agent_thought_chunk` and `plan` kinds with no OpenClaw equivalent. Cicero's `AcpBrain` consumes only `agent_message_chunk`, sensible for a voice product where tool activity becomes spoken narration rather than a UI card, and discards the rest. If Banter wants dashboard parity for tool cards on an ACP backend, that data is already on the wire; it needs a second `sessionUpdate` handler branch.

## The stdio constraint

A browser tab cannot spawn a subprocess or read its stdio. So whatever code speaks ACP **over stdio** has to run server-side, in the control plane or a sibling process it manages, regardless of what protocol then carries data to the browser.

This constraint belongs to the transport, not to ACP. ACP defines transports separately from the protocol: stdio is the only finalized one, and it does require spawning — *"The client launches the agent as a subprocess."* But a **Streamable HTTP and WebSocket transport** is an active RFD (Transports Working Group, spec complete, reference implementation under way in Goose, SDK support planned), written so a client can connect to a long-running agent server instead of spawning one, with sessions that *"persist on the server independently of any one connection."* The spec also carries `session/list` for discovering existing sessions, and a session-resume mechanism. The protocol is moving toward attachment; it has not arrived.

So building an ACP adapter **today** means stdio, spawn-ownership and a server-side host — but "ACP agents only speak stdio" would be wrong, and would rule out a future ACP backend that attaches.

**Spawn-ownership does not mean the session is lost with the process.** `session/load` and `session/list` are on the stdio surface today, with a working consumer: Grimoire spawns a subprocess per conversation yet persists the agent's `sessionId` and rebinds it to a fresh process with `loadSession`. Session state lives in the agent's own store — for OpenCode a `databasePath` the plugin records but does not own — so process death is recoverable. Its recovery path is careful: when `loadSession` fails it does not parse the error text, it calls `session/list` and checks whether the agent still lists the session. Confirmed missing means clear the binding and open a fresh session; anything else passes through with the binding intact, so a transient failure never silently discards a live session.

That is resume, not attachment: a session survives its process but still admits one client at a time.

Whether *multiple clients* may hold one ACP session concurrently is unsettled. The RFD provides for sessions outliving a single connection, but does not clearly say two clients can hold one session at once — the property OpenClaw's gateway gives Banter today, and what lets voice share a session rather than starting its own. Grimoire does not answer it either: one subprocess per conversation, serial turns. Worth confirming before treating ACP-with-attachment as equivalent.

It is settled for OpenCode, which is why ACP should not be the universal path. OpenCode's server broadcasts its event stream to every subscriber, scoped only by directory, with no session ownership and no per-client identity, so a second client sees the first client's turn. An agent can be *more* capable through its own protocol than through ACP, and choosing ACP for such an agent gives up attachment that already exists.

Owning a live agent connection is a new responsibility for Banter's server. I checked: `control/control-plane/src` has no subprocess-spawning code and no code owning a live agent-facing connection. `GET /api/gateway` hands the browser `{ url, token }` once at page load; after that the browser's `GatewayConnection` (`dashboard/src/lib/gateway-connection.ts`) opens the WebSocket to OpenClaw itself and speaks `chat.send` directly, peer to peer. The control plane has simply never been in this loop, because OpenClaw's gateway is browser-dialable.

Cicero avoids the problem because its browser is a thin client: a Bun daemon owns the ACP subprocess and exposes its *own* WebSocket, over which the browser sees audio frames and JSON control messages, never ACP JSON-RPC. That is the shape Banter would need: move connection ownership into the server, and have the browser talk to that instead of dialing the agent.

### What spawn-ownership costs, observed

From running Cicero against Claude Code (2026-09-02, torn down after):

- **It cannot attach to a session you are already in.** Its modes are daemon (bidirectional voice, always spawns its own agent) and sidecar (attaches to a running Claude Code session via a Stop hook, but output-only — it speaks replies and has no microphone path). Nothing talks to an agent session already running in your terminal. That follows from stdio: the subprocess has one client, so the only hook a live session exposes is a completion hook.
- **The spawn is invisible.** `bun x @zed-industries/claude-code-acp` fetched a package from npm at first launch and ran an agent with cwd `/Users/arvind` — the whole home directory. The only startup output was `ACP brain connected (bun) session=<id>`, naming neither the package, nor Claude Code, nor the working directory. Banter should state an agent's scope at launch, unmissably.
- **Paseo (`paseo.sh`) makes the same choice and is honest about it** — a control plane that spawns agents into git worktrees for isolation, treating voice as one input among many.
- **Grimoire spawns too, and scopes it properly.** It launches into the Obsidian vault, names the provider in its UI, and keeps per-provider configuration under `.grimoire/` rather than reaching into the agent's native config. This is the behaviour to copy.

All three spawn, because nothing built on stdio can do otherwise. The OpenClaw path differs because the gateway is a stateful server that accepts clients, so a session is joined rather than created. No stdio ACP backend has that; OpenCode's server does. What separates the two groups is whether an agent ships a native server.

## New work and reusable work

Cicero's `src/brain/acp.ts` (~1450 lines) is a working implementation of the server-side piece described above: process spawn/reap, `initialize`/`newSession` handshake, streamed replies, cancellation-with-restart-on-stuck-session, and a fail-closed tool-permission gate. The ACP npm package supplies only transport and typed message shapes, the way an LSP client library supplies framing but not "what VS Code does with a diagnostic" — every consumer still writes the application logic. That logic is what `acp.ts` is, and it is substantially portable.

No existing code to adapt from — Banter-specific integration work:

1. **A control-plane route owning an ACP child process per session** — spawn, handshake, hold it. No file in `control/control-plane/src` does this today, and it is specific enough to Banter's session model that Cicero's `web-voice/server.ts` is a shape reference more than a port.
2. **Mapping Banter's session identity onto ACP's.** OpenClaw's `sessionKey`/`agentId` scheme is not ACP's `sessionId`. Something has to decide per lane which backend a session uses and translate.
3. **Dashboard-side branch** in `gateway-context.tsx` — for an ACP-backed lane, talk to the new control-plane route instead of constructing `GatewayConnection` directly. `dashboard/src/lib/prompts/index.ts` is a second call site.

New to Banter's codebase but with a working reference to port from:

4. **Turn admission/serialization.** Banter's dashboard has no connection-level turn lock — `isStreaming`/`disabled` in `chat-composer.tsx` greys out the send button in React state, not enforced at the transport. That is safe only because OpenClaw's own server absorbs concurrency, queueing `sessions.send` during an active run, so no client code has needed to prevent a race. An ACP session has one client, and ACP defines no queuing semantics for concurrent callers — a second `conn.prompt()` mid-turn just happens, with undefined interleaving. Cicero's `turnLock` (a promise chain), `pendingReservations` (admission cap) and `ChunkQueue` (per-turn bounded output queue) are a working answer to port.
5. **Tool-permission approval policy** — the fail-closed confirm gate (`confirmGate`/`confirmationGrant`/nonce lifecycle in `acp.ts`).

   The weakness: `confirmGate`'s policy is a flat, hand-maintained substring list with no feedback loop — no near-miss logging, no incident record, silent false negatives on any rewording. The mechanism ports and the maintainability problem ports with it. Check whether pluggable, structured tool-call risk classification exists before re-deriving a static list.

   Grimoire declines the problem: it classifies nothing per call, offering a session-level mode (ask before writes, auto-approve, plan-first) and passing ACP's `permissionOptions` to the user. Three implementations, no risk classifier among them — consistent with ACP never putting the deciding signal on the wire, since a permission request carries options and a title rather than the command. Grimoire's answer also needs a user watching a dialog, which a voice turn does not have.

   **Buildable on its own, ahead of any ACP work.** OpenClaw's gateway has an equivalent RPC surface (`exec.approval.*`, `plugin.approval.*` — present and tested on the installed build, off by default and never given a client) carrying structured classification data (`SystemRunApprovalPlan`, `argv`, `cwd`) rather than a title, so it is less exposed to substring-match failure than the ACP path, where that signal never crosses the wire. The policy half of `confirmGate` (pattern-match, one-shot grant, spoken-approval parsing) ports to OpenClaw directly. Done first, it produces the shared approval layer the table below calls for.

## The schema as stable centre

Can Banter's event schema — the shape the dashboard renders against — stay unchanged as backends are added, each backend reduced to an adapter translating into it? The schema has to be Banter-native first, with every backend, OpenClaw included, a translator into it.

Two layers exist today, and they are clean:

- **The wire layer** (`dashboard/src/lib/gateway-types.ts`) — `ChatEventPayload`, `ChatSendParams` and friends. These are OpenClaw's own nouns (`sessionKey`, `idempotencyKey`, `runId`, `agentId`). This layer is expected to be backend-specific.
- **The Banter layer** (`dashboard/src/lib/run-state.ts`'s `RunEvent`) — a discriminated union already independent of OpenClaw's vocabulary: `{ kind: 'chat' | 'tool' | 'item' | 'lifecycle' | 'thinking' | 'compaction' | 'unknown' }`, each variant carrying what the UI needs (`text`, `state`, `toolCallId`, `phase`, `title`). `run-state.ts` already contains adapter functions that pattern-match raw OpenClaw frames and construct `RunEvent` values. `Conversation.ingest()` in `conversation-store.ts` consumes only `RunEvent`. The leaf components are clean: `MessageBubble`'s props are `{ role, text, isStreaming, delivery }`, `ToolCard`'s are `{ title, status }` — no OpenClaw nouns reach the render layer.

So what the UI renders is **already an abstraction of OpenClaw's events**, and could be an abstraction of anyone's, before any ACP work starts. It was not built for multi-backend support and has the right shape anyway.

The gap: **a second function alongside `run-state.ts`'s OpenClaw-frame parser doing the same job from ACP's `SessionUpdate` frames** — `agent_message_chunk` into `{ kind: 'chat', state: 'delta', text }`, `tool_call`/`tool_call_update` into `{ kind: 'tool', phase, toolCallId, name }`. `RunEvent` may need to grow a variant for ACP's `plan` and `agent_thought_chunk`, which have no OpenClaw equivalent — expected schema growth, not the dashboard branching on backend identity. The test: **adding the ACP adapter should mean a new frame-parsing function next to the existing one, never a change to `conversation-store.ts`, `MessageBubble` or `ToolCard`.** If any of those three needs to know which backend produced an event, the abstraction has leaked.

The open part is not whether the schema should be neutral — it already is at this layer — but **how far down the stack that neutrality should be pushed.** The inputs to the adapter (OpenClaw's WebSocket frames) arrive straight into the browser via `GatewayConnection`; an ACP adapter's input (a process's stdout) can only arrive into server-side code. So the adapter boundary for ACP sits server-side, feeding events across a new control-plane-to-browser hop, while OpenClaw's sits client-side in `run-state.ts`. Both land on the same `RunEvent` shape where the dashboard consumes it; only the location of the parsing code differs.

## Bundling

`AcpBrain` bundles five concerns into one class with shared private state (`this.turnLock`, `this.confirmationGrant`, `this.runtime`): process lifecycle, wire transport, turn admission, tool-permission policy, and confirmation-state tracking, in one file with no interface boundary.

For Cicero — single product, one deployment shape, no plugin ambitions — that coupling is reasonable: the confirm gate needs the turn lock (a retry must land in the *next* turn slot), and restart-on-stuck-cancel needs turn state directly. Fusing things that must see each other's state avoids an interface tax with one consumer.

**Banter should not import that bundling**, for three reasons:

1. Banter wants a plugin seam like deepseek-harness's — see the backlog entry. That needs tool-permission decisions, turn admission and barge-in behavior separately addressable, not private fields a plugin cannot reach.
2. Turn admission is general session management, not ACP-specific. It is only new for Banter because OpenClaw hides it. Unbundled, it becomes one control-plane component every backend uses.
3. The approval-policy gate (deny `git push`/`rm -rf` until a spoken yes) is product policy independent of transport. Bundled into an ACP-only class, a second backend re-derives it.

A natural unbundling, mapped against `acp.ts`:

| Layer | Owns | Cicero's version | Backend-specific? |
|---|---|---|---|
| Transport | spawn or dial, handshake, wire framing, cancel-at-transport | `boundedNdJsonStream`, `startOwnedRuntime` | Yes — spawn-and-own for stdio ACP; dial-and-attach for a native server |
| Turn admission | serialize concurrent callers, queue/reject, supersede-and-abort | `turnLock`, `pendingReservations`, `ChunkQueue` | No — shared session-management concern |
| Approval policy | pattern-match risky ops, gate, spoken-confirmation window | `confirmGate`, `confirmationGrant`, nonce lifecycle | No — product policy regardless of backend |
| Event projection | raw backend event → `RunEvent` | `sessionUpdate` handler → `ChunkQueue.push` (Cicero collapses this to plain text; `RunEvent` is richer) | Input is backend-specific; output is the one `RunEvent` shape |

If transport and event projection are the only per-backend pieces, adding a third backend means writing a transport + projection pair against existing shared layers, not re-deriving admission and approval logic again.

Grimoire is the counter-example to Cicero: it carries ten agents and had to separate what Cicero could fuse. Its shared ACP layer holds transport, subprocess, session config, update normalization and approval plumbing, and cannot import anything provider-specific; each agent contributes quirks through named ports rather than branches in the core. Its normalization rule is load-bearing: convert an ACP event into a shared shape **only when the mapping is stable across providers**, and read real wire traces rather than inferring from the schema.

The caution: the per-agent layer is not small. OpenCode's directory runs to a dozen-plus files covering normalization, history service, content and permission presenters, model discovery and mode handling. Most serves Obsidian features Banter has no use for. Banter's equivalent should cover what a chat and voice renderer consumes — tool snapshots, approval prompts, history hydration — and stop there.

## Open, not decided

- Exact home for the new control-plane surface (new file vs. existing route module) — an implementation detail, punted to build time.
- Whether `RunEvent` needs a new variant for `plan`. Grimoire's normalizer settles the other ACP-only concepts: `agent_thought_chunk` becomes a message chunk with a `thinking` role, which `kind: 'thinking'` already accepts, and `tool_call`/`tool_call_update` merge into a per-id snapshot map, the shape `run-state.ts` would need anyway. `plan` has no equivalent — Grimoire renders it as a progress stream of active and pending steps, and Banter has nowhere to put that.
- How a conversation cold-starts on an ACP backend. OpenClaw supplies `chat.history` and OpenCode answers `GET /session/:id/message`; ACP defines no transcript-fetch equivalent, so restoring a conversation means reading the agent's own store, whose format differs per agent (Grimoire has a dedicated history service for OpenCode and parses `.claude/` JSONL for Claude Code). Grimoire's rule is worth adopting: replay history only into a genuinely cold session, and **never** replay a transcript into a replacement session, which would duplicate context the agent already holds.
- What a barge-in means on a backend that absorbs rather than supersedes. Banter's turn manager assumes a new utterance cancels the run in flight, which OpenClaw's abort gives it. OpenCode's server does not: a prompt arriving mid-turn is folded into the running turn at the next step boundary, neither rejected nor started as a new turn, and the route declares no busy error. A client wanting supersede semantics has to abort and then send, two round-trips against a state that may have moved. Whether that is acceptable for voice, or makes such backends text-only, is undecided.
- How the ACP adapter's output reaches the browser as `RunEvent` values. Nothing today carries `RunEvent` across a server→browser hop, only within the browser.
- Whether admission and approval policy live in the control plane or a shared package under `control/shared/src` (which already holds cross-plane logic) — a natural fit given precedent, not yet checked in detail.
