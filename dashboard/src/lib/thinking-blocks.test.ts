import { describe, expect, test } from 'vitest'
import { seedFromHistory, applyLiveRun, type ConversationItem } from './conversation'
import { initialRunState, reduceRunEvent, normalizeAgentEvent } from './run-state'
import { extractMessageText } from './gateway-utils'

// Behavioural contract for dev/design/chat-thinking-rendering.md.
//
// Fixtures are lifted from control/probe/captures/2026-09-01T02-44-20.jsonl
// (scenario multi-tool, qwen3.6-35b-a3b), where the model reasons, calls four
// tools, then reasons again in the same turn. The live `thinking` stream
// carries `{text, delta}` with `text` cumulative-so-far, and every event
// envelope carries a run-wide monotonic `seq` — reasoning at 5–28, tool
// activity at 31–47, reasoning again at 75–134.
//
// These tests describe what the conversation layer must produce, not how it
// assembles it: the design draws a seam at the block model, and the rendering
// behaviour is specified against that model rather than against wire events.

const SESSION_KEY = 'agent:undersoot:probe'
const RUN = 'probe-1788230673029-9ne9sdeyd1'

function thinking(text: string, seq: number, delta = '') {
  return { runId: RUN, sessionKey: SESSION_KEY, stream: 'thinking', seq, data: { text, delta } }
}

function toolStart(toolCallId: string, seq: number, name = 'exec') {
  return { runId: RUN, sessionKey: SESSION_KEY, stream: 'tool', seq, data: { phase: 'start', name, toolCallId } }
}

function toolResult(toolCallId: string, seq: number, name = 'exec') {
  return { runId: RUN, sessionKey: SESSION_KEY, stream: 'tool', seq, data: { phase: 'result', name, toolCallId } }
}

function ingest(events: unknown[]) {
  let state = initialRunState
  for (const e of events) {
    const normalized = normalizeAgentEvent(e, 1)
    if (normalized) state = reduceRunEvent(state, normalized)
  }
  return state
}

function blocksOf(items: ConversationItem[]) {
  return items.map((i) => i.kind)
}

describe('reasoning survives normalization', () => {
  // The design names two sites that currently discard reasoning. This is the
  // live one: the normalizer kept only the fact that a thinking event
  // occurred, dropping its payload.
  test('a thinking event carries its reasoning text, not just the fact it happened', () => {
    const event = normalizeAgentEvent(thinking('The user wants me to', 9, ' user wants me to'), 1)
    expect(event).toMatchObject({ kind: 'thinking', runId: RUN })
    expect(JSON.stringify(event)).toContain('The user wants me to')
  })

  test('reasoning text accumulates across deltas into one block', () => {
    const state = ingest([thinking('The', 5, 'The'), thinking('The user', 9, ' user'), thinking('The user wants', 15, ' wants')])
    const items = applyLiveRun([], state)
    const reasoning = items.filter((i) => i.kind === 'thinking')
    expect(reasoning).toHaveLength(1)
    expect((reasoning[0] as { text: string }).text).toBe('The user wants')
  })
})

describe('reasoning interleaves with tool calls', () => {
  // Measured on the wire: reasoning is not always-first-and-once. A reasoning
  // model reasons, acts, then reasons about the results. Anything that
  // prepends reasoning and leaves the rest alone is wrong for this turn.
  const turn = [
    thinking('First thought', 5, 'First thought'),
    toolStart('call-1', 31),
    toolResult('call-1', 40),
    thinking('Second thought', 75, 'Second thought'),
  ]

  test('a turn holds two reasoning blocks when the model reasons after a tool result', () => {
    const items = applyLiveRun([], ingest(turn))
    expect(items.filter((i) => i.kind === 'thinking')).toHaveLength(2)
  })

  test('the second reasoning block renders after the tool card, not before it', () => {
    const items = applyLiveRun([], ingest(turn))
    expect(blocksOf(items)).toEqual(['thinking', 'tool-card', 'thinking'])
  })

  test('the two reasoning blocks keep their own text rather than merging', () => {
    const items = applyLiveRun([], ingest(turn))
    const texts = items.filter((i) => i.kind === 'thinking').map((i) => (i as { text: string }).text)
    expect(texts).toEqual(['First thought', 'Second thought'])
  })

  // The boundary: cumulative text resetting to a shorter length is a new
  // block. Both sides tested — growth continues a block, a reset starts one.
  test('reasoning text that grows continues the same block', () => {
    const state = ingest([thinking('abc', 5), thinking('abcdef', 9)])
    expect(applyLiveRun([], state).filter((i) => i.kind === 'thinking')).toHaveLength(1)
  })

  test('reasoning text that restarts shorter begins a second block', () => {
    const state = ingest([thinking('abcdef', 5), thinking('ab', 75)])
    expect(applyLiveRun([], state).filter((i) => i.kind === 'thinking')).toHaveLength(2)
  })
})

