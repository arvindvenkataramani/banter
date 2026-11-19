import { describe, expect, it } from 'vitest'
import type { RunEvent } from '@platform/voice-engine/run-event'
import type { DshEntry, DshEventChange, DshEventWindow } from './dsh-types'
import { initialReaderState, readWindow } from './run-reader'

// Windows are built in dsh's real shapes (dsh-types.ts): durable events carry
// an integer seq; a live chunk is a transient entry with a fractional seq whose
// chunk.index is the content-block index, so every text-delta of one block
// shares it. A settle replaces an attempt's transients with the durable entry;
// an abandon is the same change with no entry.

type Chunk = Extract<DshEntry, { type: 'transient' }>['event']['data']['chunk']
type Snapshot = ReturnType<typeof readWindow>['snapshot']

const text = (s: string, index = 0): Chunk => ({ type: 'text-delta', index, text: s })
const reasoning = (s: string, index = 0): Chunk => ({ type: 'reasoning-delta', index, text: s })

const assistantMessage = (blocks: unknown[]) => ({
  id: 'm',
  role: 'assistant',
  content: blocks,
  source: { kind: 'model' },
})

class Feed {
  state = initialReaderState
  entries: DshEntry[] = []
  events: RunEvent[] = []
  snapshot!: Snapshot
  private revision = 0
  private seq = 0
  private liveInGap = 0

  private deliver(change: DshEventChange): RunEvent[] {
    this.revision += 1
    const window: DshEventWindow = { entries: [...this.entries], hasMore: false, revision: this.revision, change }
    const out = readWindow(this.state, window)
    this.state = out.state
    this.snapshot = out.snapshot
    this.events.push(...out.events)
    return out.events
  }

  durable(type: string, data: unknown): DshEntry {
    this.liveInGap = 0
    return { type: 'event', event: { type, seq: (this.seq += 1), data } }
  }

  liveEntry(attemptId: string, turn: number, step: number, chunk: Chunk): DshEntry {
    this.liveInGap += 1
    return {
      type: 'transient',
      event: { type: 'assistant/live-chunk', seq: this.seq + 1 - 1 / (this.liveInGap + 1), data: { attemptId, turn, step, chunk } },
    }
  }

  /** The first window: history, delivered as a replace. */
  load(entries: DshEntry[]): RunEvent[] {
    this.entries = entries
    return this.deliver({ kind: 'replace', entries })
  }

  /** A completed earlier turn, so the first window is never empty. */
  history(): DshEntry[] {
    return [
      this.durable('turn/start', { turn: 0 }),
      this.durable('user/message', { turn: 0, step: 0, message: { id: 'u', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } }),
      this.durable('assistant/message', { turn: 0, step: 0, message: assistantMessage([{ type: 'text', text: 'Old reply.' }]), stream: [] }),
      this.durable('turn/end', { turn: 0, reason: { kind: 'completed' } }),
    ]
  }

  append(...added: DshEntry[]): RunEvent[] {
    this.entries.push(...added)
    return this.deliver({ kind: 'append', entries: added })
  }

  replace(entries: DshEntry[]): RunEvent[] {
    this.entries = entries
    return this.deliver({ kind: 'replace', entries })
  }

  startTurn(turn: number): RunEvent[] {
    return this.append(this.durable('turn/start', { turn }))
  }

  endTurn(turn: number, reason: unknown): RunEvent[] {
    return this.append(this.durable('turn/end', { turn, reason }))
  }

  live(attemptId: string, turn: number, step: number, chunk: Chunk): RunEvent[] {
    return this.append(this.liveEntry(attemptId, turn, step, chunk))
  }

  /**
   * A step's assistant message commits. dsh publishes it as a plain append and
   * keeps the attempt's transient rows until the step ends (session-controller
   * assistant-stream.ts: `publish`, `retainedAttempt`), so for a while the
   * window holds the message and the live rows that spell the same text.
   */
  commit(turn: number, step: number, blocks: unknown[]): RunEvent[] {
    return this.append(this.durable('assistant/message', { turn, step, message: assistantMessage(blocks), stream: [] }))
  }

  /** The step ends: `step/end` is appended, then the attempt's transient rows are retired by a settle with no entry. */
  endStep(attemptId: string, turn: number, step: number): RunEvent[] {
    return [...this.append(this.durable('step/end', { turn, step })), ...this.retire(attemptId)]
  }

  /** The common step: commit, then end. */
  finishStep(attemptId: string, turn: number, step: number, blocks: unknown[]): RunEvent[] {
    return [...this.commit(turn, step, blocks), ...this.endStep(attemptId, turn, step)]
  }

