import { describe, it, expect, vi } from 'vitest'
import { TurnManager } from './turn-manager'
import type { TurnManagerCallbacks } from './turn-manager'
import { Conversation } from '../conversation-store'
import { normalizeAgentEvent, chatToRunEvent, type RunEvent } from '../run-state'
import type { Session } from '../session'

// Contract: TurnManager reacts to RunEvents flowing through a REAL
// Conversation's ordered tap (attach() subscribes to it) — these tests feed
// events via conversation.ingest(), exactly as Session.applyAgentEvent/
// applyEvent would, rather than calling any TurnManager method directly for
// event delivery.

const SESSION_KEY = 'agent:example:probe'
const RUN_ID = 'run-1'

// endRun fires at the end of a chain (enqueueChat -> .catch -> Promise.all ->
// .then) several microtask hops deep. A fixed count of `await
// Promise.resolve()` under-counts and flakes; a macrotask boundary flushes
// every pending microtask regardless of chain depth.
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

const lifecycleStart = { runId: RUN_ID, sessionKey: SESSION_KEY, stream: 'lifecycle', data: { phase: 'start', startedAt: 1 } }
const lifecycleEnd = { runId: RUN_ID, sessionKey: SESSION_KEY, stream: 'lifecycle', data: { phase: 'end', stopReason: 'stop', aborted: false } }
const lifecycleError = { runId: RUN_ID, sessionKey: SESSION_KEY, stream: 'lifecycle', data: { phase: 'error', endedAt: 1 } }
const toolStart = { runId: RUN_ID, sessionKey: SESSION_KEY, stream: 'tool', data: { phase: 'start', name: 'exec', toolCallId: 'tc1' } }
const itemTool = { runId: RUN_ID, sessionKey: SESSION_KEY, stream: 'item', data: { phase: 'start', kind: 'tool', toolCallId: 'tc1', title: 'exec something' } }
const thinkingFrame = { runId: RUN_ID, sessionKey: SESSION_KEY, stream: 'thinking', data: { text: 'hmm' } }
const assistantStream = { runId: RUN_ID, sessionKey: SESSION_KEY, stream: 'assistant', data: { text: 'unmapped' } }

function delta(text: string, runId = RUN_ID, seq = 1): RunEvent {
  return chatToRunEvent({ runId, sessionKey: SESSION_KEY, seq, state: 'delta', message: text }, seq)
}
function final(text: string, runId = RUN_ID, seq = 2): RunEvent {
  return chatToRunEvent({ runId, sessionKey: SESSION_KEY, seq, state: 'final', message: text }, seq)
}
function aborted(text: string, runId = RUN_ID, seq = 2): RunEvent {
  return chatToRunEvent({ runId, sessionKey: SESSION_KEY, seq, state: 'aborted', message: text }, seq)
}
function chatError(text: string, runId = RUN_ID, seq = 2): RunEvent {
  return chatToRunEvent({ runId, sessionKey: SESSION_KEY, seq, state: 'error', message: text }, seq)
}

function makeCallbacks(): { cb: TurnManagerCallbacks; calls: { enqueueChat: string[]; beginRun: number; endRun: number } } {
  const calls = { enqueueChat: [] as string[], beginRun: 0, endRun: 0 }
  const cb: TurnManagerCallbacks = {
    enqueueChat: vi.fn(async (text: string) => { calls.enqueueChat.push(text) }),
    beginRun: vi.fn(() => { calls.beginRun++ }),
    endRun: vi.fn(() => { calls.endRun++ }),
  }
  return { cb, calls }
}

function makeFakeSession(conversation = new Conversation()) {
  const controls = { send: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined), resend: vi.fn() }
  return { conversation, controls } as unknown as Session
}

// Low threshold so a single short sentence emits immediately — keeps tests
// from needing paragraphs of filler text to cross MIN_WORDS.
function attachLowThreshold(tm: TurnManager, session: Session): void {
  tm.config = { chunkStrategy: 'sentence', minChunkWords: 1, maxChunkWords: undefined }
  tm.attach(session)
}

describe('TurnManager — run start / delta', () => {
  it('a chat delta with a new runId begins a run and feeds the delta text through the chunker', async () => {
    const { cb, calls } = makeCallbacks()
    const tm = new TurnManager(cb)
    const session = makeFakeSession()
    attachLowThreshold(tm, session)

    session.conversation.ingest(delta('Hello there. '))
    await flushMicrotasks()

    expect(calls.beginRun).toBe(1)
    expect(calls.enqueueChat).toEqual(['Hello there.'])
  })

  it('subsequent deltas feed only the new slice, not the whole cumulative text again', async () => {
    const { cb, calls } = makeCallbacks()
    const tm = new TurnManager(cb)
    const session = makeFakeSession()
    attachLowThreshold(tm, session)

    session.conversation.ingest(delta('First sentence. '))
    session.conversation.ingest(delta('First sentence. Second sentence. '))
    await flushMicrotasks()

    expect(calls.enqueueChat).toEqual(['First sentence.', 'Second sentence.'])
  })
})

