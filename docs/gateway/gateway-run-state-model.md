# Gateway run-state model

How Banter turns the gateway's `agent` and `chat` event streams into a per-run state a UI (or the voice loop) can react to. Implemented in `dashboard/src/lib/run-state.ts`; consumed by `dashboard/src/lib/voice/turn-manager.ts`. See `gateway-tool-and-message-events.md` for why `session.message` alone isn't a reliable execution trace, and `openclaw-gateway-protocol.md` for the wire-level event shapes this normalizes.

## Why a separate model

`session.message` is a transcript/output projection, not reliable execution telemetry — it can arrive late, roll out full-state (so an intermediate call is never seen on its own), and carries no explicit end signal for a tool call. `agent` events (`stream: "tool"`, `"lifecycle"`, `"thinking"`, `"item"`, …) are the structured signal for what the run is doing right now. `RunState` is Banter's reducer over both, updated on every event via `reduceRunEvent`.

## Shape

```ts
interface RunState {
  runActive: boolean
  runId: string | null
  activity: 'speaking' | 'tool' | 'thinking' | 'active' | 'idle'
  openTools: ReadonlyMap<string, ToolMark>
  marks: ReadonlyArray<ToolMark>
  text: string
  seenToolPhases: ReadonlySet<string>
}
```

`activity` is derived, not stored independently — `tool` whenever `openTools` is non-empty, `speaking` on a chat delta, `thinking` on a `thinking` event, else `active` while a run is live, `idle` otherwise.

## Transitions

- A chat delta or a `lifecycle: start` event for a new `runId` begins a run (`initialRunState` reset with that `runId`).
- `tool: start` opens a `ToolMark`; `tool: result` closes it (`isError` distinguishes `done` from `error`). Phases are deduplicated per `toolCallId:phase` via `seenToolPhases`, since the gateway can redeliver.
- `item` events attach a display `title` to an already-open tool mark.
- Chat deltas accumulate into `text`.
- Ending a run (`endRun`) clears `runActive` and `openTools`, and marks any tools still open as `interrupted`.

## What ends a run — and what doesn't

A run ends only on a chat terminal (`final` / `aborted` / `error`) or a `lifecycle: end` / `error` event — both call `endRun`. But **only the chat stream drives TTS finish authority** in `turn-manager.ts`. `lifecycle: end` means execution stopped; it carries no guarantee the chat stream has finished delivering text. In practice `lifecycle: end` has been observed arriving 30-60ms before the trailing chat delta/final of the same run — treating it as a speech-finish trigger drops the last few words of the response. `tool: start` is the one thing besides a chat terminal allowed to affect speech: it recommends an immediate flush, so voice doesn't stall waiting on chunker heuristics while a tool runs. Every other stream (`lifecycle`, `item`, `thinking`, `compaction`, `unknown`) is deliberately never wired to the flush/finish path.

## Ordering and reconnect

Two independent sequence spaces: the outer WebSocket `seq` (resets on reconnect) and `agent.payload.seq` (per `runId`). The reducer doesn't currently do gap detection itself — `unknown` events (unrecognized `stream` values) pass through and only affect `activity`, never the finish/flush path, so an unfamiliar event can't silently break either.
