import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'
import { Conversation } from './conversation-store'
import { normalizeAgentEvent, chatToRunEvent, type RunEvent } from './run-state'

const SESSION_KEY = 'agent:example:probe'
const RUN_ID = 'run-1'

const lifecycleStart = { runId: RUN_ID, sessionKey: SESSION_KEY, stream: 'lifecycle', data: { phase: 'start', startedAt: 1 } }
const toolStart = { runId: RUN_ID, sessionKey: SESSION_KEY, stream: 'tool', data: { phase: 'start', name: 'exec', toolCallId: 'tc1' } }
const lifecycleEnd = { runId: RUN_ID, sessionKey: SESSION_KEY, stream: 'lifecycle', data: { phase: 'end', stopReason: 'stop', aborted: false } }

function delta(text: string, seq = 1): RunEvent {
  return chatToRunEvent({ runId: RUN_ID, sessionKey: SESSION_KEY, seq, state: 'delta', message: text }, seq)
}
function final(text: string, seq = 2): RunEvent {
  return chatToRunEvent({ runId: RUN_ID, sessionKey: SESSION_KEY, seq, state: 'final', message: text }, seq)
}

describe('Conversation: snapshot coherence', () => {
  test('a fresh conversation starts known, idle, no error, no items', () => {
    const c = new Conversation()
    const s = c.getSnapshot()
    expect(s).toEqual({ items: [], known: true, runActive: false, runId: null, activity: 'idle', error: null, compactionPhase: null })
  })

  test('ingesting a run start + delta reflects consistently across all snapshot fields', () => {
    const c = new Conversation()
    c.ingest(normalizeAgentEvent(lifecycleStart, 1) as RunEvent)
    c.ingest(delta('Hello there', 2))
    const s = c.getSnapshot()
    expect(s.runActive).toBe(true)
    expect(s.runId).toBe(RUN_ID)
    expect(s.activity).toBe('speaking')
    expect(s.items).toEqual([{ id: `live:${RUN_ID}:text:0`, kind: 'assistant-text', runId: RUN_ID, text: 'Hello there', isStreaming: true }])
  })

  test('getSnapshot is referentially stable across calls when nothing changed', () => {
    const c = new Conversation()
    const s1 = c.getSnapshot()
    const s2 = c.getSnapshot()
    expect(s1).toBe(s2)
  })
})

describe('Conversation: tap ordering', () => {
  test('registered listeners receive every ingested event, in ingestion order', () => {
    const c = new Conversation()
    const seenA: RunEvent[] = []
    const seenB: RunEvent[] = []
    c.onEvent((e) => seenA.push(e))
    c.onEvent((e) => seenB.push(e))

    const e1 = normalizeAgentEvent(lifecycleStart, 1) as RunEvent
    const e2 = normalizeAgentEvent(toolStart, 2) as RunEvent
    const e3 = delta('hi', 3)
    c.ingest(e1)
    c.ingest(e2)
    c.ingest(e3)

    expect(seenA).toEqual([e1, e2, e3])
    expect(seenB).toEqual([e1, e2, e3])
  })

  test('the tap fires post-reduction: snapshot already reflects the event inside the callback', () => {
    const c = new Conversation()
    let seenActivityDuringTap: string | null = null
    c.onEvent(() => {
      seenActivityDuringTap = c.getSnapshot().activity
    })
    c.ingest(delta('go', 1))
    expect(seenActivityDuringTap).toBe('speaking')
  })

  test('unsubscribing stops further delivery', () => {
    const c = new Conversation()
    const seen: RunEvent[] = []
    const unsub = c.onEvent((e) => seen.push(e))
    c.ingest(delta('a', 1))
    unsub()
    c.ingest(delta('b', 2))
    expect(seen.length).toBe(1)
  })
})

