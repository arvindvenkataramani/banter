import type { ChatEventPayload } from './gateway-types'

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

export interface ToolMark {
  toolCallId: string
  name: string
  title?: string
  textOffset: number
  status: 'running' | 'done' | 'interrupted' | 'error'
}

// One reasoning block. `markCount` is how many tool marks existed when the
// block opened, which is what orders it against them: a block that opened
// before any tool call renders above the cards, one that opened after two
// renders below them.
export interface ThinkingBlock {
  text: string
  markCount: number
}

export interface RunState {
  runActive: boolean
  runId: string | null
  activity: Activity
  openTools: ReadonlyMap<string, ToolMark>
  marks: ReadonlyArray<ToolMark>
  text: string
  thinking: ReadonlyArray<ThinkingBlock>
  seenToolPhases: ReadonlySet<string>
}

export const initialRunState: RunState = {
  runActive: false,
  runId: null,
  activity: 'idle',
  openTools: new Map(),
  marks: [],
  text: '',
  thinking: [],
  seenToolPhases: new Set(),
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null
}

export function normalizeAgentEvent(payload: unknown, at: number): RunEvent | null {
  if (!isRecord(payload)) return null

  const stream = payload.stream
  const runId = typeof payload.runId === 'string' ? payload.runId : null
  const sessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey : null
  const data = isRecord(payload.data) ? payload.data : {}
  const hasIdentity = runId !== null || sessionKey !== null

  if (typeof stream === 'string') {
    switch (stream) {
      case 'tool': {
        const phase = data.phase
        if (
          runId &&
          (phase === 'start' || phase === 'update' || phase === 'result') &&
          typeof data.toolCallId === 'string' &&
          typeof data.name === 'string'
        ) {
          return {
            kind: 'tool',
            runId,
            phase,
            toolCallId: data.toolCallId,
            name: data.name,
            isError: typeof data.isError === 'boolean' ? data.isError : undefined,
            at,
          }
        }
        break
      }
      case 'lifecycle': {
        const phase = data.phase
        if (runId && (phase === 'start' || phase === 'finishing' || phase === 'end' || phase === 'error')) {
          return {
            kind: 'lifecycle',
            runId,
            phase,
            aborted: typeof data.aborted === 'boolean' ? data.aborted : undefined,
            stopReason: typeof data.stopReason === 'string' ? data.stopReason : undefined,
            at,
          }
        }
        break
      }
      case 'item': {
        if (runId && data.kind === 'tool' && typeof data.toolCallId === 'string' && typeof data.title === 'string') {
          return { kind: 'item', runId, toolCallId: data.toolCallId, title: data.title, at }
        }
        break
      }
      case 'thinking': {
        if (runId) return { kind: 'thinking', runId, text: typeof data.text === 'string' ? data.text : '', at }
        break
      }
      // 2026.8.1: a run announces its preparation before generating anything —
      // preparing_workspace, preparing_context, starting_model. On a cold
      // local model this is the longest silent stretch of a run, so it is the
      // stretch the activity indicator most needs to cover.
      case 'run_status': {
        if (runId && typeof data.phase === 'string') {
          return { kind: 'run-status', runId, phase: data.phase, at }
        }
        break
      }
      case 'compaction': {
        const phase = data.phase
        if (phase === 'start' || phase === 'end') {
          return {
            kind: 'compaction',
            phase,
            completed: typeof data.completed === 'boolean' ? data.completed : undefined,
            willRetry: typeof data.willRetry === 'boolean' ? data.willRetry : undefined,
            at,
          }
        }
        break
      }
    }
    if (!hasIdentity) return null
    return { kind: 'unknown', runId, stream, at, raw: payload }
  }

  if (!hasIdentity) return null
  return { kind: 'unknown', runId, stream: String(stream), at, raw: payload }
}

export function normalizeSessionToolEvent(payload: unknown, at: number): RunEvent | null {
  if (!isRecord(payload)) return null

  const runId = typeof payload.runId === 'string' ? payload.runId : null
  const sessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey : null
  const source = isRecord(payload.data) ? payload.data : payload
  const phase = source.phase

  if (
    runId &&
    (phase === 'start' || phase === 'update' || phase === 'result') &&
    typeof source.toolCallId === 'string' &&
    typeof source.name === 'string'
  ) {
    return {
      kind: 'tool',
      runId,
      phase,
      toolCallId: source.toolCallId,
      name: source.name,
      isError: typeof source.isError === 'boolean' ? source.isError : undefined,
      at,
    }
  }

  if (runId === null && sessionKey === null) return null
  return { kind: 'unknown', runId, stream: 'session.tool', at, raw: payload }
}