describe('TurnManager — tool-start flush', () => {
  it('a tool start flushes held sub-threshold text immediately', async () => {
    const { cb, calls } = makeCallbacks()
    const tm = new TurnManager(cb)
    const session = makeFakeSession()
    // High threshold this time so the phrase is genuinely held below it.
    tm.config = { chunkStrategy: 'two-chunk', minChunkWords: 20, maxChunkWords: undefined }
    tm.attach(session)

    session.conversation.ingest(normalizeAgentEvent(lifecycleStart, 1) as RunEvent)
    session.conversation.ingest(delta('Let me check that. ', RUN_ID, 2))
    expect(calls.enqueueChat).toEqual([]) // held — below the 20-word floor

    session.conversation.ingest(normalizeAgentEvent(toolStart, 3) as RunEvent)
    await flushMicrotasks()

    expect(calls.enqueueChat).toEqual(['Let me check that.'])
  })
})

describe('TurnManager — chat terminals finish the run; lifecycle never does', () => {
  it('chat final feeds the tail, finishes, and calls endRun', async () => {
    const { cb, calls } = makeCallbacks()
    const tm = new TurnManager(cb)
    const session = makeFakeSession()
    attachLowThreshold(tm, session)

    session.conversation.ingest(delta('Partial', RUN_ID, 1))
    session.conversation.ingest(final('Partial done.', RUN_ID, 2))
    await flushMicrotasks()

    expect(calls.endRun).toBe(1)
  })

  it('chat aborted finishes the run', async () => {
    const { cb, calls } = makeCallbacks()
    const tm = new TurnManager(cb)
    const session = makeFakeSession()
    attachLowThreshold(tm, session)

    session.conversation.ingest(delta('Some text. ', RUN_ID, 1))
    session.conversation.ingest(aborted('Some text.', RUN_ID, 2))
    await flushMicrotasks()

    expect(calls.endRun).toBe(1)
  })

  it('chat error finishes the run', async () => {
    const { cb, calls } = makeCallbacks()
    const tm = new TurnManager(cb)
    const session = makeFakeSession()
    attachLowThreshold(tm, session)

    session.conversation.ingest(delta('Some text. ', RUN_ID, 1))
    session.conversation.ingest(chatError('Some text.', RUN_ID, 2))
    await flushMicrotasks()

    expect(calls.endRun).toBe(1)
  })

  // The chat stream is the ONLY finish trigger — lifecycle:end/error carry no
  // authority over end-of-text. A lifecycle terminal with no chat terminal
  // ever following must NOT finish the run: nothing is flushed, endRun is
  // never called. A lost-terminal case (e.g. a dropped connection) is
  // cleaned up lazily by the next run's beginRun()/cancel() or by
  // reset()/markUnknown(), not by lifecycle.
  it('lifecycle end alone, with no chat terminal ever arriving, does NOT finish the run', async () => {
    const { cb, calls } = makeCallbacks()
    const tm = new TurnManager(cb)
    const session = makeFakeSession()
    attachLowThreshold(tm, session)

    session.conversation.ingest(delta('Some text. ', RUN_ID, 1))
    session.conversation.ingest(normalizeAgentEvent(lifecycleEnd, 2) as RunEvent)
    await flushMicrotasks()

    expect(calls.endRun).toBe(0)
  })

  it('lifecycle error alone, with no chat terminal ever arriving, does NOT finish the run', async () => {
    const { cb, calls } = makeCallbacks()
    const tm = new TurnManager(cb)
    const session = makeFakeSession()
    attachLowThreshold(tm, session)

    session.conversation.ingest(delta('Some text. ', RUN_ID, 1))
    session.conversation.ingest(normalizeAgentEvent(lifecycleError, 2) as RunEvent)
    await flushMicrotasks()

    expect(calls.endRun).toBe(0)
  })

  it('a lifecycle end followed by the chat final finishes exactly once, via the final', async () => {
    const { cb, calls } = makeCallbacks()
    const tm = new TurnManager(cb)
    const session = makeFakeSession()
    attachLowThreshold(tm, session)

    session.conversation.ingest(delta('Some text. ', RUN_ID, 1))
    session.conversation.ingest(normalizeAgentEvent(lifecycleEnd, 2) as RunEvent)
    session.conversation.ingest(final('Some text.', RUN_ID, 3)) // arrives after lifecycle end
    await flushMicrotasks()

    expect(calls.endRun).toBe(1)
    expect(calls.enqueueChat).toEqual(['Some text.'])
  })

  it('a duplicate final after the run has already finished is dropped — no re-speak, no double finish', async () => {
    const { cb, calls } = makeCallbacks()
    const tm = new TurnManager(cb)
    const session = makeFakeSession()
    attachLowThreshold(tm, session)

    session.conversation.ingest(delta('Some text. ', RUN_ID, 1))
    session.conversation.ingest(final('Some text.', RUN_ID, 2))
    await flushMicrotasks()
    session.conversation.ingest(final('Some text.', RUN_ID, 3)) // stale duplicate
    await flushMicrotasks()

    expect(calls.endRun).toBe(1)
    expect(calls.enqueueChat).toEqual(['Some text.'])
  })

  // The gateway may send lifecycle:end before the trailing chat delta/final
  // of the same run. Since lifecycle:end never finishes the run, the
  // trailing delta is fed normally and its new tail is spoken.
  it('a trailing delta/final for the same run after lifecycle:end feeds and speaks the new tail', async () => {
    const { cb, calls } = makeCallbacks()
    const tm = new TurnManager(cb)
    const session = makeFakeSession()
    attachLowThreshold(tm, session)

    session.conversation.ingest(delta('First sentence. ', RUN_ID, 1))
    await flushMicrotasks()
    session.conversation.ingest(normalizeAgentEvent(lifecycleEnd, 2) as RunEvent)
    await flushMicrotasks()
    // Same runId, full cumulative text — the real shape of the late event.
    session.conversation.ingest(delta('First sentence. Second sentence.', RUN_ID, 3))
    session.conversation.ingest(final('First sentence. Second sentence.', RUN_ID, 4))
    await flushMicrotasks()

    expect(calls.enqueueChat).toEqual(['First sentence.', 'Second sentence.'])
    expect(calls.beginRun).toBe(1)
    expect(calls.endRun).toBe(1)
  })

  // lifecycle:end arrives mid-sentence; the trailing delta/final then carry
  // the completed sentence, including the tail not yet fed. No words lost.
  it('lifecycle:end mid-sentence, then trailing delta/final complete it — no words lost', async () => {
    const { cb, calls } = makeCallbacks()
    const tm = new TurnManager(cb)
    const session = makeFakeSession()
    attachLowThreshold(tm, session)

    session.conversation.ingest(delta('The other can\'t see', RUN_ID, 1))
    await flushMicrotasks()
    session.conversation.ingest(normalizeAgentEvent(lifecycleEnd, 2) as RunEvent)
    await flushMicrotasks()
    session.conversation.ingest(delta('The other can\'t see — of the same scene this whole time.', RUN_ID, 3))
    session.conversation.ingest(final('The other can\'t see — of the same scene this whole time.', RUN_ID, 4))
    await flushMicrotasks()

    const spoken = calls.enqueueChat.join(' ')
    expect(spoken).toContain('of the same scene this whole time')
    expect(calls.beginRun).toBe(1)
    expect(calls.endRun).toBe(1)
  })
})

