# Tool call handling

*How tool activity reaches the chat transcript and the voice pipeline. Validated against OpenClaw 2026.7.1, protocol v4. Not re-verified against 2026.8.1 (`ea80657`).*

Read [`gateway-tool-and-message-events.md`](gateway-tool-and-message-events.md) first — it carries the stream model and the wire measurements this document depends on.

---

## The signal

Tool activity arrives on two structured streams: `agent` events with `stream: "tool"`, which are run-scoped, and `session.tool`, which is the session-scoped mirror. Both carry `phase: "start" | "end"`, `toolCallId`, `name` and `args`.

The dashboard subscribes to both. `GatewayConnection` exposes `addAgentEventListener` and `addSessionToolListener` (`dashboard/src/lib/gateway-connection.ts`), wired up in `session-manager.ts`. `Session.applyAgentEvent()` and `Session.applySessionToolEvent()` (`dashboard/src/lib/session.ts`) pass each payload through the normalizers in `run-state.ts`, which turn the two shapes into one `RunEvent` of `kind: 'tool'` carrying `runId`, `phase`, `toolCallId`, `name` and `isError`. Normalized events are ingested by `Conversation`, the single source both chat and voice read.

Text streaming is unaffected. `chat` drives playback; only the tool signal travels this path.

## Voice: flushing at the tool boundary

`TurnManager` subscribes to conversation events and, on a tool event with `phase === 'start'`, calls `chunker.recommendFlush()` (`dashboard/src/lib/voice/turn-manager.ts`). Speech buffered up to that point is spoken rather than held while the tool runs.

There is no resume on `phase === 'end'`, and tool activity is never spoken — a tool call affects *when* speech flushes, not what is said.

## Chat: tool cards

`ToolCard` (`dashboard/src/features/chat/tool-card.tsx`) renders one call with a status icon — running, done, interrupted, error, unknown — and collapses its arguments. `ToolRunGroup` groups consecutive cards, and `message-list.tsx` treats a maximal run of adjacent tool-card items as one group.

Cards are fed from `Conversation` (`kind: 'tool-card'`), so chat and voice share one source of truth. Reloading a session takes a separate path: `conversation.ts` parses `toolCall` / `tool_use` blocks out of `chat.history`, because the live streams do not replay.

## Why the streams, given the timing

Measured over 22 tool calls, `stream: "tool"` leads `session.message` by a mean of 7ms, so it gives no latency advantage. The real pause sits *after* tool end, before the next chat delta.

The structured streams are the right source on correctness grounds. `session.message` is full-state with earlier blocks rolling out, so a call can be missed entirely, and it carries no `end` signal. `stream: "tool"` gives an explicit `phase` and a stable `toolCallId`. No transcript-scraping fallback is kept for the live signal.

## Still unverified

Two claims in the wire doc remain `[SOURCE]` rather than `[WIRE]`, because no capture has triggered them:

- **`stream: "patch"` for file-change summaries.** The file-edit scenario produced `write` and `edit` tool events but no `patch` stream event. Either it needs a different edit path, or the claim is wrong.
- **Approvals.** Approval prompts are not on the chat stream, and the capture scenarios never triggered one.

The probe that produced these captures lives at `control/probe/` — see its README for pairing and scenario runs.
