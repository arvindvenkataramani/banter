export type RunEvent =
  | { kind: 'chat'; runId: string; state: 'delta' | 'final' | 'status' | 'aborted' | 'error'; text: string; errorMessage?: string; at: number }
  | { kind: 'run-status'; runId: string; phase: string; at: number }
  | { kind: 'tool'; runId: string; phase: 'start' | 'update' | 'result'; toolCallId: string; name: string; isError?: boolean; at: number }
  | { kind: 'item'; runId: string; toolCallId: string; title: string; at: number }
  | { kind: 'lifecycle'; runId: string; phase: 'start' | 'finishing' | 'end' | 'error'; aborted?: boolean; stopReason?: string; at: number }
  // `text` is the reasoning assembled so far, not the increment — the gateway
  // sends both and the cumulative form is what a block holds.
  | { kind: 'thinking'; runId: string; text: string; at: number }
  | { kind: 'compaction'; phase: 'start' | 'end'; completed?: boolean; willRetry?: boolean; at: number }
  | { kind: 'unknown'; runId: string | null; stream: string; raw: unknown; at: number }

export type Activity = 'speaking' | 'tool' | 'thinking' | 'active' | 'idle'