describe('TurnManager — reset / markUnknown discard silently', () => {
  it('reset() discards the chunker without calling endRun', async () => {
    const { cb, calls } = makeCallbacks()
    const tm = new TurnManager(cb)
    const session = makeFakeSession()
    attachLowThreshold(tm, session)

    session.conversation.ingest(delta('Mid stream text. ', RUN_ID, 1))
    session.conversation.reset()
    await flushMicrotasks()

    expect(calls.endRun).toBe(0)
  })

  it('markUnknown() discards silently even though runState itself is untouched', async () => {
    const { cb, calls } = makeCallbacks()
    const tm = new TurnManager(cb)
    const session = makeFakeSession()
    attachLowThreshold(tm, session)

    session.conversation.ingest(delta('Mid stream text. ', RUN_ID, 1))
    session.conversation.markUnknown()
    await flushMicrotasks()

    expect(calls.endRun).toBe(0)
  })
})

describe('TurnManager — fast-forward rule', () => {
  it('the first delta after a discard does not re-speak already-accumulated text', async () => {
    const { cb, calls } = makeCallbacks()
    const tm = new TurnManager(cb)
    const session = makeFakeSession()
    attachLowThreshold(tm, session)

    session.conversation.ingest(delta('Already spoken before the drop. ', RUN_ID, 1))
    calls.enqueueChat.length = 0 // clear what was legitimately spoken pre-discard
    session.conversation.reset()

    // The gateway keeps streaming for the same runId after the local discard —
    // this delta's text is the FULL cumulative text including what was
    // already (or would have been) spoken. It must not be replayed.
    session.conversation.ingest(delta('Already spoken before the drop. Plus something new. ', RUN_ID, 2))
    await flushMicrotasks()

    expect(calls.beginRun).toBe(2) // the post-reset delta does start a fresh run
    expect(calls.enqueueChat).toEqual([]) // nothing spoken from that catch-up delta itself

    // A LATER delta with genuinely new content beyond the fast-forward point
    // is fed normally.
    session.conversation.ingest(delta('Already spoken before the drop. Plus something new. And more still. ', RUN_ID, 3))
    await flushMicrotasks()
    expect(calls.enqueueChat.length).toBeGreaterThan(0)
  })
})

