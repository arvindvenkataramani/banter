// Chat launch intent — a single-shot in-memory channel between a button
// click on the home page (or anywhere else) and the chat page that opens
// next.
//
// Usage:
//   1. Click handler builds an opening message via renderPrompt() and
//      calls setPendingChatLaunch({ openingMessage, source }).
//   2. Click handler calls navigate('/chat').
//   3. ChatPage on mount calls consumePendingChatLaunch() once. If the
//      result is non-null, it resets the active session (gateway /new)
//      and sends the opening message as the user's first turn.
//
// The ref is module-level mutable. That's fine for a strictly single-shot
// channel: set immediately before navigation, consumed by the next mount,
// nulled in the same call. Tests can set + consume directly.

export interface ChatLaunchIntent {
  /** The fully-rendered opening message body, sent as the user's first turn. */
  openingMessage: string
  /** A short identifier for the source button (debugging / future telemetry). */
  source: string
}

let pending: ChatLaunchIntent | null = null

export function setPendingChatLaunch(intent: ChatLaunchIntent): void {
  pending = intent
}

/** Returns the pending intent (if any) and clears it. */
export function consumePendingChatLaunch(): ChatLaunchIntent | null {
  const i = pending
  pending = null
  return i
}

/** Test helper. Production code should use the consumer to read state. */
export function __peekPendingChatLaunch(): ChatLaunchIntent | null {
  return pending
}