  /** An attempt that committed no message is abandoned: the same settle with no entry, so only the committed message tells the two apart. */
  abandon(attemptId: string): RunEvent[] {
    return this.retire(attemptId)
  }

  private retire(attemptId: string): RunEvent[] {
    this.entries = this.entries.filter(e => !(e.type === 'transient' && e.event.data.attemptId === attemptId))
    return this.deliver({ kind: 'settle-assistant', attemptId })
  }
}

const chatTexts = (events: RunEvent[], state: 'delta' | 'final' = 'delta'): string[] =>
  events.flatMap(e => (e.kind === 'chat' && e.state === state ? [e.text] : []))

function expectCumulative(texts: string[]): void {
  for (let i = 1; i < texts.length; i++) {
    expect(texts[i]?.startsWith(texts[i - 1] ?? ''), `delta ${i} extends delta ${i - 1}`).toBe(true)
  }
}

describe('run reader: what the voice engine hears of a run', () => {
  it('entries already in the first window are history: no text is emitted, no run is active, and the next run starts from empty text', () => {
    const feed = new Feed()
    expect(feed.load(feed.history()).filter(e => e.kind === 'chat')).toEqual([])
    expect(feed.snapshot).toMatchObject({ known: true, runActive: false })

    feed.startTurn(1)
    feed.live('a1', 1, 0, text('New'))
    expect(chatTexts(feed.events)).toEqual(['New'])
  })

  it('a first window that ends inside a turn sets the run state without emitting its text, and the turn\'s end closes the run', () => {
    const feed = new Feed()
    const inFlight = [
      ...feed.history(),
      feed.durable('turn/start', { turn: 1 }),
      feed.durable('assistant/message', { turn: 1, step: 0, message: assistantMessage([{ type: 'text', text: 'Partial.' }]), stream: [] }),
    ]
    expect(feed.load(inFlight).filter(e => e.kind === 'chat')).toEqual([])
    expect(feed.snapshot.runActive).toBe(true)
    expect(typeof feed.snapshot.runId).toBe('string')
    expect(feed.snapshot.runId).not.toBe('')

    feed.endTurn(1, { kind: 'completed' })
    expect(feed.snapshot.runActive).toBe(false)
  })

  it('chat deltas carry the run\'s text so far across steps: a committed step\'s text, then the next step\'s live text', () => {
    const feed = new Feed()
    feed.load(feed.history())
    feed.startTurn(1)
    feed.live('a1', 1, 0, text('First '))
    feed.live('a1', 1, 0, text('step. '))
    // The message commits while the attempt's live rows are still in the window, then the tool runs, then the step ends.
    feed.commit(1, 0, [{ type: 'text', text: 'First step. ' }, { type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{}' }])
    feed.append(feed.durable('tool/call', { turn: 1, step: 0, callId: 'call-1', name: 'read_file', arguments: '{}' }))
    feed.append(feed.durable('tool/result', { turn: 1, step: 0, message: { id: 't', role: 'tool', content: [{ type: 'text', text: 'ok' }], source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1' } }))
    feed.endStep('a1', 1, 0)
    feed.live('a2', 1, 1, text('Second '))
    feed.live('a2', 1, 1, text('step.'))

    const texts = chatTexts(feed.events)
    expectCumulative(texts)
    expect(texts.at(-1)).toBe('First step. Second step.')
  })

  it('a committed message with no live chunks still reaches the run\'s text', () => {
    // INVENTED: a message committed with no live rows before it is read as the same run text. The spec gives the formula (committed text, then live text); the precedent is dsh's own case of a controller that saw no stream start, whose settlement "publishes directly" (assistant-stream.ts, `chunk` frame).
    const feed = new Feed()
    feed.load(feed.history())
    feed.startTurn(1)
    feed.commit(1, 0, [{ type: 'text', text: 'Whole reply.' }])
    expect(chatTexts(feed.events).at(-1)).toBe('Whole reply.')
  })

  it('only visible text reaches chat: reasoning becomes thinking, cumulative; tool-call arguments never reach chat', () => {
    const feed = new Feed()
    feed.load(feed.history())
    feed.startTurn(1)
    feed.live('a1', 1, 0, reasoning('Let me'))
    feed.live('a1', 1, 0, reasoning(' think'))
    feed.live('a1', 1, 0, { type: 'tool-call-delta', index: 1, id: 'call-1', name: 'read_file', argumentsDelta: '{"path"' })

    const thinking = feed.events.flatMap(e => (e.kind === 'thinking' ? [e.text] : []))
    expect(thinking.at(-1)).toBe('Let me think')
    expectCumulative(thinking)
    expect(chatTexts(feed.events)).toEqual([])

    feed.live('a1', 1, 0, text('Answer', 2))
    feed.finishStep('a1', 1, 0, [{ type: 'reasoning', text: 'Let me think' }, { type: 'text', text: 'Answer' }, { type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{"path"}' }])
    feed.endTurn(1, { kind: 'completed' })

    const all = [...chatTexts(feed.events), ...chatTexts(feed.events, 'final')]
    expect(all.length).toBeGreaterThan(0)
    for (const t of all) expect(t).toBe('Answer')
  })

  it('live chunks of one block share chunk.index and each still counts once', () => {
    // Spec section 5: a chunk counts once per (attemptId, ordinal among the attempt's chunk entries in window order); chunk.index is the block index.
    const feed = new Feed()
    feed.load(feed.history())
    feed.startTurn(1)
    feed.live('a1', 1, 0, text('A', 0))
    feed.live('a1', 1, 0, text('B', 0))
    feed.live('a1', 1, 0, text('C', 0))
    const texts = chatTexts(feed.events)
    expectCumulative(texts)
    expect(texts.at(-1)).toBe('ABC')
  })

  it('a replace re-emits nothing already emitted, keeps known true, and delivers only the chunks it adds', () => {
    const feed = new Feed()
    feed.load(feed.history())
    feed.startTurn(1)
    feed.live('a1', 1, 0, text('A'))
    feed.live('a1', 1, 0, text('B'))

    const again = feed.replace([...feed.entries])
    expect(again).toEqual([])
    expect(feed.snapshot.known).toBe(true)

    feed.replace([...feed.entries, feed.liveEntry('a1', 1, 0, text('C'))])
    const texts = chatTexts(feed.events)
    expectCumulative(texts)
    expect(texts.at(-1)).toBe('ABC')
    expect(feed.snapshot.known).toBe(true)

    // With the message committed and the live rows still present, a resync carries the same text twice and still adds nothing.
    feed.commit(1, 0, [{ type: 'text', text: 'ABC' }])
    const settled = chatTexts(feed.events).length
    expect(feed.replace([...feed.entries])).toEqual([])
    expect(chatTexts(feed.events).length).toBe(settled)
    expect(chatTexts(feed.events).at(-1)).toBe('ABC')
  })

  it('an attempt abandoned after some text was emitted keeps that text, and the next attempt\'s text follows it', () => {
    const feed = new Feed()
    feed.load(feed.history())
    feed.startTurn(1)
    feed.live('a1', 1, 0, text('Hel'))
    feed.abandon('a1')
    feed.live('a2', 1, 0, text('World'))

    const texts = chatTexts(feed.events)
    expectCumulative(texts)
    expect(texts.at(-1)).toBe('HelWorld')

    feed.finishStep('a2', 1, 0, [{ type: 'text', text: 'World' }])
    const end = feed.endTurn(1, { kind: 'completed' })
    // Spec section 5: the final text is the run's full text, and emitted text never shrinks, so the abandoned attempt's text is part of it.
    expect(chatTexts(end, 'final')).toEqual(['HelWorld'])
  })

  describe('turn/end reasons', () => {
    const cases: Array<[string, unknown, 'final' | 'aborted' | 'error']> = [
      ['completed', { kind: 'completed' }, 'final'],
      ['max-tokens', { kind: 'max-tokens' }, 'final'],
      ['blocked', { kind: 'blocked' }, 'final'],
      ['aborted', { kind: 'aborted', reason: { kind: 'user' } }, 'aborted'],
      ['error', { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } }, 'error'],
      ['interrupted', { kind: 'interrupted' }, 'aborted'],
      ['forked', { kind: 'forked' }, 'aborted'],
    ]
    it.each(cases)('%s ends the run with exactly one terminal chat event, state %s-mapped, and no run active', (_name, reason, expected) => {
      const feed = new Feed()
      feed.load(feed.history())
      feed.startTurn(1)
      feed.live('a1', 1, 0, text('Hi '))
      feed.live('a1', 1, 0, text('there'))
      feed.finishStep('a1', 1, 0, [{ type: 'text', text: 'Hi there' }])
      const end = feed.endTurn(1, reason)

      const terminal = end.filter(e => e.kind === 'chat' && e.state !== 'delta')
      expect(terminal.map(e => (e.kind === 'chat' ? e.state : null))).toEqual([expected])
      if (expected === 'final') expect(chatTexts(end, 'final')).toEqual(['Hi there'])
      expect(feed.snapshot).toMatchObject({ runActive: false, activity: 'idle' })
    })
  })

  it('a run keeps one runId across its events and after it ends; the next run has another', () => {
    const feed = new Feed()
    feed.load(feed.history())
    feed.startTurn(1)
    feed.live('a1', 1, 0, text('Hi'))
    const first = feed.snapshot.runId
    expect(typeof first).toBe('string')
    expect(first).not.toBe('')

    feed.endTurn(1, { kind: 'completed' })
    expect(feed.snapshot).toMatchObject({ runId: first, runActive: false })
    // A resync of the window is not an attach: the engine's reset signal (a null runId with no run active) must not appear.
    feed.replace([...feed.entries])
    expect(feed.snapshot).toMatchObject({ runId: first, runActive: false })
    const runEvents = feed.events.filter(e => 'runId' in e)
    expect(runEvents.length).toBeGreaterThan(0)
    for (const e of runEvents) expect('runId' in e && e.runId).toBe(first)

    feed.startTurn(2)
    feed.live('a2', 2, 0, text('Yo'))
    expect(feed.snapshot.runId).not.toBeNull()
    expect(feed.snapshot.runId).not.toBe(first)
    expect(chatTexts(feed.events).at(-1)).toBe('Yo')
  })

  it('the first live chunk of a turn opens a run even with no turn/start in the window', () => {
    const feed = new Feed()
    feed.load(feed.history())
    feed.live('a1', 1, 0, text('Hi'))
    expect(feed.snapshot.runActive).toBe(true)
    expect(feed.snapshot.runId).not.toBeNull()
    expect(chatTexts(feed.events)).toEqual(['Hi'])
  })

  it('a tool call emits one start and one result carrying its call id, start first', () => {
    // INVENTED: the durable tool/call and tool/result entries stand for a call's start and end; which dsh entry marks a start is unspecified, so the sequence is dsh's real one (committed message with the tool-call block, then tool/call, then tool/result) and only the counts and order are asserted.
    const feed = new Feed()
    feed.load(feed.history())
    feed.startTurn(1)
    feed.live('a1', 1, 0, text('Checking.'))
    feed.commit(1, 0, [{ type: 'text', text: 'Checking.' }, { type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{}' }])
    feed.append(feed.durable('tool/call', { turn: 1, step: 0, callId: 'call-1', name: 'read_file', arguments: '{}' }))
    feed.append(feed.durable('tool/result', { turn: 1, step: 0, message: { id: 't', role: 'tool', content: [{ type: 'text', text: 'ok' }], source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1' } }))

    const tools = feed.events.flatMap(e => (e.kind === 'tool' ? [e] : []))
    const starts = tools.filter(e => e.phase === 'start')
    const results = tools.filter(e => e.phase === 'result')
    expect(starts).toHaveLength(1)
    expect(starts[0]).toMatchObject({ toolCallId: 'call-1', name: 'read_file' })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ toolCallId: 'call-1' })
    expect(tools.indexOf(starts[0]!)).toBeLessThan(tools.indexOf(results[0]!))
  })

  it('activity is the dashboard\'s: idle, active, thinking, speaking, tool while a tool is open, active after its result, idle at the end', () => {
    // INVENTED: a durable tool/call entry opens a tool (see the tool-call test above).
    const feed = new Feed()
    feed.load(feed.history())
    expect(feed.snapshot.activity).toBe('idle')

    feed.startTurn(1)
    expect(feed.snapshot.activity).toBe('active')
    feed.live('a1', 1, 0, reasoning('Hmm'))
    expect(feed.snapshot.activity).toBe('thinking')
    feed.live('a1', 1, 0, text('Okay', 1))
    expect(feed.snapshot.activity).toBe('speaking')
    feed.append(feed.durable('tool/call', { turn: 1, step: 0, callId: 'call-1', name: 'read_file', arguments: '{}' }))
    expect(feed.snapshot.activity).toBe('tool')
    feed.live('a1', 1, 0, text(' more', 1))
    expect(feed.snapshot.activity).toBe('tool')
    feed.append(feed.durable('tool/result', { turn: 1, step: 0, message: { id: 't', role: 'tool', content: [{ type: 'text', text: 'ok' }], source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1' } }))
    expect(feed.snapshot.activity).toBe('active')
    feed.endTurn(1, { kind: 'completed' })
    expect(feed.snapshot.activity).toBe('idle')
  })
})