describe('TurnManager — speech allowlist', () => {
  it('tool/item/thinking/unknown events never reach enqueueChat on their own', async () => {
    const { cb, calls } = makeCallbacks()
    const tm = new TurnManager(cb)
    const session = makeFakeSession()
    attachLowThreshold(tm, session)

    session.conversation.ingest(normalizeAgentEvent(lifecycleStart, 1) as RunEvent)
    session.conversation.ingest(normalizeAgentEvent(toolStart, 2) as RunEvent)
    session.conversation.ingest(normalizeAgentEvent(itemTool, 3) as RunEvent)
    session.conversation.ingest(normalizeAgentEvent(thinkingFrame, 4) as RunEvent)
    session.conversation.ingest(normalizeAgentEvent(assistantStream, 5) as RunEvent) // real but unmapped -> unknown
    await flushMicrotasks()

    expect(calls.enqueueChat).toEqual([])
  })

  it('compaction events never reach enqueueChat and do not disturb an in-flight run', async () => {
    const { cb, calls } = makeCallbacks()
    const tm = new TurnManager(cb)
    const session = makeFakeSession()
    attachLowThreshold(tm, session)

    session.conversation.ingest(delta('Talking. ', RUN_ID, 1))
    session.conversation.ingest(normalizeAgentEvent({ sessionKey: SESSION_KEY, stream: 'compaction', data: { phase: 'start' } }, 2) as RunEvent)
    await flushMicrotasks()

    expect(calls.endRun).toBe(0) // run is still going
    expect(calls.enqueueChat).toEqual(['Talking.'])
  })
})

describe('TurnManager — attach / detach', () => {
  it('detach stops reacting to further events on that conversation', async () => {
    const { cb, calls } = makeCallbacks()
    const tm = new TurnManager(cb)
    const session = makeFakeSession()
    attachLowThreshold(tm, session)

    tm.detach()
    session.conversation.ingest(delta('Should be ignored. ', RUN_ID, 1))
    await flushMicrotasks()

    expect(calls.beginRun).toBe(0)
    expect(calls.enqueueChat).toEqual([])
  })

  it('attaching to a new session stops reacting to the old one', async () => {
    const { cb, calls } = makeCallbacks()
    const tm = new TurnManager(cb)
    const oldSession = makeFakeSession()
    const newSession = makeFakeSession()
    tm.config = { chunkStrategy: 'sentence', minChunkWords: 1, maxChunkWords: undefined }
    tm.attach(oldSession)
    tm.attach(newSession)

    oldSession.conversation.ingest(delta('From the old session. ', RUN_ID, 1))
    await flushMicrotasks()

    expect(calls.beginRun).toBe(0)
    expect(calls.enqueueChat).toEqual([])
  })
})

describe('TurnManager — abort / send delegate to controls', () => {
  it('abort() calls session.controls.stop()', () => {
    const { cb } = makeCallbacks()
    const tm = new TurnManager(cb)
    const session = makeFakeSession()
    tm.attach(session)

    tm.abort()

    expect(session.controls.stop).toHaveBeenCalledTimes(1)
  })

  it('send() calls session.controls.send() with the text and annotation opts', async () => {
    const { cb } = makeCallbacks()
    const tm = new TurnManager(cb)
    const session = makeFakeSession()
    tm.attach(session)

    await tm.send('hello', { annotation: 'interrupted-speaking' })

    expect(session.controls.send).toHaveBeenCalledWith('hello', { annotation: 'interrupted-speaking' })
  })

  it('abort()/send() before any attach() are no-ops, never throw', async () => {
    const { cb } = makeCallbacks()
    const tm = new TurnManager(cb)
    expect(() => tm.abort()).not.toThrow()
    await expect(tm.send('x')).resolves.toBeUndefined()
  })
})