describe('running versus settled', () => {
  // "Running means the settled message has not arrived yet" — not a timer,
  // not a closing tag. Only the last block of a still-streaming message runs.
  test('the trailing reasoning block of an active run is streaming', () => {
    const items = applyLiveRun([], ingest([thinking('still going', 5)]))
    const last = items[items.length - 1] as { isStreaming?: boolean }
    expect(last.isStreaming).toBe(true)
  })

  test('an earlier reasoning block is settled while a later one still streams', () => {
    const state = ingest([thinking('first', 5), toolStart('c1', 31), toolResult('c1', 40), thinking('second', 75)])
    const reasoning = applyLiveRun([], state).filter((i) => i.kind === 'thinking') as { isStreaming?: boolean }[]
    expect(reasoning[0].isStreaming).toBe(false)
    expect(reasoning[1].isStreaming).toBe(true)
  })

  test('every reasoning block is settled once the run ends', () => {
    const state = ingest([
      thinking('done thinking', 5),
      { runId: RUN, sessionKey: SESSION_KEY, stream: 'lifecycle', seq: 200, data: { phase: 'end', stopReason: 'stop' } },
    ])
    const reasoning = applyLiveRun([], state).filter((i) => i.kind === 'thinking') as { isStreaming?: boolean }[]
    // Asserted before the loop: iterating an empty array would otherwise
    // report green through an implementation that settles nothing.
    expect(reasoning.length).toBeGreaterThan(0)
    for (const block of reasoning) expect(block.isStreaming).toBe(false)
  })
})

describe('reasoning from history', () => {
  // The design's fourth ingestion case is "structured blocks only at commit":
  // the row arrives settled, with no live view.
  test('a thinking block in a history row becomes a settled reasoning item', () => {
    const rows = [
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'Let me check.' }, { type: 'text', text: 'Checked.' }],
        __openclaw: { id: 'h1', seq: 1 },
      },
    ]
    const items = seedFromHistory(rows)
    expect(blocksOf(items)).toEqual(['thinking', 'assistant-text'])
    expect((items[0] as { isStreaming?: boolean }).isStreaming).toBeFalsy()
  })

  test('history preserves reasoning that appears after a tool call', () => {
    const rows = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Plan it.' },
          { type: 'toolCall', id: 'tc1', name: 'exec', arguments: { command: 'echo one' } },
          { type: 'thinking', thinking: 'Read the result.' },
        ],
        __openclaw: { id: 'h2', seq: 2 },
      },
    ]
    expect(blocksOf(seedFromHistory(rows))).toEqual(['thinking', 'tool-card', 'thinking'])
  })

  // Measured: a turn carrying commentary before a tool call is served as two
  // rows sharing one __openclaw.id. They are one displayed turn.
  test('the two rows of a split turn merge into one ordered sequence', () => {
    const rows = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'About to run it.' }],
        openclawStreamFallback: { replacementText: 'About to run it.', source: 'segment', itemId: 'commentary-0' },
        __openclaw: { id: 'shared-id', seq: 32 },
      },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Reasoning here.' },
          { type: 'toolCall', id: 'tc9', name: 'exec', arguments: { command: 'echo one' } },
        ],
        __openclaw: { id: 'shared-id', seq: 32 },
      },
    ]
    const items = seedFromHistory(rows)
    const ids = items.map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(items.filter((i) => i.kind === 'assistant-text')).toHaveLength(1)
    expect(items.filter((i) => i.kind === 'thinking')).toHaveLength(1)
  })

  // "History renders identically to live" — the design states this as a
  // constraint, so it is asserted directly rather than implied.
  test('the same turn produces the same block sequence live and from history', () => {
    const live = blocksOf(
      applyLiveRun([], ingest([thinking('Plan it.', 5), toolStart('tc1', 31), toolResult('tc1', 40), thinking('Read it.', 75)]))
    )
    const fromHistory = blocksOf(
      seedFromHistory([
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Plan it.' },
            { type: 'toolCall', id: 'tc1', name: 'exec', arguments: {} },
            { type: 'thinking', thinking: 'Read it.' },
          ],
          __openclaw: { id: 'h3', seq: 3 },
        },
      ])
    )
    expect(live).toEqual(fromHistory)
  })
})

