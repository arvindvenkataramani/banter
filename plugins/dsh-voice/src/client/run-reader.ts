// Folds dsh's session event window into the voice engine's RunEvents and the
// conversation snapshot. Pure: a window and the reader's state in, events and
// the next state out.

import type { Activity, RunEvent } from '@platform/voice-engine/run-event'
import type { DshEntry, DshEventWindow } from './dsh-types.ts'

export interface ReaderSnapshot {
  known: boolean
  runActive: boolean
  runId: string | null
  activity: Activity
}

interface AttemptText {
  /** Visible text this attempt streamed. */
  live: string
  /** Reasoning text so far, by content-block index. */
  reasoning: Record<number, string>
}

interface Run {
  turn: number
  id: string
  /** A run already in flight when the reader first loaded: its state counts, its text is never spoken. */
  silent: boolean
  /** The run's assistant text so far; it only grows. */
  text: string
  attempts: Record<string, AttemptText>
  /** The attempt that streamed each step last; a committed message is compared against it. */
  lastAttemptOfStep: Record<number, string>
  /** Open tool calls by call id, holding the tool's name. */
  openTools: Record<string, string>
}

export interface ReaderState {
  loaded: boolean
  revision: number
  /** Highest durable seq already read. */
  lastSeq: number
  /** Highest turn whose end was read; entries of an ended turn open no run. */
  endedTurn: number
  run: Run | null
  runId: string | null
  activity: Activity
  /** Live chunks already applied, per attempt. */
  applied: Record<string, number>
  /** Live chunk entries currently in the window, per attempt. */
  inWindow: Record<string, number>
  /** Seqs of assistant messages already folded into the current run's text. */
  committed: number[]
  snapshot: ReaderSnapshot
}

export const initialReaderState: ReaderState = {
  loaded: false,
  revision: 0,
  lastSeq: -1,
  endedTurn: -1,
  run: null,
  runId: null,
  activity: 'idle',
  applied: {},
  inWindow: {},
  committed: [],
  snapshot: { known: false, runActive: false, runId: null, activity: 'idle' },
}

type Trigger = 'delta' | 'thinking' | 'other'
type LiveData = Extract<DshEntry, { type: 'transient' }>['event']['data']

/** What an event does to a run's activity, as the dashboard's `computeActivity` reads it. */
function activityOf(run: Run | null, trigger: Trigger): Activity {
  if (run === null) return 'idle'
  if (Object.keys(run.openTools).length > 0) return 'tool'
  if (trigger === 'delta') return 'speaking'
  if (trigger === 'thinking') return 'thinking'
  return 'active'
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null
}

