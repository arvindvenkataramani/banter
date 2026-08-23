import { initialRunState, reduceRunEvent, type Activity, type RunEvent, type RunState } from './run-state'
import { seedFromHistory, applyLiveRun, finalizeRun, type ConversationItem, type DeliveryStatus } from './conversation'

export type { ConversationItem, DeliveryStatus }

export interface ConversationSnapshot {
  items: ReadonlyArray<ConversationItem>
  known: boolean
  runActive: boolean
  runId: string | null
  activity: Activity
  error: string | null
  compactionPhase: 'active' | 'retrying' | 'complete' | null
}

interface RunEndWaiter {
  resolve: (result: 'ended' | 'timeout') => void
  timer: ReturnType<typeof setTimeout>
}

export class Conversation {
  private items: ConversationItem[] = []
  private runState: RunState = initialRunState
  private known = true
  private error: string | null = null
  private compactionPhase: 'active' | 'retrying' | 'complete' | null = null
  private compactionClearTimer: ReturnType<typeof setTimeout> | null = null

  private listeners = new Set<() => void>()
  private eventListeners = new Set<(e: RunEvent) => void>()
  private runEndWaiters: RunEndWaiter[] = []

  private pendingCounter = 0
  private errorCounter = 0

  private snapshot: ConversationSnapshot = {
    items: [],
    known: true,
    runActive: false,
    runId: null,
    activity: 'idle',
    error: null,
    compactionPhase: null,
  }

  getSnapshot(): ConversationSnapshot {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onEvent(cb: (e: RunEvent) => void): () => void {
    this.eventListeners.add(cb)
    return () => this.eventListeners.delete(cb)
  }

  waitForRunEnd(timeoutMs: number): Promise<'ended' | 'timeout'> {
    if (!this.runState.runActive) return Promise.resolve('ended')
    return new Promise((resolve) => {
      const waiter: RunEndWaiter = {
        resolve,
        timer: setTimeout(() => {
          this.runEndWaiters = this.runEndWaiters.filter((w) => w !== waiter)
          resolve('timeout')
        }, timeoutMs),
      }
      this.runEndWaiters.push(waiter)
    })
  }

  ingest(e: RunEvent): void {
    this.known = true

    if (e.kind === 'compaction') {
      this.applyCompaction(e)
    } else {
      const wasActive = this.runState.runActive
      const priorRunId = this.runState.runId
      this.runState = reduceRunEvent(this.runState, e)
      const isActiveNow = this.runState.runActive
      if (isActiveNow) {
        this.items = applyLiveRun(this.items, this.runState)
      } else if (wasActive) {
        this.items = finalizeRun(this.items, this.runState)
        this.settleRunEndWaiters('ended')
      } else if (e.kind === 'chat' && this.runState.runId === priorRunId && priorRunId !== null) {
        // lifecycle:end can arrive before the trailing chat delta/final for
        // the same run (confirmed on the wire — not a rare race, the normal
        // ordering on this gateway). The run was already finalized above on
        // an earlier tick with truncated text; this event still updates
        // runState.text (reduceRunEvent's own contract), so re-settle the
        // assembled items now that the real final text has arrived.
        this.items = finalizeRun(this.items, this.runState)
      }
      this.notify()
    }

    for (const cb of this.eventListeners) cb(e)
  }

  private applyCompaction(e: Extract<RunEvent, { kind: 'compaction' }>): void {
    if (this.compactionClearTimer) {
      clearTimeout(this.compactionClearTimer)
      this.compactionClearTimer = null
    }
    if (e.phase === 'start') {
      this.compactionPhase = 'active'
    } else if (e.phase === 'end') {
      if (e.completed && e.willRetry) {
        this.compactionPhase = 'retrying'
      } else if (e.completed) {
        this.compactionPhase = 'complete'
        this.compactionClearTimer = setTimeout(() => {
          this.compactionPhase = null
          this.compactionClearTimer = null
          this.notify()
        }, 5000)
      } else {
        // skipped/failed — clear immediately
        this.compactionPhase = null
      }
    }
    this.notify()
  }

  seed(rows: unknown[]): void {
    this.known = true
    this.items = seedFromHistory(rows)
    this.notify()
  }

  prependOlder(rows: unknown[], offset: number): void {
    const older = seedFromHistory(rows, offset)
    const known = new Set(this.items.map((i) => i.id))
    this.items = [...older.filter((i) => !known.has(i.id)), ...this.items]
    this.notify()
  }

  addUserMessage(text: string): string {
    const id = `pending-${++this.pendingCounter}`
    this.items = [...this.items, { id, kind: 'user-message', text, delivery: 'pending' }]
    this.notify()
    return id
  }

  setDelivery(id: string, s: DeliveryStatus): void {
    this.items = this.items.map((i) => (i.id === id && i.kind === 'user-message' ? { ...i, delivery: s } : i))
    this.notify()
  }

  getItemText(id: string): string | null {
    const item = this.items.find((i) => i.id === id)
    return item && item.kind === 'user-message' ? item.text : null
  }

  setError(message: string | null): void {
    this.error = message
    if (message !== null) {
      this.items = [...this.items, { id: `error-${++this.errorCounter}`, kind: 'error', message }]
    }
    this.notify()
  }

  markUnknown(): void {
    this.known = false
    this.notify()
  }

  reset(): void {
    this.items = []
    this.runState = initialRunState
    this.known = true
    this.error = null
    this.compactionPhase = null
    if (this.compactionClearTimer) {
      clearTimeout(this.compactionClearTimer)
      this.compactionClearTimer = null
    }
    this.settleRunEndWaiters('ended')
    this.notify()
  }

  private settleRunEndWaiters(result: 'ended' | 'timeout'): void {
    for (const w of this.runEndWaiters) {
      clearTimeout(w.timer)
      w.resolve(result)
    }
    this.runEndWaiters = []
  }

  private notify(): void {
    this.snapshot = {
      items: this.items,
      known: this.known,
      runActive: this.runState.runActive,
      runId: this.runState.runId,
      activity: this.runState.activity,
      error: this.error,
      compactionPhase: this.compactionPhase,
    }
    for (const listener of this.listeners) listener()
  }
}