describe('Conversation: internal residue on terminals', () => {
  test('ingesting the terminal event alone settles the items — no separate finalize call needed', () => {
    const c = new Conversation()
    c.ingest(normalizeAgentEvent(lifecycleStart, 1) as RunEvent)
    c.ingest(normalizeAgentEvent(toolStart, 2) as RunEvent)
    c.ingest(normalizeAgentEvent(lifecycleEnd, 3) as RunEvent)

    const s = c.getSnapshot()
    expect(s.runActive).toBe(false)
    expect(s.activity).toBe('idle')
    const card = s.items.find((i) => i.kind === 'tool-card')
    expect(card && (card as { status: string }).status).toBe('interrupted')
  })

  test('a run ending via chat final settles isStreaming on its text segment', () => {
    const c = new Conversation()
    c.ingest(delta('partial', 1))
    c.ingest(final('partial done', 2))
    const s = c.getSnapshot()
    const text = s.items.find((i) => i.kind === 'assistant-text')
    expect(text && (text as { isStreaming?: boolean }).isStreaming).toBe(false)
    expect(text && (text as { text: string }).text).toBe('partial done')
  })

  // Real wire ordering, confirmed live 2026-08-09: lifecycle:end regularly
  // arrives before the trailing chat delta/final for the same run — not a
  // rare race, the normal case on this gateway. Finalizing on lifecycle:end
  // alone (needed for tool-only runs with no chat terminal, per step 9)
  // must not permanently freeze the text if a delta/final for the same run
  // still arrives afterward.
  test('lifecycle:end arriving before the trailing chat delta/final does not truncate the settled text', () => {
    const c = new Conversation()
    c.ingest(delta('Hello', 1))
    c.ingest(normalizeAgentEvent(lifecycleEnd, 2) as RunEvent)
    c.ingest(delta('Hello world', 3))
    c.ingest(final('Hello world', 4))

    const s = c.getSnapshot()
    expect(s.runActive).toBe(false)
    const text = s.items.find((i) => i.kind === 'assistant-text')
    expect(text && (text as { text: string }).text).toBe('Hello world')
    expect(text && (text as { isStreaming?: boolean }).isStreaming).toBe(false)
  })
})

describe('Conversation: delivery transitions', () => {
  test('addUserMessage creates a pending item; setDelivery transitions it in place', () => {
    const c = new Conversation()
    const id = c.addUserMessage('hello')
    let item = c.getSnapshot().items.find((i) => i.id === id)
    expect(item).toEqual({ id, kind: 'user-message', text: 'hello', delivery: 'pending' })

    c.setDelivery(id, 'confirmed')
    item = c.getSnapshot().items.find((i) => i.id === id)
    expect(item && (item as { delivery?: string }).delivery).toBe('confirmed')
  })

  test('setDelivery to failed keeps the item in place (no content movement)', () => {
    const c = new Conversation()
    const id = c.addUserMessage('will fail')
    c.setDelivery(id, 'failed')
    const items = c.getSnapshot().items
    expect(items.length).toBe(1)
    expect((items[0] as { delivery?: string }).delivery).toBe('failed')
  })

  test('getItemText round-trips the original text for resend', () => {
    const c = new Conversation()
    const id = c.addUserMessage('resend me')
    expect(c.getItemText(id)).toBe('resend me')
  })

  test('getItemText returns null for a non-existent or non-user-message id', () => {
    const c = new Conversation()
    expect(c.getItemText('nope')).toBeNull()
  })
})

describe('Conversation: setError', () => {
  test('sets the singular error field AND appends a transient in-flow error item', () => {
    const c = new Conversation()
    c.setError('boom')
    const s = c.getSnapshot()
    expect(s.error).toBe('boom')
    expect(s.items.some((i) => i.kind === 'error' && i.message === 'boom')).toBe(true)
  })

  test('clearing the error (null) clears the field but leaves the transient item in history', () => {
    const c = new Conversation()
    c.setError('boom')
    c.setError(null)
    const s = c.getSnapshot()
    expect(s.error).toBeNull()
    expect(s.items.some((i) => i.kind === 'error' && i.message === 'boom')).toBe(true)
  })
})

