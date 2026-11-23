# Agent Backend Abstraction (ACP) — Design

**Stage: explore/design.** This is a feasibility analysis and architectural sketch, not a build plan or a spec. No code exists yet. ACP and the Claude Code adapter were last checked on 2026-11-23.

## Summary: what Banter can do with Claude Code

**Architecture assumed throughout:** one Banter server, on one machine. It serves the web app, and Claude Code runs on that same machine, spawned by the server. Shards are service-only and have no UI. Choosing which machine a session runs on is out of scope. "Another front end" below means a different program on that machine, such as the Claude Code CLI, the VS Code extension or the desktop app, that has a Claude Code session open.

The approach: the Banter server spawns the Claude Code ACP adapter ([`@agentclientprotocol/claude-agent-acp`](#claude-code-over-acp)) unchanged, one process per session, and translates the adapter's events into `RunEvent`. Banter writes the ACP client, not a Claude Code mapping.

| Scenario | Possible? | Cleanest approach | What you don't get |
|---|---|---|---|
| **1. Start a new session** | Yes, fully | `session/new` through the adapter (stable ACP) | Questions work only once Banter can render and answer forms. Permission prompts block until answered, so the session needs a mode that doesn't ask or a policy that answers. There is no mid-turn steering: interrupting means cancelling and resending. |
| **2. Continue an earlier session** (nothing else has it open) | Yes | `session/list` to find it, then `session/load` to replay its history into a fresh adapter process (both stable ACP) | Nothing beyond scenario 1. Untested for sessions the CLI or VS Code started, so test this first. |
| **3. Join a live session that the CLI, VS Code or the desktop app still has open** (and stay in sync with it) | **Not cleanly.** You can watch it and answer its questions, but you can't talk to it | Hooks: they can answer questions and permission prompts, and the transcript file shows the session's progress | You can't send it new prompts. That is the core of voice. |

Ways round scenario 3, none clean:
- **Close the other front end, then do scenario 2.** This is the simplest and is fully supported. You give the session up there to continue it here.
- **Fork it.** You talk to a copy, and the original carries on separately; see below.
- **Claude Code background sessions** (`/bg`, `claude attach`). These are the only route that might make scenario 3 genuinely possible. Whether anything besides the CLI can attach to them is untested.
- **Remote Control** does exactly this but is closed to third parties. Ruled out.

The practical upshot: start sessions in Banter, even at the desk, and scenarios 1 and 2 cover everything. Scenario 3 only arises for sessions started in another front end.

### What forking means

Forking a session creates a **new session with a new ID, whose history is a copy of the original's up to that point**. The original is not touched. From then on the two are independent: turns in one never appear in the other.

Forking is how you continue a session's context without writing to the original's transcript. That matters when another process still has the original open, because two processes writing one transcript can lose messages. A fork does **not** join the live session. Whoever has the original open won't see what you say in the fork, and you won't see what happens there.

How official it is:
- **Claude Code: first-class and documented.** `--fork-session` with `--resume <id>` in the CLI, and `forkSession: true` on resume in the Agent SDK.
- **ACP: not yet stable.** `session/fork` is a draft RFD. The adapter implements it as `unstable_forkSession`, with a known bug: it fails on a session that has never been prompted (#1497).

So it is not a hack, but through ACP it sits on an unstable method. Pin the adapter version and expect the method to change. If ACP's fork moves or breaks, the fallback is to fork outside ACP with the CLI or the SDK, then `session/load` the new ID.

The tool-permission approval layer can be built on its own, against OpenClaw's gateway, with no ACP work.

Wire-level detail lives with the protocol notes:
- [`docs/reference/protocols/openclaw/`](../../docs/reference/protocols/openclaw/): what Banter speaks today.
- [`docs/reference/protocols/opencode/opencode-server-protocol.md`](../../docs/reference/protocols/opencode/opencode-server-protocol.md): a second server Banter could attach to.
- [`docs/reference/protocols/dsh/dsh-web-protocol.md`](../../docs/reference/protocols/dsh/dsh-web-protocol.md): a third that has a native server but refuses outside clients.

---

## The question

Banter's README calls it adaptable to other agent harnesses. This document asks what that costs.

The dashboard talks to one backend today: an OpenClaw gateway, over a WebSocket the **browser dials directly**. Could it talk to Claude Code, Codex, Gemini CLI and the rest through [ACP](https://agentclientprotocol.com) (Agent Client Protocol), the way [`5uck1ess/cicero`](https://github.com/5uck1ess/cicero) does? And for Claude Code in particular, can Banter start a new session, continue an earlier one, and join one another front end has open?

Four implementations inform what follows:
- **Cicero** is a voice daemon carrying a single agent over ACP. It is the closest parallel to Banter, and the best source for turn admission and approval mechanics.
- **[`sandsaber/Grimoire`](https://github.com/sandsaber/Grimoire)** is an Obsidian plugin carrying ten agents. It shows where the seams belong once more than one agent is in play, and what stdio ACP can do about session durability.
- **OpenCode** is an agent that ships its own HTTP server, reachable without ACP at all.
- **[`@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp)** is the maintained ACP adapter for Claude Code. It decides what a Claude Code session looks like through ACP.

ACP is a transport into an agent, not the abstraction itself. Where an agent offers a native server that accepts clients, attach to it rather than spawning it over stdio. ACP's costs are subprocess ownership, a server-side host, and a session with one client. They are worth paying only for agents that offer nothing else. The stable centre is Banter's own `RunEvent` shape, and every backend translates into it.

## Effort

Most of this is not new work, because working implementations cover nearly all of it:
- **The client side of ACP:** Cicero's `src/brain/acp.ts`.
- **Claude Code's side:** the Claude Code adapter, which maps the Agent SDK onto ACP: tool calls, diffs, terminals, questions, permissions, modes, subagents and session history.
- **The schema half:** Banter's own `run-state.ts`/`RunEvent`/`conversation-store.ts` chain, which already does this job for OpenClaw.

What remains is integration against known-working code, plus a refactor of Cicero's bundled class into separate layers.

New work, small in scope:

- The control-plane route or process that spawns and owns an ACP agent per session, and whatever carries its output to the browser. This is wiring, not new mechanism. An agent reached through its own server needs none of it.
- The dashboard-side branch that picks which adapter a session uses.
- One frame-parsing function per backend: ACP's `SessionUpdate` → `RunEvent`, or OpenCode's `message.part.*` → `RunEvent`.
- A `RunEvent` variant for questions, with a path for the answer back to the agent. See [Questions and approvals](#questions-and-approvals).

Everything else has a working port source in Cicero: subprocess spawn, handshake, restart, cancel, turn admission and serialization, and the tool-permission approval gate. The unbundling is real effort, but it restructures correct logic with a reference to refactor *from*.

## What ACP is

Zed built ACP to decouple editors from agents the way LSP decoupled editors from language tooling. It is JSON-RPC over stdio. One side is the **client** (an editor, or a voice daemon), and the other is the **agent**. It has been spun out to an independent spec and org (`agentclientprotocol.com`) with SDKs in five languages.

Native support is broad: Gemini CLI, OpenClaw, Hermes, Cursor, GitHub Copilot, Qwen Code and two dozen more. Claude Code and Codex are bridged by adapter packages.

The wire `protocolVersion` is 1. A v2 schema entered Preview on 2026-11-20 and is not stable. The stable v1 schema (`schema/v1/schema.json` in the spec repo, release v1.21.2) carries:

- **Streamed content.**
  - `user_message_chunk`, `agent_message_chunk` and `agent_thought_chunk`.
  - Content blocks can be text, image, audio, resource link or embedded resource.
- **Tool calls.**
  - `tool_call` and `tool_call_update`.
  - A `ToolCall` carries `toolCallId`, `title`, an optional `name`, `kind`, `status`, `content` and `locations`.
  - `kind` is one of read, edit, delete, move, search, execute, think, fetch, switch_mode or other.
  - `status` is one of pending, in_progress, completed or failed.
  - `content` is text, a file diff, an embedded terminal, or an embedded session.
- **Plans.** `plan` sends the whole plan, and `plan_update` and `plan_removed` edit it.
- **Subagents.** `subagent_update` announces a child `sessionId`, and the child's events arrive on the same connection.
- **Compaction.** `compaction_update` reports status, and `compaction_summary_chunk` streams the summary.
- **Session state.** `usage_update` carries tokens used, the window size and an optional cost. There are also `notice`, `current_mode_update`, `config_option_update`, `session_info_update` and `available_commands_update`.
- **Requests from the agent to the client.**
  - **`session/request_permission`** offers options of kind `allow_once`, `allow_always`, `reject_once` or `reject_always`. The answer is `selected` with an option, or `cancelled`.
  - **`elicitation/create`** sends a form described by a restricted, flat JSON Schema. A field can be a string, number, integer, boolean, single-select enum or multi-select array. The answer is `accept` with the content, `decline` or `cancel`. Elicitation can also open a URL instead. A client that supports forms has to say so in `clientCapabilities.elicitation.form`.
- **Session lifecycle.**
  - `session/new`, `session/prompt`, `session/cancel`, `session/list`, `session/load`, `session/resume`, `session/close` and `session/delete`.
  - `session/load` replays a session's history as ordinary `session/update` notifications.
  - `session/fork` is still a draft.

Background work exists only in the v2 Preview: running terminals, tool calls and subagents that outlive a turn. Nothing in the spec is specific to voice beyond `audio` content blocks. What Banter needs beyond the spec goes through the extension points: `_meta` on most types, `_`-prefixed method names, and reverse-DNS capability keys.

Agents that speak ACP differ widely in what they support. Grimoire's provider contract declares support along about a dozen independent axes, and its ten agents differ on most of them. The axes are persistent runtime, native history, plan mode, rewind, fork, provider commands, image input, MCP tools, turn steering and reasoning control. OpenCode supports native resume and compaction but neither fork nor rewind; only Claude Code offers rewind. Capability negotiation is therefore a design surface for any multi-backend client: the UI has to degrade for each agent rather than assume a common floor.

Cicero's `AcpBrain` consumes only `agent_message_chunk` and discards the rest. That is sensible for a voice product where tool activity becomes spoken narration rather than a UI card. Dashboard parity for Banter needs the rest, and it is already on the wire.

## Claude Code over ACP

The adapter is `@agentclientprotocol/claude-agent-acp`, at github.com/agentclientprotocol/claude-agent-acp, under Apache-2.0. It began as Zed's `@zed-industries/claude-code-acp`, and its npm name changed twice before reaching its current one. It wraps `@anthropic-ai/claude-agent-sdk` directly rather than shelling out to the CLI. It serves v1, plus v2 as a Preview.

It publishes a release on every push (0.109.1 on 2026-11-21), so **pin a version**. Its only library export is `serveAcp`, which serves ACP over stdio, so Banter spawns the binary as Cicero does. Releases also include standalone builds that bundle the `claude` CLI.

This section comes from reading the published package (compiled `dist/`, which keeps its source comments) and the `src/*.ts` files that could be fetched. The adapter has not been run.

| Claude Code | ACP |
|---|---|
| text / thinking | `agent_message_chunk` / `agent_thought_chunk` |
| Read; Edit, Write, NotebookEdit; Bash; Glob, Grep; WebFetch, WebSearch | `tool_call` with kind `read`; `edit` (with `diff` content); `execute` (with `terminal` content, or a code block if the client has no terminal); `search`; `fetch` |
| Task/Agent, the Task* tools | kind `think`, plus `subagent_update` with the nested transcript |
| TodoWrite, TaskCreate/Update | a `plan` update, not a tool call |
| `AskUserQuestion` | a form elicitation: each question becomes a `oneOf` (single choice) or `anyOf` array (multiple choice), with an optional "Other" text field. Option previews go in `_meta["_claude/askUserQuestionOption"]` |
| permission prompts (`canUseTool`) | `session/request_permission`, with options built per tool |
| permission modes | ACP modes: `default`, `acceptEdits`, `plan`, `auto` (where settings allow it), and `bypassPermissions` (can be switched off through `_meta`) |
| ExitPlanMode | a permission request whose options choose the mode to continue in. The approved plan is sent as a `plan` update |
| slash commands, skills | `available_commands_update` |
| usage, compaction | `usage_update` (cost in USD), `compaction_update` |
| sessions | `loadSession`, plus `list`, `resume`, `fork` (unstable) and `close`. All of them are backed by the SDK's `listSessions` and Claude Code's own transcripts |

User-level hooks run inside adapter sessions, because the adapter loads user, project and local settings. Hook activity itself is not sent as an ACP event.

Two behaviours constrain Banter directly:

- **A client that does not advertise `elicitation.form` loses questions entirely.** The adapter adds `AskUserQuestion` to `disallowedTools`, so Claude cannot ask at all. The questions are not sent somewhere Banter could ignore them.
- **Permission requests arrive whatever Banter's stance on approvals is.** In `default` mode a tool call blocks on `session/request_permission` until the client answers. A Banter with no approval UX has two choices: run the session in a mode that does not ask, or answer requests by policy. Adapter issue #1489 notes that a client cannot choose the mode a new session *starts* in. That leaves `session/set_mode` straight after `session/new`, with a window in which a request can arrive first.

Open adapter issues worth tracking:
- #1489: the client can't choose a new session's starting mode.
- #1497: `session/fork` fails on a session that has never been prompted.
- #1513: cost resets to zero when a session is recreated.
- #1625: `/remote-control` on a loaded session creates a new claude.ai session instead of reattaching.
- #1580: sessions synced from another machine are hidden when the home path differs.

## The stdio constraint

A browser tab cannot spawn a subprocess or read its stdio. So whatever code speaks ACP **over stdio** has to run server-side, in the control plane or in a sibling process it manages, whatever protocol then carries data to the browser.

This constraint belongs to the transport, not to ACP. ACP defines transports separately from the protocol. Stdio is the only finalized transport, and it does require spawning: *"The client launches the agent as a subprocess."*

A **Streamable HTTP and WebSocket transport** is an active RFD (Transports Working Group, spec complete, reference implementation under way in Goose, SDK support planned). It is written so a client can connect to a long-running agent server instead of spawning one, with sessions that *"persist on the server independently of any one connection."* The protocol is moving toward attachment; it has not arrived. So building an ACP adapter **today** means stdio, spawn-ownership and a server-side host. "ACP agents only speak stdio" would still be wrong, and would rule out a future ACP backend that attaches.

**Spawn-ownership does not mean the session is lost with the process.** `session/list`, `session/load` and `session/resume` are stable on the stdio surface. Grimoire is a working consumer:
- It spawns a subprocess per conversation, yet persists the agent's `sessionId` and rebinds it to a fresh process with `loadSession`.
- Session state lives in the agent's own store. For OpenCode that is a `databasePath` the plugin records but does not own. For Claude Code it is the transcripts under `~/.claude/projects/`. Either way, process death is recoverable.
- Its recovery path is careful. When `loadSession` fails, it does not parse the error text; it calls `session/list` and checks whether the agent still lists the session. If the session is confirmed missing, it clears the binding and opens a fresh session. Anything else passes through with the binding intact, so a transient failure never silently discards a live session.

That is resume, not attachment: a session survives its process but still admits one client at a time.

Whether *multiple clients* may hold one ACP session at once is unsettled. The transport RFD provides for sessions outliving a single connection, but does not clearly say that two clients can hold one session simultaneously. That is the property OpenClaw's gateway gives Banter today, and it is what lets voice share a session rather than start its own. Grimoire does not answer the question either: it runs one subprocess per conversation, with serial turns. Confirm this before treating ACP-with-attachment as equivalent.

It is settled for OpenCode, which is why ACP should not be the universal path. OpenCode's server broadcasts its event stream to every subscriber, scoped only by directory, with no session ownership and no per-client identity, so a second client sees the first client's turn. An agent can be *more* capable through its own protocol than through ACP, and choosing ACP for such an agent gives up attachment that already exists.

Owning a live agent connection is a new responsibility for Banter's server. `control/control-plane/src` has no subprocess-spawning code and no code that owns a live agent-facing connection. `GET /api/gateway` hands the browser `{ url, token }` once at page load. After that, the browser's `GatewayConnection` (`dashboard/src/lib/gateway-connection.ts`) opens the WebSocket to OpenClaw itself and speaks `chat.send` directly, peer to peer. The control plane has never been in this loop, because OpenClaw's gateway can be dialled from the browser.

Cicero avoids the problem because its browser is a thin client. A Bun daemon owns the ACP subprocess and exposes its *own* WebSocket, over which the browser sees audio frames and JSON control messages, never ACP JSON-RPC. That is the shape Banter needs: move connection ownership into the server, and have the browser talk to the server instead of dialling the agent. The Banter server is the ACP client: it holds the session, and the web app gets its events through the server.

### What spawn-ownership costs, observed

From running Cicero against Claude Code (2026-09-02, torn down after):

- **It cannot attach to a session you are already in.** It has two modes:
  - **Daemon:** bidirectional voice, always spawning its own agent.
  - **Sidecar:** attaches to a running Claude Code session through a Stop hook, but is output-only. It speaks replies and has no microphone path.

  That is a limit of Cicero's design more than of Claude Code. See [Sessions held by another front end](#sessions-held-by-another-front-end).
- **The spawn is invisible.** `bun x @zed-industries/claude-code-acp` (the adapter's earlier name) fetched a package from npm at first launch, and ran an agent with its working directory set to the whole home directory. The only startup output was `ACP brain connected (bun) session=<id>`, naming neither the package, nor Claude Code, nor the working directory. Banter should state an agent's scope at launch, unmissably.
- **Paseo (`paseo.sh`) makes the same choice and is honest about it.** It is a control plane that spawns agents into git worktrees for isolation, and treats voice as one input among many.
- **Grimoire spawns too, and scopes it properly.** It launches into the Obsidian vault, names the provider in its UI, and keeps per-provider configuration under `.grimoire/` rather than reaching into the agent's native config. This is the behaviour to copy.

All of them spawn, because nothing built on stdio can do otherwise. The OpenClaw path differs because the gateway is a stateful server that accepts clients, so a session is joined rather than created. No stdio ACP backend has that; OpenCode's server does. What separates the two groups is whether an agent ships a native server.

### Sessions held by another front end

The use case: from Banter, start a new Claude Code session, or join one that may already have been started in the terminal, the VS Code extension or the desktop app. Every one of those front ends runs its own process over the same transcripts in `~/.claude/projects/`. What is possible depends on whether that process still has the session open.

- **A new session, or one started through Banter:** fully covered. The Banter server spawns the adapter and owns the session.
- **A session nothing else has open:** `session/list` finds it and `session/load` replays it into a fresh adapter process. This is read from the adapter's code; it is untested for sessions the CLI or VS Code started.
- **A session another front end still has open:**
  - **Hooks reach it, from any front end.** User-level hooks fire in terminal, IDE-extension and desktop sessions alike; check this for VS Code. A `PreToolUse` hook matching `AskUserQuestion` can collect the answer elsewhere and return `permissionDecision: "allow"`, with an `updatedInput` holding the original `questions` plus an `answers` object. A plain `allow` is not enough for `AskUserQuestion` or ExitPlanMode. A `PermissionRequest` hook returns `decision.behavior: "allow" | "deny"`. Together with the transcript file, that gives a sidecar that renders the session and answers its questions and permission prompts.
  - **Nothing documented lets an outside process send a new prompt into an interactive session it did not start.** For voice, that is the part that matters most. A session in this state can be watched and answered, but not driven.
  - **Resuming it is unsafe.** Two processes writing one transcript can drop messages. Fork instead (`forkSession` in the SDK, `--fork-session` in the CLI), or take the session over once the other front end has closed.
  - **Remote Control is ruled out.** It does exactly this, from claude.ai or the Claude app. But its protocol is undocumented, it offers no client API to third parties, and it accepts only claude.ai subscription auth.
  - **Claude Code background sessions are untested.**
    - `claude --bg`, `claude --resume <id> --bg` and `/bg` move a session into a background process.
    - `claude attach <id>` connects a front end to it.
    - `claude agents --json` lists background sessions with their state.

    That is a documented session that outlives any one front end. It is not documented whether anything besides the CLI can attach, the Agent SDK or the adapter for example. If something can, a session started in the CLI and moved with `/bg` becomes joinable from Banter.

Sources for the hook and session behaviour: Claude Code's [hooks](https://code.claude.com/docs/en/hooks.md), [sessions](https://code.claude.com/docs/en/sessions.md), [agent view](https://code.claude.com/docs/en/agent-view.md), [remote control](https://code.claude.com/docs/en/remote-control.md) and [Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions.md) docs. These were read through summaries, so check exact hook field names against the raw pages before coding.

### A native server that only its own UI may use

DeepSeek Harness (`dsh`) ships a native server, and it carries everything a voice floor needs:
- token-level text deltas, separated from reasoning and tool calls;
- a `steer` mode for speech arriving mid-turn;
- a cancel that records the user as its cause;
- turn ends that distinguish `completed` from `aborted`;
- approval requests pushed to the client for an answer.

Its ACP profile carries none of the deltas. By the rule above, dsh is a native-server backend.

It differs from OpenClaw and OpenCode in who may dial it. The server binds to loopback only, and a fence on `/api` refuses any request whose `Origin` differs from its `Host`. Only dsh's own UI, loaded from the same authority, gets through, so the browser cannot dial it the way it dials OpenClaw's gateway. That leaves two shapes:

- **A control-plane proxy** that talks to dsh on loopback and speaks dsh's generated RPC, with the adapter translating its frames into `RunEvent`. It needs no dsh-side code, but Banter tracks a protocol for which dsh publishes no stability promise.
- **A dsh plugin** that registers its own WebSocket through `ctx.webServer.registerUpgrade`, drives `ctx.agents` in-process, and speaks a protocol Banter defines. dsh's internal churn stops at that plugin, and the plugin becomes code Banter maintains against a pre-1.0 project.

Either way the connection is server-owned, as it is for an ACP backend, but nothing is spawned: dsh runs as its own long-lived process and sessions persist in its store.

Approval requests from dsh carry a tool name and a free-text reason, and the only grant is `allowed-once`. That puts it level with ACP in what a client can see, well short of OpenClaw's `SystemRunApprovalPlan`. dsh also forwards `user-questions/request`: structured questions, including a `plan-review` intent.

## Questions and approvals

A backend can stop mid-turn and wait on the client in two different ways:

- **A question** asks what the user wants: which option, which file, does this plan look right. ACP carries it as `elicitation/create`, Claude Code raises it with `AskUserQuestion`, and dsh sends it as `user-questions/request`. Answering grants no authority to run anything. A misheard answer costs a wrong turn, not a destructive command.
- **An approval** asks whether a specific action may run. ACP carries it as `session/request_permission`, and OpenClaw and dsh have their own RPCs. A spoken "yes" here *is* the authority, which is why Banter ships no approval UX: a confirm step that works by ear, under time pressure, against an ambiguous command would be insecure.

Plan approval sits on the boundary. Claude Code sends it as a permission request (ExitPlanMode, whose options also choose the mode to continue in). dsh sends it as a question with a `plan-review` intent.

Banter's reasons for leaving approvals out do not apply to questions, and leaving questions out has a cost on Claude Code: the adapter disables `AskUserQuestion` for a client that cannot answer forms. So questions belong in `RunEvent` as their own variant, rendered and answerable by text or voice. That variant is the first part of `RunEvent` to flow from client to backend, so its shape will set the pattern any later approval layer follows.

Approvals still have to be handled on ACP backends even without a UX for them, because the agent blocks until the client answers. The choice is between a session mode that does not ask, and a policy that answers. The approval gate below is that policy.

## New work and reusable work

Cicero's `src/brain/acp.ts` (about 1450 lines) is a working implementation of the server-side client: process spawn and reap, the `initialize`/`newSession` handshake, streamed replies, cancellation with restart when a session is stuck, and a fail-closed tool-permission gate. The ACP npm package supplies only transport and typed message shapes. That is like an LSP client library, which supplies framing but not "what VS Code does with a diagnostic": every consumer still writes the application logic. That logic is what `acp.ts` is, and it is substantially portable. The Claude Code adapter is the other half: Banter does not write any Claude Code-specific mapping.

No existing code to adapt from; this is integration work specific to Banter:

1. **A control-plane route owning an ACP child process per session.** It spawns the adapter, does the handshake and holds the process. No file in `control/control-plane/src` does this today. It is specific enough to Banter's session model that Cicero's `web-voice/server.ts` is a shape reference more than a port.
2. **Mapping Banter's session identity onto ACP's.** OpenClaw's `sessionKey`/`agentId` scheme is not ACP's `sessionId`. Something has to decide, per lane, which backend a session uses, and translate. Session listing and loading go through `session/list` and `session/load`.
3. **A dashboard-side branch** in `gateway-context.tsx`. For an ACP-backed lane, it talks to the new control-plane route instead of constructing `GatewayConnection` directly. `dashboard/src/lib/prompts/index.ts` is a second call site.
4. **Questions.** A `RunEvent` variant for elicitations, an answer path back to the agent, and UI for both text and voice. Banter must advertise `elicitation.form` only once this exists.

New to Banter's codebase, but with a working reference to port from:

5. **Turn admission and serialization.** Banter's dashboard has no connection-level turn lock. `isStreaming`/`disabled` in `chat-composer.tsx` greys out the send button in React state; nothing enforces it at the transport. That is safe only because OpenClaw's own server absorbs concurrency, queueing `sessions.send` during an active run, so no client code has needed to prevent a race. An ACP session has one client, and ACP defines no queuing semantics for concurrent callers: a second `conn.prompt()` mid-turn just happens, with undefined interleaving. Once the Banter server owns the session, nothing upstream absorbs a second prompt, from voice and typed input arriving together for example. So the race is real. Cicero has a working answer to port: `turnLock` (a promise chain), `pendingReservations` (an admission cap) and `ChunkQueue` (a bounded output queue per turn).
6. **Tool-permission approval policy:** the fail-closed confirm gate (`confirmGate`/`confirmationGrant` and the nonce lifecycle in `acp.ts`).

   The weakness: `confirmGate`'s policy is a flat, hand-maintained substring list with no feedback loop. There is no near-miss logging, no incident record, and any rewording is a silent false negative. The mechanism ports, and the maintainability problem ports with it. Check whether pluggable, structured risk classification for tool calls exists before re-deriving a static list.

   Grimoire declines the problem. It classifies nothing per call; it offers a session-level mode (ask before writes, auto-approve, plan-first) and passes ACP's permission options to the user. Three implementations, and no risk classifier among them. That is consistent with ACP never putting the deciding signal on the wire: a permission request carries options and a title, not the command. Grimoire's answer also needs a user watching a dialog, which a voice turn does not have. The Claude Code adapter's modes are the same kind of answer, at the same granularity.

   **This can be built on its own, ahead of any ACP work.** OpenClaw's gateway has an equivalent RPC surface (`exec.approval.*`, `plugin.approval.*`). It is present and tested on the installed build, but off by default and never given a client. It carries structured classification data (`SystemRunApprovalPlan`, `argv`, `cwd`) rather than a title, so it is less exposed to substring-match failure than the ACP path. The policy half of `confirmGate` (pattern-match, one-shot grant, spoken-approval parsing) ports to OpenClaw directly. Done first, it produces the shared approval layer the table below calls for.

## The schema as stable centre

Can Banter's event schema, the shape the dashboard renders against, stay unchanged as backends are added, with each backend reduced to an adapter translating into it? The schema has to be Banter-native first, with every backend, OpenClaw included, a translator into it.

Two layers exist today, and they are clean:

- **The wire layer** (`dashboard/src/lib/gateway-types.ts`): `ChatEventPayload`, `ChatSendParams` and friends. These are OpenClaw's own nouns (`sessionKey`, `idempotencyKey`, `runId`, `agentId`). This layer is expected to be backend-specific.
- **The Banter layer** (`RunEvent` in `dashboard/src/lib/run-state.ts`): a discriminated union already independent of OpenClaw's vocabulary.
  - Its kinds are `chat`, `tool`, `item`, `lifecycle`, `thinking`, `compaction` and `unknown`. Each variant carries what the UI needs (`text`, `state`, `toolCallId`, `phase`, `title`).
  - `run-state.ts` already contains adapter functions that pattern-match raw OpenClaw frames and construct `RunEvent` values.
  - `Conversation.ingest()` in `conversation-store.ts` consumes only `RunEvent`.
  - The leaf components are clean too. `MessageBubble`'s props are `{ role, text, isStreaming, delivery }` and `ToolCard`'s are `{ title, status }`, so no OpenClaw nouns reach the render layer.

So what the UI renders is **already an abstraction of OpenClaw's events**, and could be an abstraction of anyone's, before any ACP work starts. It was not built for multi-backend support and has the right shape anyway.

The gap is **a second function, alongside `run-state.ts`'s OpenClaw-frame parser, doing the same job from ACP's `SessionUpdate` frames**:

| ACP | `RunEvent` |
|---|---|
| `agent_message_chunk` | `{ kind: 'chat', state: 'delta', text }` |
| `agent_thought_chunk` | `kind: 'thinking'` (Grimoire treats it as a message chunk with a thinking role) |
| `tool_call` / `tool_call_update` | `{ kind: 'tool', phase, toolCallId, name }`, merged into a snapshot map per id, the shape `run-state.ts` needs anyway |
| `compaction_update` | `kind: 'compaction'` |
| `elicitation/create` | **new**: a question variant, with its answer path |
| `plan`, `plan_update`, `plan_removed` | **open**: see below |
| `subagent_update` | **open**: see below |
| `usage_update`, `notice`, mode and command updates | session state the UI may show, but not run events |

The new and open rows are expected schema growth, not the dashboard branching on which backend is active. The test: **adding the ACP adapter should mean a new frame-parsing function next to the existing one, never a change to `conversation-store.ts`, `MessageBubble` or `ToolCard`.** If any of those three needs to know which backend produced an event, the abstraction has leaked.

Grimoire's normalization rule applies here too: convert an ACP event into a shared shape **only when the mapping is stable across providers**, and read real wire traces rather than inferring from the schema.

The open part is not whether the schema should be neutral (it already is at this layer) but **how far down the stack that neutrality should go.** The adapter's inputs arrive in different places for each backend:
- OpenClaw's WebSocket frames arrive straight into the browser through `GatewayConnection`, so its parsing sits client-side in `run-state.ts`.
- An ACP adapter's input is a process's stdout, which can only arrive in server-side code. So the ACP boundary sits server-side, feeding events across a new hop from control plane to browser.

Both land on the same `RunEvent` shape where the dashboard consumes it; only the location of the parsing code differs.

## Bundling

`AcpBrain` bundles five concerns into one class with shared private state (`this.turnLock`, `this.confirmationGrant`, `this.runtime`): process lifecycle, wire transport, turn admission, tool-permission policy, and confirmation-state tracking. They sit in one file with no interface boundary.

For Cicero, that coupling is reasonable: it is a single product with one deployment shape and no plugin ambitions. The confirm gate needs the turn lock, because a retry must land in the *next* turn slot. Restarting on a stuck cancel needs turn state directly. Fusing things that must see each other's state avoids an interface tax when there is only one consumer.

**Banter should not import that bundling**, for three reasons:

1. Banter wants a plugin seam like DeepSeek Harness's (see the backlog entry). That needs tool-permission decisions, turn admission and barge-in behaviour separately addressable, not private fields a plugin cannot reach.
2. Turn admission is general session management, not specific to ACP. It is only new for Banter because OpenClaw hides it. Unbundled, it becomes one control-plane component every backend uses.
3. The approval-policy gate (deny `git push`/`rm -rf` until a spoken yes) is product policy, independent of transport. Bundled into an ACP-only class, it would have to be re-derived for a second backend.

A natural unbundling, mapped against `acp.ts`:

| Layer | Owns | Cicero's version | Backend-specific? |
|---|---|---|---|
| Transport | spawn or dial, handshake, wire framing, cancel at the transport | `boundedNdJsonStream`, `startOwnedRuntime` | Yes: spawn-and-own for stdio ACP; dial-and-attach for a native server |
| Turn admission | serialize concurrent callers, queue or reject, supersede and abort | `turnLock`, `pendingReservations`, `ChunkQueue` | No: a shared session-management concern |
| Approval policy | pattern-match risky operations, gate, spoken-confirmation window | `confirmGate`, `confirmationGrant`, nonce lifecycle | No: product policy, whatever the backend |
| Event projection | raw backend event → `RunEvent`, and answers back | `sessionUpdate` handler → `ChunkQueue.push` (Cicero collapses this to plain text; `RunEvent` is richer) | The input is backend-specific; the output is the one `RunEvent` shape |

If transport and event projection are the only pieces that vary by backend, adding a third backend means writing a transport and projection pair against existing shared layers, not re-deriving admission and approval logic again.

Grimoire is the counter-example to Cicero: it carries ten agents and had to separate what Cicero could fuse. Its shared ACP layer holds transport, subprocess, session config, update normalization and approval plumbing, and cannot import anything provider-specific. Each agent contributes its quirks through named ports rather than branches in the core.

The caution: the per-agent layer is not small. OpenCode's directory in Grimoire runs to a dozen-plus files: normalization, a history service, content and permission presenters, model discovery and mode handling. Most of it serves Obsidian features Banter has no use for. Banter's equivalent should cover what a chat and voice renderer consumes (tool snapshots, questions, approval prompts, history hydration) and stop there. For Claude Code the adapter already does most of it: history comes from `session/load`, not from parsing `.claude/` JSONL.

## Open, not decided

- **Where the new control-plane surface lives:** a new file or an existing route module. This is an implementation detail, left to build time.
- **The shape of the question variant in `RunEvent`, and its answer path.** This is the first part of `RunEvent` to flow from client to backend. It has to cover ACP's form schema (single and multiple choice, free text, typed fields) and dsh's `user-questions/request`, and it has to work by ear.
- **Which permission mode a Claude Code session runs in** while Banter has no approval UX, and how to close the window between `session/new` and `session/set_mode` (adapter issue #1489).
- **Whether `RunEvent` needs a variant for plans.** On Claude Code the plan is the main progress signal, because TodoWrite becomes plan updates rather than tool calls, and ACP now edits plans incrementally. Grimoire renders a plan as a progress stream of active and pending steps. Banter has nowhere to put that yet.
- **How subagents appear.** A child session's events arrive on the parent's connection. They could nest under the tool call that spawned them, or flatten into the parent's stream.
- **What barge-in means on a backend that absorbs new input rather than superseding the turn.**
  - Banter's turn manager assumes a new utterance cancels the run in flight, which OpenClaw's abort gives it.
  - OpenCode's server does not. A prompt arriving mid-turn is folded into the running turn at the next step boundary, neither rejected nor started as a new turn, and the route declares no busy error. A client wanting supersede semantics has to abort and then send: two round-trips against a state that may have moved. Whether that is acceptable for voice, or makes such backends text-only, is undecided.
  - dsh offers both behaviours explicitly. `steer` absorbs at the next step boundary, and `cancel` with `keepInbox` aborts while keeping queued input, so a dsh-side plugin could supersede in one in-process step.
  - Through the Claude Code adapter, `session/cancel` then `session/prompt` is the only route; its v2 Preview has no steering yet (issue #1498).
- **How the ACP adapter's output reaches the browser as `RunEvent` values.** Nothing today carries `RunEvent` across a hop from server to browser, only within the browser.
- **Whether admission and approval policy live in the control plane or in a shared package** under `control/shared/src`, which already holds cross-plane logic. Precedent makes the shared package a natural fit, but this has not been checked in detail.
- **Two things to test before designing "join an existing session":**
  - whether `session/load` through the adapter works for a session the CLI or VS Code started;
  - whether anything besides the CLI can attach to a Claude Code background session.