/** The visible text of a committed assistant message: its text blocks only. */
function visibleText(message: unknown): string {
  const content = isRecord(message) && Array.isArray(message.content) ? message.content : []
  return content
    .map(block => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('')
}

function terminalEvent(run: Run, reason: unknown, at: number): RunEvent {
  const kind = isRecord(reason) ? reason.kind : undefined
  if (kind === 'error') {
    const error = isRecord(reason) && isRecord(reason.error) ? reason.error : {}
    const errorMessage = typeof error.message === 'string' ? error.message : 'The turn failed'
    return { kind: 'chat', runId: run.id, state: 'error', text: run.text, errorMessage, at }
  }
  if (kind === 'aborted' || kind === 'interrupted' || kind === 'forked') {
    return { kind: 'chat', runId: run.id, state: 'aborted', text: run.text, at }
  }
  return { kind: 'chat', runId: run.id, state: 'final', text: run.text, at }
}

/** One pass over a window notification, working on a copy of the reader's state. */
class Reading {
  readonly events: RunEvent[] = []
  readonly s: ReaderState
  private readonly initial: boolean
  private readonly now: () => number

  constructor(state: ReaderState, initial: boolean, now: () => number) {
    this.s = structuredClone(state)
    this.initial = initial
    this.now = now
  }

  private openRun(turn: number): Run | null {
    const { s } = this
    if (s.run !== null && s.run.turn === turn) return s.run
    if (turn <= s.endedTurn) return null
    // A newer turn replaces a run whose end was never read.
    s.run = { turn, id: `turn:${turn}`, silent: this.initial, text: '', attempts: {}, lastAttemptOfStep: {}, openTools: {} }
    s.runId = s.run.id
    s.activity = activityOf(s.run, 'other')
    return s.run
  }

  private addText(run: Run, delta: string): void {
    if (delta === '') return
    run.text += delta
    this.s.activity = activityOf(run, 'delta')
    if (!run.silent) this.events.push({ kind: 'chat', runId: run.id, state: 'delta', text: run.text, at: this.now() })
  }

  /** One live chunk, already known to be new. */
  private applyChunk(data: LiveData): void {
    const run = this.openRun(data.turn)
    if (run === null) return
    run.lastAttemptOfStep[data.step] = data.attemptId
    const attempt = (run.attempts[data.attemptId] ??= { live: '', reasoning: {} })
    const chunk = data.chunk
    if (chunk.type === 'text-delta') {
      attempt.live += chunk.text
      this.addText(run, chunk.text)
    } else if (chunk.type === 'reasoning-delta') {
      const text = (attempt.reasoning[chunk.index] ?? '') + chunk.text
      attempt.reasoning[chunk.index] = text
      this.s.activity = activityOf(run, chunk.text === '' ? 'other' : 'thinking')
      if (!run.silent && text !== '') this.events.push({ kind: 'thinking', runId: run.id, text, at: this.now() })
    }
  }

  /** A live chunk entry at its ordinal among its attempt's chunk entries in the window. */
  private liveChunk(data: LiveData, ordinal: number): void {
    if (ordinal < (this.s.applied[data.attemptId] ?? 0)) return
    this.s.applied[data.attemptId] = ordinal + 1
    this.applyChunk(data)
  }

  private durable(type: string, seq: number, data: unknown): void {
    const { s } = this
    const d = isRecord(data) ? data : {}
    const turn = typeof d.turn === 'number' ? d.turn : null
    if (turn !== null) {
      if (type === 'turn/start') this.openRun(turn)
      else if (type === 'turn/end') this.endRun(turn, d.reason)
      else if (type === 'assistant/message') this.commitMessage(turn, seq, d)
      else if (type === 'tool/call') this.toolCall(turn, d)
      else if (type === 'tool/result') this.toolResult(turn, d)
    }
    if (seq > s.lastSeq) s.lastSeq = seq
  }

  private commitMessage(turn: number, seq: number, d: Record<string, unknown>): void {
    if (this.s.committed.includes(seq)) return
    this.s.committed.push(seq)
    const run = this.openRun(turn)
    if (run === null) return
    const step = typeof d.step === 'number' ? d.step : 0
    const text = visibleText(d.message)
    const streamed = run.attempts[run.lastAttemptOfStep[step] ?? '']?.live ?? ''
    // A message that repeats what streamed adds nothing; one that extends it adds the rest.
    if (text.length > streamed.length && text.startsWith(streamed)) this.addText(run, text.slice(streamed.length))
  }

  private toolCall(turn: number, d: Record<string, unknown>): void {
    const run = this.openRun(turn)
    if (run === null || typeof d.callId !== 'string' || d.callId in run.openTools) return
    const name = typeof d.name === 'string' ? d.name : ''
    run.openTools[d.callId] = name
    this.s.activity = activityOf(run, 'other')
    if (!run.silent) this.events.push({ kind: 'tool', runId: run.id, phase: 'start', toolCallId: d.callId, name, at: this.now() })
  }

  private toolResult(turn: number, d: Record<string, unknown>): void {
    const callId = isRecord(d.message) ? d.message.toolCallId : undefined
    const run = this.openRun(turn)
    if (run === null || typeof callId !== 'string' || !isRecord(d.message)) return
    const name = run.openTools[callId] ?? ''
    delete run.openTools[callId]
    this.s.activity = activityOf(run, 'other')
    const isError = typeof d.message.isError === 'boolean' ? d.message.isError : undefined
    if (!run.silent) {
      this.events.push({ kind: 'tool', runId: run.id, phase: 'result', toolCallId: callId, name, ...(isError === undefined ? {} : { isError }), at: this.now() })
    }
  }

  private endRun(turn: number, reason: unknown): void {
    const { s } = this
    const run = s.run
    if (turn > s.endedTurn) s.endedTurn = turn
    if (run === null || run.turn !== turn) return
    if (!run.silent) this.events.push(terminalEvent(run, reason, this.now()))
    s.committed = []
    s.run = null
    s.activity = 'idle'
  }

  private entry(entry: DshEntry): void {
    if (entry.type === 'event' && entry.event.seq > this.s.lastSeq) this.durable(entry.event.type, entry.event.seq, entry.event.data)
  }

  /** Every entry of a window (the first load, or a resync), in window order. */
  replaceAll(entries: readonly DshEntry[]): void {
    const counts: Record<string, number> = {}
    for (const entry of entries) {
      if (entry.type === 'transient') {
        const ordinal = counts[entry.event.data.attemptId] ?? 0
        counts[entry.event.data.attemptId] = ordinal + 1
        this.liveChunk(entry.event.data, ordinal)
      } else {
        this.entry(entry)
      }
    }
    this.s.inWindow = counts
  }

  append(entries: readonly DshEntry[]): void {
    for (const entry of entries) {
      if (entry.type === 'transient') {
        const ordinal = this.s.inWindow[entry.event.data.attemptId] ?? 0
        this.s.inWindow[entry.event.data.attemptId] = ordinal + 1
        this.liveChunk(entry.event.data, ordinal)
      } else {
        this.entry(entry)
      }
    }
  }

  /** An attempt's live rows were retired, with or without the durable entry that replaces them. */
  settle(attemptId: string, entry: DshEntry | undefined): void {
    delete this.s.inWindow[attemptId]
    delete this.s.applied[attemptId]
    if (entry?.type === 'event') this.durable(entry.event.type, entry.event.seq, entry.event.data)
  }
}

function snapshotOf(s: ReaderState, previous: ReaderSnapshot): ReaderSnapshot {
  const next: ReaderSnapshot = { known: s.loaded, runActive: s.run !== null, runId: s.runId, activity: s.activity }
  const same = next.known === previous.known && next.runActive === previous.runActive
    && next.runId === previous.runId && next.activity === previous.activity
  return same ? previous : next
}

/**
 * Folds one notification of the session's event window into RunEvents. The
 * first window read is history: it sets the conversation's state and emits no
 * text. After it, a durable event is read once by its seq, and a live chunk
 * once by its ordinal among its attempt's chunk entries, so a resync that
 * reinstalls the window re-emits nothing.
 */
export function readWindow(
  state: ReaderState,
  window: DshEventWindow,
  now: () => number = Date.now,
): { state: ReaderState; events: RunEvent[]; snapshot: ReaderSnapshot } {
  // Revision 0 is the empty window dsh publishes before the session's history arrives.
  if ((!state.loaded && window.revision === 0) || (state.loaded && window.revision <= state.revision)) {
    return { state, events: [], snapshot: state.snapshot }
  }
  const reading = new Reading(state, !state.loaded, now)
  const { s } = reading
  const change = window.change
  if (!state.loaded || change.kind === 'replace') reading.replaceAll(window.entries)
  else if (change.kind === 'append') reading.append(change.entries)
  else if (change.kind === 'settle-assistant') reading.settle(change.attemptId, change.entry)
  s.loaded = true
  s.revision = window.revision
  s.snapshot = snapshotOf(s, state.snapshot)
  return { state: s, events: reading.events, snapshot: s.snapshot }
}