describe('Conversation: markUnknown / reset', () => {
  test('markUnknown flips known to false', () => {
    const c = new Conversation()
    c.markUnknown()
    expect(c.getSnapshot().known).toBe(false)
  })

  test('ingesting a real event after markUnknown restores known', () => {
    const c = new Conversation()
    c.markUnknown()
    c.ingest(delta('back online', 1))
    expect(c.getSnapshot().known).toBe(true)
  })

  test('seeding history after markUnknown restores known', () => {
    const c = new Conversation()
    c.markUnknown()
    c.seed([{ role: 'user', content: 'hi', __openclaw: { id: 'a1' } }])
    expect(c.getSnapshot().known).toBe(true)
  })

  test('reset clears items, run state, error, and known back to true', () => {
    const c = new Conversation()
    c.ingest(normalizeAgentEvent(lifecycleStart, 1) as RunEvent)
    c.ingest(delta('mid run', 2))
    c.setError('boom')
    c.markUnknown()

    c.reset()
    const s = c.getSnapshot()
    expect(s).toEqual({ items: [], known: true, runActive: false, runId: null, activity: 'idle', error: null, compactionPhase: null })
  })
})

describe('Conversation: seed / prependOlder', () => {
  test('seed replaces assembled items entirely', () => {
    const c = new Conversation()
    c.addUserMessage('will be wiped')
    c.seed([{ role: 'user', content: 'from history', __openclaw: { id: 'h1' } }])
    const s = c.getSnapshot()
    expect(s.items).toEqual([{ id: 'hist-h1', kind: 'user-message', text: 'from history' }])
  })

  test('prependOlder adds older rows before existing items, deduped by id', () => {
    const c = new Conversation()
    c.seed([{ role: 'user', content: 'newer', __openclaw: { id: 'new1' } }])
    c.prependOlder([{ role: 'user', content: 'older', __openclaw: { id: 'old1' } }], 0)
    const s = c.getSnapshot()
    expect(s.items.map((i) => i.id)).toEqual(['hist-old1', 'hist-new1'])
  })

  test('prependOlder does not duplicate a row already held', () => {
    const c = new Conversation()
    c.seed([{ role: 'user', content: 'a', __openclaw: { id: 'dup1' } }])
    c.prependOlder([{ role: 'user', content: 'a', __openclaw: { id: 'dup1' } }], 0)
    expect(c.getSnapshot().items.length).toBe(1)
  })
})

describe('Conversation: compaction', () => {
  const compactionStart = normalizeAgentEvent({ sessionKey: SESSION_KEY, stream: 'compaction', data: { phase: 'start' } }, 1) as RunEvent
  const compactionEndRetrying = normalizeAgentEvent({ sessionKey: SESSION_KEY, stream: 'compaction', data: { phase: 'end', completed: true, willRetry: true } }, 2) as RunEvent
  const compactionEndComplete = normalizeAgentEvent({ sessionKey: SESSION_KEY, stream: 'compaction', data: { phase: 'end', completed: true } }, 3) as RunEvent
  const compactionEndFailed = normalizeAgentEvent({ sessionKey: SESSION_KEY, stream: 'compaction', data: { phase: 'end', completed: false } }, 4) as RunEvent

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('start sets the phase to active', () => {
    const c = new Conversation()
    c.ingest(compactionStart)
    expect(c.getSnapshot().compactionPhase).toBe('active')
  })

  test('end + completed + willRetry sets retrying', () => {
    const c = new Conversation()
    c.ingest(compactionStart)
    c.ingest(compactionEndRetrying)
    expect(c.getSnapshot().compactionPhase).toBe('retrying')
  })

  test('end + completed only sets complete, then auto-clears to null after 5s', () => {
    const c = new Conversation()
    c.ingest(compactionStart)
    c.ingest(compactionEndComplete)
    expect(c.getSnapshot().compactionPhase).toBe('complete')
    vi.advanceTimersByTime(5000)
    expect(c.getSnapshot().compactionPhase).toBeNull()
  })

  test('end + neither completed nor willRetry (skipped/failed) clears immediately', () => {
    const c = new Conversation()
    c.ingest(compactionStart)
    c.ingest(compactionEndFailed)
    expect(c.getSnapshot().compactionPhase).toBeNull()
  })

  test('a fresh compaction cancels a pending auto-clear timer from a prior one', () => {
    const c = new Conversation()
    c.ingest(compactionStart)
    c.ingest(compactionEndComplete)
    expect(c.getSnapshot().compactionPhase).toBe('complete')
    vi.advanceTimersByTime(2000) // partway through the 5s auto-clear
    c.ingest(compactionStart) // a new compaction begins before the old one cleared
    expect(c.getSnapshot().compactionPhase).toBe('active')
    vi.advanceTimersByTime(5000) // the old timer, if not cancelled, would have fired here
    expect(c.getSnapshot().compactionPhase).toBe('active') // unaffected by the stale timer
  })

  test('compaction does not affect items, runActive, or activity', () => {
    const c = new Conversation()
    c.ingest(normalizeAgentEvent(lifecycleStart, 1) as RunEvent)
    c.ingest(compactionStart)
    const s = c.getSnapshot()
    expect(s.runActive).toBe(true)
    expect(s.items).toEqual([])
  })

  test('compaction events still reach the ordered tap', () => {
    const c = new Conversation()
    const seen: RunEvent[] = []
    c.onEvent((e) => seen.push(e))
    c.ingest(compactionStart)
    expect(seen).toEqual([compactionStart])
  })
})