describe('reasoning never reaches the speech path', () => {
  // The design's hard constraint. extractMessageText is the speech path's
  // input, so widening it to include reasoning is the failure this prevents.
  test('extracting message text from a turn with reasoning yields only the reply', () => {
    const row = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Secret reasoning the user must never hear.' },
        { type: 'text', text: 'The visible answer.' },
      ],
    }
    const spoken = extractMessageText(row)
    expect(spoken).toBe('The visible answer.')
    expect(spoken).not.toContain('Secret reasoning')
  })

  test('a turn that is only reasoning yields no speakable text at all', () => {
    const row = { role: 'assistant', content: [{ type: 'thinking', thinking: 'Thinking out loud.' }] }
    expect(extractMessageText(row)).toBe('')
  })
})

describe('turns without reasoning are unchanged', () => {
  // The design's fourth ingestion case: nothing arrives, so nothing changes.
  test('a plain text turn produces no reasoning block', () => {
    const items = seedFromHistory([
      { role: 'assistant', content: [{ type: 'text', text: 'Just an answer.' }], __openclaw: { id: 'h4', seq: 4 } },
    ])
    expect(blocksOf(items)).toEqual(['assistant-text'])
  })

  // Both tests below open the run with lifecycle:start, so the empty
  // reasoning list they assert is produced by a live run holding no
  // reasoning — not by no run existing, which would be true for the wrong
  // reason and stay true however the feature behaves.
  const lifecycleStart = { runId: RUN, sessionKey: SESSION_KEY, stream: 'lifecycle', seq: 3, data: { phase: 'start', startedAt: 1 } }

  test('a run with no thinking events produces its tool card and no reasoning block', () => {
    const state = ingest([lifecycleStart, toolStart('c1', 31), toolResult('c1', 40)])
    const items = applyLiveRun([], state)
    expect(items.filter((i) => i.kind === 'tool-card')).toHaveLength(1)
    expect(items.filter((i) => i.kind === 'thinking')).toHaveLength(0)
  })

  test('an empty reasoning delta does not open a block', () => {
    const state = ingest([lifecycleStart, thinking('', 5, ''), toolStart('c1', 31)])
    const items = applyLiveRun([], state)
    expect(items.filter((i) => i.kind === 'tool-card')).toHaveLength(1)
    expect(items.filter((i) => i.kind === 'thinking')).toHaveLength(0)
  })
})

describe('reasoning does not disturb existing ordering', () => {
  // Guards the fix in 52ba62f: a rebuild must not move a run's items. The
  // block model changes what a run contains, never where it sits.
  test('a run carrying reasoning still holds its position when it gets another event', () => {
    const before: ConversationItem[] = [
      { id: 'hist-1', kind: 'user-message', text: 'first question' },
      { id: 'hist-2', kind: 'assistant-text', text: 'first answer' },
      { id: 'pending-1', kind: 'user-message', text: 'second question' },
    ]
    const state = ingest([thinking('reasoning', 5)])
    const after = applyLiveRun(before, state)
    expect(after.slice(0, 3).map((i) => i.id)).toEqual(['hist-1', 'hist-2', 'pending-1'])
  })
})
