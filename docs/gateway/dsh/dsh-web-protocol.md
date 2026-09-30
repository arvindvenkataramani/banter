# DeepSeek Harness Web Protocol Reference

How DeepSeek Harness (`dsh`) exposes a running agent to a browser client, for a client that wants to hold a voice conversation against it. dsh is a coding agent built on the Cordis plugin framework; every part of it, the agent loop included, is a plugin mounted into one context. It ships its own browser application, and the protocol that application speaks is the one a Banter adapter would either reuse or sit beside.

Source of truth: the dsh source at [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness), MIT licensed. Compiled by reading source, not the published docs at `deepseek-harness.github.io`, which describe the plugin model but leave the wire out.

*Created: 2026-09-29 · Read against commit `639ed01` (release `dsh-0.2.0-rc.2`).*

**Verify before trusting.** dsh is pre-1.0 and cutting release candidates. Its browser protocol is generated from source at build time and carries no version or stability promise, so every claim below is a claim about `639ed01`.

---

## Profiles and transports

dsh launches as a named profile: `dsh --profile <name>` or `dsh <name>`. Four of the shipped profiles matter here.

| Profile | Transport | Token-level streaming | Approvals |
|---|---|---|---|
| `web` | HTTP + one multiplexed WebSocket, on loopback | Yes | Pushed to the client, answered by it |
| `sdk` | JSON-RPC over stdio (`packages/bundle/sdk-app/src/index.ts:41`) | Not checked | Not checked |
| `acp` | Agent Client Protocol over stdio (`packages/bundle/acp-app/src/index.ts:28`) | No | One-shot `session/request_permission` |
| `headless` | One-shot runner, no server | — | — |

The ACP profile is automation-only by design. Its design note says automation clients "receive committed message, reasoning, generic tool, configuration, and usage facts rather than token deltas or structured tool UI" (`.agents/notes/implemented/simplification/2026-07-23-acp-automation-only-protocol.md:61`). A voice client needs the deltas to start speaking before the reply ends, which leaves `web`.

Runtime requirements: Node `^22.19.0 || >=24.0.0`; native sandbox packages exist for `linux-arm64`, `linux-x64`, `darwin-arm64` and `darwin-x64`.

## The web wire

The browser speaks a generated RPC layer (Typert Remote) with two carriers. Unary calls are `POST /api/<namespace>/<method>` with a `{ args }` JSON body. Streaming calls share one WebSocket at `/api/remote.mux` (`packages/api/gateway/src/stream-protocol.ts:7`), whose JSON text frames carry `{ type: 'open' | 'item' | 'end' | 'cancel' | 'error', streamId, ... }`. Host-to-client questions that the client must answer travel on a third logical stream, `$events`, with answers posted to `$events/result` (`stream-protocol.ts:10,13`).

Codecs are generated per endpoint at build time (`docs/api-gateway.md` in the dsh repo). A client not built from dsh's own `@deepseek-ai/dsh-api-remotes` package must reimplement both envelopes by hand; both are plain JSON.

### Session methods

`SessionController`, namespace `session` (`packages/api/session-controller/src/index.ts`):

| Method | Line | What it does |
|---|---|---|
| `create` | 272 | Create a session |
| `prompt` | 425 | Admit one user message. `request.mode` is `'send'` → `agent.followup(message)` or `'steer'` → `agent.steer(message)` (`commands.ts:364-365`) |
| `cancel` | 456 | `agent.cancel({ kind: 'user' }, { keepInbox: true })` — aborts the live turn and keeps queued input |
| `updateQueue` | 446 | Edit or withdraw queued messages that have not started a turn |
| `follow` | 479, stream | An opening snapshot, then durable session events and assistant-stream frames |
| `control` | 519, stream | Live-control state frames |

`followup` queues an ordinary next turn. `steer` delivers to the nearest step boundary of the running turn, or starts a turn if the agent is idle. A prompt sent mid-turn is therefore absorbed into the turn rather than superseding it; supersede semantics are `cancel` then `prompt`.

### Streamed text

`follow` interleaves durable events with `{ type: 'assistant-stream', frame }` items, wired from the host event `agent/assistant-stream` (`packages/api/session-controller/src/history.ts:120-222`). The frame union (`packages/core/agent/src/runtime-types.ts:128-161`):

```ts
| { type: 'start'; attemptId; revision; turn; step }
| { type: 'chunk'; attemptId; revision; index; time; chunk: StreamChunk }
| { type: 'end'; attemptId; revision; index;
    outcome: { kind: 'committed'; eventType: 'assistant/message' | 'assistant/attempt'; seq }
           | { kind: 'abandoned' } }
```

`StreamChunk` separates visible text from reasoning and tool calls:

```ts
| { type: 'block-start'; index; blockType }
| { type: 'text-delta'; index; text: string }
| { type: 'reasoning-delta'; index; text: string }
| { type: 'tool-call-delta'; index; id; name?; argumentsDelta: string }
| { type: 'block-end'; index; block }
| { type: 'usage'; usage }
| { type: 'finish'; reason; replayState? }
```

A TTS chunker takes `text-delta` and nothing else. Chunk frames are transient: a turn cancelled mid-stream commits its delivered prefix as an `assistant/message` with `interrupted: true` (`packages/core/session/src/types.ts:331-349`), so the transcript and the spoken audio agree about what was said.

### Turn boundaries

Durable session events carry `turn/start { turn }` and `turn/end { turn, reason }` (`packages/core/session/src/types.ts:288-301`). `reason.kind` is one of `completed`, `aborted`, `blocked`, `error`, `max-tokens`, `interrupted` or `forked`. A barge-in through `session/cancel` closes the turn as `{ kind: 'aborted', reason: { kind: 'user' } }`. `interrupted` is reserved for crash recovery and is never emitted live.

### Approvals

A tool whose `tools/pre-execute` policy returns `ask` blocks its turn on the waterfall event `approval/request` (`packages/interaction/user-approval/src/types.ts:87-91`), which the web profile forwards to the client (`packages/api/remotes/src/remote-events.ts:19`). The request carries:

```ts
{ agent; toolName: string; callId?; reason?: string;
  displayReason?: { en: string; [locale: string]: string }; signal? }
```

The answer is one of `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'` (`types.ts:32`). There is no standing grant, and no argv, cwd or risk field; a client deciding by voice has the tool name and the asker's free-text reason. `ApprovalService` sets no timeout of its own; the request resolves `cancelled` when its signal aborts. Both halves are logged to the session as `approval/asked` and `approval/decided`.

`user-questions/request` is forwarded the same way and carries structured questions with options, multi-select, and a `plan-review` intent (`packages/interaction/user-questions/src/types.ts:157-162`). A timed question left unanswered can still take a late reply, which arrives as a steered message with source `user-question-reply`.

## Reaching it from another machine

The server binds loopback. The config schema admits `'0.0.0.0'` (`packages/host/webserver/src/index.ts:126-127`), but the web CLI refuses it: "--host 0.0.0.0 is intentionally not supported yet for safety: it would expose remote code execution to the network" (`packages/bundle/web-app/src/startup.ts:74-76`). `tailscale serve` pointed at the loopback port is compatible.

Two checks guard `/api`, applied in `packages/client/connection/src/rpc-host.ts:105`:

- **Host and origin fence** (`api-request-trust.ts`). The `Host` header must be loopback or listed with `--trusted-host`. A `Sec-Fetch-Site: cross-site` request is refused. An `Origin` header, when present, must equal the request's own authority. A dashboard served from a different origin cannot call `/api` at all, whatever CORS headers say.
- **Browser authentication** (`browser-auth.ts`). dsh prints a URL carrying a per-process launch token; the first visit exchanges it for an HMAC-signed, host-bound, `HttpOnly`, `SameSite=Strict` cookie.

Only dsh's own UI, loaded from the trusted authority itself, passes both. A Banter dashboard reaches the `/api` surface only through a server-side proxy that talks to dsh on loopback.

## Plugin-owned routes

A plugin can serve its own HTTP and WebSocket endpoints through the `ctx.webServer` service (`packages/host/webserver/src/index.ts:166-218`):

```ts
register(route: WebRoute): () => void
registerUpgrade(route: WebUpgradeRoute): () => void
registerFallback(handler: WebRoute['handler']): () => void
tapIndex(transform: (html: string) => string): () => void
```

`packages/webhook/webhook-github` registers a signed endpoint this way, and dsh's own `/api/remote.mux` is a `registerUpgrade` consumer (`packages/api/gateway/src/index.ts:256-262`). The `/api` fence lives in the connection layer, not in `webServer`, so a plugin route outside `/api` carries whatever authentication its plugin gives it and nothing more.

Inside the process, such a plugin reaches the agent directly: `ctx.agents.create` / `resume` (`packages/core/agent/src/index.ts:391,410`), and on the returned agent `followup`, `steer`, `send(message, 'next-turn' | 'next-step', wakeup)`, `inject` (context for the next step, without waking), `cancel(cause, { keepInbox })` and `whenIdle()` (`runtime-types.ts:183-241`). It can listen on `agent/assistant-stream` and `approval/request` scoped to one agent.

## Existing voice support

dsh has experimental speech input under `packages/experimental/`: a provider-neutral `ctx.speechToText` service, a local SenseVoice provider, a `SpeechController` remote for the browser, and a client plugin that records the mic and inserts the transcript into the composer as an unsent, editable draft (`docs/subsystems/voice-input.md` in the dsh repo). It has no text-to-speech, no voice activity detection and no turn-taking.