describe('Conversation: waitForRunEnd', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('resolves immediately with "ended" when no run is active', async () => {
    const c = new Conversation()
    const result = await c.waitForRunEnd(5000)
    expect(result).toBe('ended')
  })

  test('resolves "ended" as soon as the active run ends, before the timeout', async () => {
    const c = new Conversation()
    c.ingest(normalizeAgentEvent(lifecycleStart, 1) as RunEvent)
    const promise = c.waitForRunEnd(5000)
    c.ingest(normalizeAgentEvent(lifecycleEnd, 2) as RunEvent)
    const result = await promise
    expect(result).toBe('ended')
  })

  test('resolves "timeout" if the run never ends within timeoutMs', async () => {
    const c = new Conversation()
    c.ingest(normalizeAgentEvent(lifecycleStart, 1) as RunEvent)
    const promise = c.waitForRunEnd(5000)
    vi.advanceTimersByTime(5000)
    const result = await promise
    expect(result).toBe('timeout')
  })

  test('a reset while waiting settles the wait as ended, not left hanging', async () => {
    const c = new Conversation()
    c.ingest(normalizeAgentEvent(lifecycleStart, 1) as RunEvent)
    const promise = c.waitForRunEnd(5000)
    c.reset()
    const result = await promise
    expect(result).toBe('ended')
  })
})

// A run's items are rebuilt from scratch on every event it receives. Rebuilding
// them at the tail moved a finished reply below anything the user had sent
// since — which is what a reader sees as their own message jumping upward.
describe('Conversation: a run holds its position', () => {
  const RUN_2 = 'run-2'
  const texts = (c: Conversation) =>
    c.getSnapshot().items.map((i) => (i.kind === 'user-message' || i.kind === 'assistant-text' ? i.text : i.kind))

  test('a reply stays above a message sent after it, when its run gets another event', () => {
    const c = new Conversation()
    c.addUserMessage('first question')
    c.ingest(delta('first answer'))
    c.ingest(final('first answer'))
    c.addUserMessage('second question')
    expect(texts(c)).toEqual(['first question', 'first answer', 'second question'])

    // A trailing event for the run that already finished. Before the fix this
    // rebuilt 'first answer' at the tail, below 'second question'.
    c.ingest(final('first answer', 3))
    expect(texts(c)).toEqual(['first question', 'first answer', 'second question'])
  })

  test('a new run appends at the tail, having nothing on screen to hold', () => {
    const c = new Conversation()
    c.addUserMessage('first question')
    c.ingest(delta('first answer'))
    c.ingest(final('first answer'))
    c.addUserMessage('second question')
    c.ingest(chatToRunEvent({ runId: RUN_2, sessionKey: SESSION_KEY, seq: 4, state: 'delta', message: 'second answer' }, 4))
    expect(texts(c)).toEqual(['first question', 'first answer', 'second question', 'second answer'])
  })

  // The 2026.8.1 signal that provoked the reordering: it reaches a finished
  // run as an ordinary chat event.
  test('a status event for a finished run moves nothing', () => {
    const c = new Conversation()
    c.addUserMessage('first question')
    c.ingest(delta('first answer'))
    c.ingest(final('first answer'))
    c.addUserMessage('second question')
    c.ingest(chatToRunEvent({ runId: RUN_ID, sessionKey: SESSION_KEY, seq: 5, state: 'status', message: '' }, 5))
    expect(texts(c)).toEqual(['first question', 'first answer', 'second question'])
  })
})
