# Agent Backend Abstraction (ACP) — Design

**Stage: explore/design.** Feasibility analysis and architectural sketch. Not a build plan or a spec; no code exists.

The tool-permission approval layer (item 5 below) is buildable on its own, against OpenClaw's gateway, with no ACP work.

Wire-level detail for the backends named here lives with the protocol notes, not in this document: [`docs/gateway/openclaw/`](../../docs/gateway/openclaw/) for what Banter speaks today, and [`docs/gateway/opencode/opencode-server-protocol.md`](../../docs/gateway/opencode/opencode-server-protocol.md) for a second server it could attach to.

---

## The question

Banter's README calls it adaptable to other agent harnesses. What that costs is the question here. The dashboard talks to exactly one backend today: an OpenClaw gateway, over a WebSocket the **browser dials directly**. Could it talk to Claude Code, Codex, Gemini CLI and the rest through [ACP](https://agentclientprotocol.com) (Agent Client Protocol), the way [`5uck1ess/cicero`](https://github.com/5uck1ess/cicero) does?

Three implementations inform what follows, and they disagree usefully. Cicero is a voice daemon carrying a single agent over ACP, which makes it the closest analogue to Banter and the best source for turn admission and approval mechanics. [`sandsaber/Grimoire`](https://github.com/sandsaber/Grimoire) is an Obsidian plugin carrying ten, which makes it the evidence for where the seams belong once more than one agent is in play, and for what stdio ACP can be made to do about session durability. OpenCode is neither a client nor a reference — it is an agent that ships its own HTTP server, and it is the case that shows ACP is not the only door.

**That last point reframes the question.** ACP is a transport into an agent, not the abstraction itself. Where an agent offers a native server that accepts clients, attaching beats spawning it over stdio, and you pay ACP's cost — subprocess ownership, a server-side host, a session with one client — only for agents that offer nothing else. The stable centre is Banter's own `RunEvent` shape, and every backend translates into it: ACP for agents that need it, a native client for agents that do not.

## Effort calculus: an integration, not a build

**Almost none of this is unsolved-problem work.** Working implementations cover nearly all of it — Cicero's `src/brain/acp.ts` for the ACP half, and Banter's own `run-state.ts`/`RunEvent`/`conversation-store.ts` chain for the schema half, which already does this job for OpenClaw. What remains is an integration against known-working code, plus a refactor of Cicero's bundled class into separated layers.

Genuinely new work, small in scope:

- The control-plane route or process that constructs and owns an adapted ACP brain per session, and whatever carries its output to the browser. Wiring, not new mechanism. An agent reached through its own server needs none of it.
- The dashboard-side branch that picks which adapter a session uses.
- One frame-parsing function per backend (ACP's `SessionUpdate` → `RunEvent`, or OpenCode's `message.part.*` → `RunEvent`), against schemas already read and a target shape that is already correct.

Everything else — subprocess spawn, handshake, restart, cancel, turn admission and serialization, the tool-permission approval gate — has a working port source in Cicero. "Not in Banter's codebase yet" and "unsolved problem" are different claims. The unbundling is real effort, but it restructures correct logic into cleaner boundaries with a reference to refactor *from*.

## What ACP actually is

Built by Zed (the code editor company) to decouple editors from agents the way LSP decoupled editors from language tooling. JSON-RPC over stdio; one side is the **client** (the thing holding the conversation — an editor, or a voice daemon), the other is the **agent** (the thing doing the coding). Spun out to an independent spec/org (`agentclientprotocol.com`) with SDKs in five languages. Native support is broad — Gemini CLI, OpenClaw, Hermes, Cursor, GitHub Copilot, Qwen Code, and two dozen more speak it directly. Claude Code and Codex don't speak it natively; they're bridged via adapter packages (`claude-code-acp`, maintained by Zed, wraps the Claude Agent SDK directly — not a CLI shell-out).

Speaking ACP is not one capability, and a client carrying several agents finds this out quickly. Grimoire's provider contract declares support across roughly a dozen independent axes — persistent runtime, native history, plan mode, rewind, fork, provider commands, image input, MCP tools, turn steering, reasoning control — and its ten agents differ on most of them. OpenCode supports native resume and compaction but neither fork nor rewind; only Claude Code offers rewind. Capability negotiation is therefore a real design surface for any multi-backend client, not a formality: the UI has to degrade per agent rather than assume a floor.

Confirmed against the ACP JSON schema (`schema/v1/schema.json` in the spec repo): the wire protocol carries more than Cicero's implementation uses. The `SessionUpdate` union includes `tool_call` / `tool_call_update` as first-class kinds — a `ToolCall` object carries `toolCallId`, `title`, `kind` (for icon/UI treatment), `status`, `content` (text, file diff, or embedded terminal), and `locations` (files touched) — plus `agent_thought_chunk` and `plan` kinds with no OpenClaw equivalent. Cicero's `AcpBrain` consumes only `agent_message_chunk` (sensible for a voice product: tool activity becomes spoken narration, not a UI card) and discards every other update kind. If Banter wants dashboard parity for tool cards on an ACP backend, that data is on the wire already — a second `sessionUpdate` handler branch, not a protocol gap.

## The one hard constraint — of stdio, not of ACP

A browser tab cannot spawn a subprocess or read/write its stdio — sandboxed at the browser level, not a choice anything here makes. So whatever code speaks ACP **over stdio** has to run server-side — inside the control plane, or a sibling process it manages — regardless of what protocol then carries data on to the browser (that choice doesn't matter for this design).

The constraint belongs to the transport, and that distinction decides whether an ACP backend can ever be a peer to the OpenClaw path or is permanently lesser. ACP defines transports separately from the protocol: stdio is the only finalized one, and it does require spawning — *"The client launches the agent as a subprocess."* But a **Streamable HTTP and WebSocket transport** is an active RFD (Transports Working Group, spec complete, reference implementation under way in Goose, SDK support planned), written precisely so a client can connect to a long-running agent server over the network instead of spawning one, with sessions that *"persist on the server independently of any one connection."* The spec also carries `session/list` for discovering existing sessions and a session-resume mechanism. The protocol is moving toward attachment; it just hasn't arrived.

So building an ACP adapter **today** means stdio, spawn-ownership and a server-side host. "ACP agents only speak stdio" would be wrong, and would rule out an ACP backend that attaches rather than owns.

**Spawn-ownership does not imply the session dies with the process.** `session/load` and `session/list` are on the stdio surface today and have a working consumer: [`sandsaber/Grimoire`](https://github.com/sandsaber/Grimoire), an Obsidian plugin wrapping ten agent CLIs, spawns a subprocess per conversation yet persists the agent's `sessionId` and rebinds it to a fresh process with `loadSession`. The session state lives in the agent's own store — for OpenCode a `databasePath` the plugin records but does not own — so process death is recoverable rather than terminal. Its recovery path is careful in a way worth copying: when `loadSession` fails it does not parse the error text to decide what happened, it calls `session/list` and checks whether the agent still lists the session. Confirmed missing means clear the binding and open a fresh session; anything else propagates with the binding intact, so a transient failure never silently discards a live session.

This is resume rather than attachment: a session survives its process, but still admits one client at a time.

What remains unsettled **for ACP** is whether *multiple clients* may hold one session concurrently. The RFD provides for sessions outliving a single connection, but does not clearly say two clients can hold the same session at once — which is the property OpenClaw's gateway gives Banter today, and the thing that lets voice share a session with another client rather than starting its own. Grimoire does not answer it either: one subprocess per conversation, serial turns. Worth confirming before treating ACP-with-attachment as equivalent.

It is settled for OpenCode, which is why ACP should not be the universal path. OpenCode's server broadcasts its event stream to every subscriber, scoped only by directory, with no session ownership and no per-client identity, so a second client sees the first client's turn — the property in question. An agent can therefore be *more* capable through its own protocol than through ACP, and choosing ACP for such an agent gives up attachment that already exists.

This is a *new* responsibility for Banter's server, not a missing feature of it. Checked directly: `control/control-plane/src` has zero subprocess-spawning code and zero code that owns a live agent-facing connection today. `GET /api/gateway` hands the browser `{ url, token }` once at page load; after that the browser's `GatewayConnection` (`dashboard/src/lib/gateway-connection.ts` — the browser's own gateway client) opens the WebSocket to OpenClaw itself and speaks `chat.send` and friends directly, peer to peer. The control plane is a real, capable server — it's just never been in this particular loop, because OpenClaw's gateway is browser-dialable and nothing forced the issue.

Cicero doesn't hit this problem because it isn't browser-first: it's a Bun daemon that owns the ACP subprocess itself and exposes its *own* WebSocket to the browser, which only ever sees audio frames and JSON control messages, never ACP JSON-RPC. That's the shape Banter would need to add: move (or duplicate, per-backend) connection ownership into the server, and have the browser talk to that instead of dialing the agent directly.

### What spawn-ownership costs, observed

From running Cicero against Claude Code (2026-09-02, torn down after):

- **It cannot attach to a session you are already in.** Its two modes are daemon (bidirectional voice, always spawns its own agent) and sidecar (attaches to a running Claude Code session via a Stop hook, but is *output-only* — it speaks replies and has no microphone path). There is no mode that talks to an agent session already running in your terminal. That is a direct consequence of stdio: the subprocess has exactly one client, so the only seam a live session exposes is a completion hook.
- **The spawn is invisible.** `bun x @zed-industries/claude-code-acp` fetched a package from npm at first launch and ran an agent with cwd `/Users/arvind` — the whole home directory. The only startup output was `ACP brain connected (bun) session=<id>`, which names neither the package, nor Claude Code, nor the working directory. Whatever Banter builds should state an agent's scope at launch, unmissably.
- **Paseo (`paseo.sh`) makes the same choice and is honest about it** — it is a control plane, spawns agents into git worktrees for isolation, and treats voice as one input among many.
- **Grimoire spawns too, and scopes the spawn properly.** It launches into the Obsidian vault, names the provider in its UI, and keeps per-provider configuration under `.grimoire/` instead of reaching into the agent's native config. Set against Cicero's unannounced launch across an entire home directory, this is the behaviour to copy: the scope an agent is about to operate on is a thing the interface states, not a thing the user infers.

Three independent tools all spawn, because nothing built on stdio can do otherwise.

The OpenClaw path differs for one reason: the gateway is a stateful server that accepts clients, so a session is joined rather than created. No stdio ACP backend has that, but OpenCode's server does — so what separates the two groups is whether an agent ships a native server, not whether it is OpenClaw.

## What's actually new work, and what's reusable

Cicero's `src/brain/acp.ts` (~1450 lines) is not a reference to reimplement — it's a working implementation of the exact server-side piece described above: process spawn/reap, `initialize`/`newSession` handshake, streamed replies, cancellation-with-restart-on-stuck-session, and a fail-closed tool-permission gate. ACP itself (the npm package) only supplies transport and typed message shapes, the same way an LSP client library supplies framing but not "what VS Code does with a diagnostic" — every consumer (Zed, Cicero, Banter) still writes the application logic on top. That application logic is what `acp.ts` is, and it's the part that's substantially portable.

What has no existing code to adapt from — genuinely original, Banter-specific
integration work:

1. **A control-plane route that owns an ACP child process per session** — spawn, handshake, hold it, wired into Banter's own control-plane structure. No file in `control/control-plane/src` does anything like this today, and it's specific enough to Banter's session model that Cicero's equivalent (`web-voice/server.ts`) is a shape reference more than a port.
2. **Mapping Banter's session identity onto ACP's.** OpenClaw's `sessionKey`/`agentId` scheme isn't ACP's `sessionId`. Something has to decide per lane which backend a session uses and translate accordingly.
3. **Dashboard-side branch** in `gateway-context.tsx` — for an ACP-backed lane, talk to the new control-plane route instead of constructing `GatewayConnection` directly. `dashboard/src/lib/prompts/index.ts` is a second call site to account for.

What looks new to Banter's codebase but already has a working reference to
port from — **not original problem-solving, an adaptation exercise**:

4. **Turn admission/serialization.** Banter's dashboard has no connection-level turn lock today — `isStreaming`/`disabled` in `chat-composer.tsx` is a UI courtesy (grey out the send button) in React state, not enforced at the transport. That's safe currently only because OpenClaw's *own server* absorbs concurrency (stateful, multi-client-aware, queues `sessions.send` during an active run per the protocol doc) — so nothing in Banter's client code has ever needed to prevent a race. An ACP session has exactly one client (whatever server-side code Banter writes to own it), and ACP itself defines no queuing semantics for concurrent callers — a second `conn.prompt()` mid-turn just happens, undefined interleaving. But this exact problem is already solved: Cicero's `turnLock` (a promise chain), `pendingReservations` (admission cap), and `ChunkQueue` (per-turn bounded output queue) are a working answer, ready to port rather than design.
5. **Tool-permission approval policy** — the fail-closed confirm gate (`confirmGate`/`confirmationGrant`/nonce lifecycle in `acp.ts`). Product decisions already made and implemented; adopting them, not inventing them.

   The weakness: `confirmGate`'s *policy* is a flat, hand-maintained substring list with no feedback loop — no near-miss logging, no incident record, silent false negatives on any rewording. The mechanism ports and the maintainability problem ports with it. Worth checking whether pluggable, structured tool-call risk classification exists already before re-deriving a static list.

   Grimoire declines the problem entirely: it classifies nothing per call, offering a session-level mode (ask before writes, auto-approve, plan-first) and passing ACP's `permissionOptions` to the user, its approval module translating a chosen answer back into an option id. Three implementations, no risk classifier among them — consistent with ACP never putting the deciding signal on the wire, since a permission request carries options and a title rather than the command. Grimoire's answer also needs a user watching a dialog, which a voice turn does not have.

   **Buildable on its own, ahead of any ACP work.** OpenClaw's gateway has an equivalent RPC surface (`exec.approval.*`, `plugin.approval.*` — present and tested on the installed build, off by default and never given a client) carrying structured classification data (`SystemRunApprovalPlan`, `argv`, `cwd`) rather than a title, so it is less exposed to the substring-match failure than the ACP path, where that signal never crosses the wire. The policy half of `confirmGate` (pattern-match, one-shot grant, spoken-approval parsing) ports to OpenClaw directly. Done first, it produces the shared approval layer the bundling table below calls for, and an ACP adapter later plugs into it.

## The schema has to be the stable center, not a peer layer — and it already is, partially

The question this all rests on: can Banter's event schema — the shape the dashboard renders against — stay unchanged as backends are added, each backend reduced to an adapter translating *into* it? The schema has to be Banter-native first, with every backend, OpenClaw included, equally a translator into it. None of them gets to be the schema by default.

Two layers exist today, and they are clean:

- **The wire layer** (`dashboard/src/lib/gateway-types.ts`) — `ChatEventPayload`, `ChatSendParams`, and friends. These *are* OpenClaw's own nouns (`sessionKey`, `idempotencyKey`, `runId`, `agentId`), reused directly. This layer is expected to be backend-specific — it's the wire format, not the abstraction.
- **The Banter layer** (`dashboard/src/lib/run-state.ts`'s `RunEvent`) — a discriminated union already independent of OpenClaw's vocabulary: `{ kind: 'chat' | 'tool' | 'item' | 'lifecycle' | 'thinking' | 'compaction' | 'unknown' }`, each variant carrying only what the UI actually needs (`text`, `state`, `toolCallId`, `phase`, `title`...). `run-state.ts` already contains real adapter functions — pattern-matching raw OpenClaw frames (`session.tool` payloads, `chat` events) and constructing `RunEvent` values. `Conversation.ingest()` in `conversation-store.ts` consumes only `RunEvent`, never a raw gateway frame. And the leaf components are clean: `MessageBubble`'s props are `{ role, text, isStreaming, delivery }`, `ToolCard`'s are `{ title, status: 'running' | 'done' | 'interrupted' | 'error' | 'unknown' }` — zero OpenClaw nouns reach the render layer at all.

So the messages and tool calls the UI renders are **already an abstraction of OpenClaw's events at the `RunEvent`/component layer**, and could be an abstraction of anyone's — before any ACP work starts. It was not built for multi-backend support and has the right shape anyway.

What doesn't exist yet, and is the actual gap: **a second function alongside `run-state.ts`'s OpenClaw-frame parser that does the same job from ACP's `SessionUpdate` frames** — reading `agent_message_chunk` into `{ kind: 'chat', state: 'delta', text }`, `tool_call`/`tool_call_update` into `{ kind: 'tool', phase, toolCallId, name }`, and so on. `RunEvent`'s shape may need to grow slightly (a `kind: 'plan'` or `kind: 'thought'` for ACP's `plan` and `agent_thought_chunk` updates, which have no OpenClaw equivalent) — expected schema growth, not the dashboard learning to branch on backend identity. The test for whether this stays true: **adding the ACP adapter should mean a new frame-parsing function next to the existing one in `run-state.ts` (or a sibling module doing the same job), never a change to `conversation-store.ts`, `MessageBubble`, or `ToolCard`.** If any of those three end up needing to know which backend produced an event, the abstraction has leaked.

The genuinely open part isn't "should the schema be neutral" — it already is, mostly, at this layer — it's **how far down the stack that neutrality should be pushed.** Right now the *inputs* to the adapter (OpenClaw's WebSocket frames) still arrive straight into the browser via `GatewayConnection`; an ACP adapter's input (an ACP process's stdout) can only arrive into whatever server-side code owns that process. So the adapter boundary for ACP sits in a different physical location — server-side, feeding events across the new control-plane-to-browser hop — than the adapter boundary for OpenClaw, which sits client-side inside `run-state.ts`. Both need to land on the same `RunEvent` shape at the point the dashboard consumes it; where the parsing code itself executes differs because of the browser/subprocess constraint, not because the abstraction is any less real for one backend than the other.

## The bundling problem, and how to not import it

`AcpBrain` in Cicero bundles five separable concerns into one class with shared private state (`this.turnLock`, `this.confirmationGrant`, `this.runtime`, …): process lifecycle, wire transport, turn admission, tool-permission policy, and confirmation-state tracking (nonces, grants, spoken-approval parsing), one file, no interface boundary between them.

For Cicero — single product, one deployment shape, no plugin ambitions — that coupling is a defensible simplification: the confirm gate needs the turn lock (a retry must land in the *next* turn slot), and restart-on-stuck-cancel needs to reach turn state directly. Cramming things that need to see each other's state into one file avoids an interface tax with only one consumer.

**Banter shouldn't import that bundling**, for three reasons specific to what Banter wants that Cicero doesn't:

1. Banter wants a plugin seam like deepseek-harness's ("everything is a plugin") — see the backlog entry. That only works if tool-permission decisions, turn admission, and cancel/barge-in behavior are separately addressable, not private fields inside one class a plugin can't reach.
2. Turn admission is *general* session management, not ACP-specific — it's only "new" for Banter because OpenClaw currently hides it. Unbundled, it becomes one control-plane component every backend uses, not something reinvented per backend.
3. The approval-policy gate (deny `git push`/`rm -rf` until a spoken yes) is product policy independent of transport. Bundled into an ACP-only class, a second backend re-derives the same policy from scratch.

A natural unbundling, mapped against what's actually inside `acp.ts`:

| Layer | Owns | Cicero's version | Backend-specific? |
|---|---|---|---|
| Transport | spawn or dial, handshake, wire framing, cancel-at-transport | `boundedNdJsonStream`, `startOwnedRuntime` | Yes — swapped per backend. Spawn-and-own for stdio ACP; dial-and-attach for a native server like OpenClaw's gateway or OpenCode's |
| Turn admission | serialize concurrent callers, queue/reject, supersede-and-abort | `turnLock`, `pendingReservations`, `ChunkQueue` | No — shared session-management concern |
| Approval policy | pattern-match risky ops, gate, spoken-confirmation window | `confirmGate`, `confirmationGrant`, nonce lifecycle | No — product policy regardless of backend |
| Event projection | raw backend event → `RunEvent`; exists for OpenClaw in `run-state.ts` and carries the abstraction | `sessionUpdate` handler → `ChunkQueue.push` (Cicero collapses this into plain text; Banter's `RunEvent` is richer) | The *input* is backend-specific (ACP's `tool_call` vs. OpenClaw's `session.tool`); the *output* is the one `RunEvent` shape every adapter targets |

If transport and event-projection are the only per-backend pieces, and admission/approval-policy are shared infrastructure every backend's events flow through, adding a third backend later (e.g. if deepseek-harness grows an ACP-compatible mode, or Banter talks to another agent's native protocol directly) means writing a transport + projection pair against existing shared layers — not re-deriving admission and approval logic a third time.

Grimoire is the counter-example to Cicero: it carries ten agents and had to separate what Cicero could afford to fuse. Its shared ACP layer holds transport, subprocess, session config, update normalization and approval plumbing, and cannot import anything provider-specific; each agent contributes its quirks through named ports rather than branches in the core. Its normalization rule is the load-bearing one: convert an ACP event into a shared shape **only when the mapping is stable across providers**, and read real wire traces rather than inferring from the schema. Everything else stays in the agent's own directory. Its execution backend for OpenCode is nearly empty — a subclass supplying a descriptor, inheriting spawn, session binding and dispatch.

The caution attached to that: the per-agent layer is not small. OpenCode's directory runs to a dozen-plus files covering its own normalization, history service, content and permission presenters, model discovery and mode handling. Most of that serves Obsidian features Banter has no use for — model-discovery UI, MCP management surfaces, plan-usage meters. Banter's equivalent should cover what a chat and voice renderer actually consumes (tool snapshots, approval prompts, history hydration) and stop there. The lesson is the port seam, not the file count.

## Open, not decided

- Exact home for the new control-plane surface (new file vs. existing route
  module) — implementation bookkeeping, not an architectural decision, punted
  to build time.
- Whether `RunEvent` needs a new variant for `plan`. Grimoire's normalizer settles the other ACP-only concepts: `agent_thought_chunk` becomes an ordinary message chunk carrying a `thinking` role, which Banter's `kind: 'thinking'` already accepts, and `tool_call`/`tool_call_update` merge into a per-id snapshot map, the shape `run-state.ts` would need anyway. `plan` has no equivalent here — Grimoire renders it as a progress stream of active and pending steps, and Banter has nowhere to put that.
- How a conversation cold-starts on an ACP backend. OpenClaw supplies `chat.history` and OpenCode's server answers `GET /session/:id/message`; ACP defines no transcript-fetch equivalent, so restoring a conversation there means reading the agent's own store, whose format differs per agent (Grimoire has a dedicated history service for OpenCode and parses `.claude/` JSONL for Claude Code). Grimoire's rule is worth adopting whatever we build: replay history only into a genuinely cold session, and **never** replay a transcript into a replacement session, which would duplicate context the agent already holds.
- What a barge-in means on a backend that absorbs rather than supersedes. Banter's turn manager assumes a new utterance cancels the run in flight, which OpenClaw's abort gives it. OpenCode's server does not: a prompt arriving mid-turn is folded into the running turn at the next step boundary, neither rejected nor started as a new turn, and the route declares no busy error to signal it. A client wanting supersede semantics has to abort and then send, which is two round-trips against a state that may have moved. Whether that is acceptable for voice, or whether it makes such backends text-only, is undecided.
- How the ACP adapter's output (produced server-side, since it has to run wherever the subprocess lives) reaches the browser as `RunEvent` values — this is the "new transport, same schema" seam described above; the transport choice itself doesn't matter, but nothing today carries `RunEvent` across a server→browser hop, only within the browser.
- Whether admission/approval-policy live in the control plane itself or a shared package under `control/shared/src` (which already holds cross-plane logic) — natural fit given precedent, not yet checked in detail.