export function chatToRunEvent(e: ChatEventPayload, at: number): RunEvent {
  return { kind: 'chat', runId: e.runId, state: e.state, text: e.message, errorMessage: e.errorMessage, at }
}

function computeActivity(state: RunState, event: RunEvent): Activity {
  if (!state.runActive) return 'idle'
  if (state.openTools.size > 0) return 'tool'
  if (event.kind === 'chat' && event.state === 'delta') return 'speaking'
  if (event.kind === 'thinking') return 'thinking'
  return 'active'
}

function endRun(state: RunState): RunState {
  const openIds = new Set(state.openTools.keys())
  const marks = state.marks.map((m) => (openIds.has(m.toolCallId) ? { ...m, status: 'interrupted' as const } : m))
  return { ...state, runActive: false, openTools: new Map(), marks, activity: 'idle' }
}

export function reduceRunEvent(state: RunState, event: RunEvent): RunState {
  if (event.kind === 'compaction') return state

  // run-status and chat:status are a run's first events, arriving before
  // lifecycle:start — so they have to be able to open a run, or the activity
  // they exist to signal is dropped for want of one.
  const isStartTrigger =
    (event.kind === 'lifecycle' && event.phase === 'start') ||
    (event.kind === 'chat' && (event.state === 'delta' || event.state === 'status')) ||
    event.kind === 'run-status' ||
    // Reasoning can be a run's first visible output — a row is owed the moment
    // the first delta lands, which needs an open run to hold it.
    (event.kind === 'thinking' && event.text !== '')
  const eventRunId = 'runId' in event ? event.runId : null

  let working = state
  if (eventRunId !== null && eventRunId !== state.runId) {
    if (!isStartTrigger) return state
    working = { ...initialRunState, runId: eventRunId, runActive: true }
  } else if (eventRunId === null && !state.runActive) {
    return state
  }

  switch (event.kind) {
    case 'tool': {
      const key = `${event.toolCallId}:${event.phase}`
      if (working.seenToolPhases.has(key)) {
        return { ...working, activity: computeActivity(working, event) }
      }
      const seenToolPhases = new Set(working.seenToolPhases)
      seenToolPhases.add(key)
      let openTools: ReadonlyMap<string, ToolMark> = working.openTools
      let marks = working.marks
      if (event.phase === 'start') {
        const mark: ToolMark = { toolCallId: event.toolCallId, name: event.name, textOffset: working.text.length, status: 'running' }
        const nextOpenTools = new Map(working.openTools)
        nextOpenTools.set(event.toolCallId, mark)
        openTools = nextOpenTools
        marks = [...marks, mark]
      } else if (event.phase === 'result') {
        const nextOpenTools = new Map(working.openTools)
        nextOpenTools.delete(event.toolCallId)
        openTools = nextOpenTools
        const status = event.isError ? 'error' : 'done'
        marks = marks.map((m) => (m.toolCallId === event.toolCallId ? { ...m, status } : m))
      }
      const next = { ...working, seenToolPhases, openTools, marks }
      return { ...next, activity: computeActivity(next, event) }
    }
    case 'item': {
      const marks = working.marks.map((m) => (m.toolCallId === event.toolCallId ? { ...m, title: event.title } : m))
      const next = { ...working, marks }
      return { ...next, activity: computeActivity(next, event) }
    }
    case 'lifecycle': {
      if (event.phase === 'end' || event.phase === 'error') return endRun(working)
      return { ...working, activity: computeActivity(working, event) }
    }
    case 'thinking': {
      if (event.text === '') return { ...working, activity: computeActivity(working, event) }
      const blocks = [...working.thinking]
      const open = blocks[blocks.length - 1]
      // The gateway sends reasoning cumulatively, so a shorter text means the
      // model started a fresh block rather than continuing this one. A block
      // opened under a different tool-mark count is likewise a new one.
      if (open === undefined || event.text.length < open.text.length || open.markCount !== working.marks.length) {
        blocks.push({ text: event.text, markCount: working.marks.length })
      } else {
        blocks[blocks.length - 1] = { ...open, text: event.text }
      }
      const next = { ...working, thinking: blocks }
      return { ...next, activity: computeActivity(next, event) }
    }
    case 'chat': {
      if (event.state === 'delta') {
        const next = { ...working, text: event.text }
        return { ...next, activity: computeActivity(next, event) }
      }
      // Progress, not an outcome: it carries no text, so it must neither end
      // the run nor overwrite what has been assembled so far.
      if (event.state === 'status') {
        return { ...working, activity: computeActivity(working, event) }
      }
      const withText = { ...working, text: event.text || working.text }
      return endRun(withText)
    }
    case 'run-status': {
      return { ...working, activity: computeActivity(working, event) }
    }
    case 'unknown': {
      return { ...working, activity: computeActivity(working, event) }
    }
  }
}
