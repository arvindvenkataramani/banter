import { describe, expect, test } from 'vitest'
import { seedFromHistory, applyLiveRun, finalizeRun, type ConversationItem } from './conversation'
import { initialRunState, reduceRunEvent, normalizeAgentEvent, chatToRunEvent, type RunEvent, type RunState } from './run-state'

// History-row fixtures. The toolCall/toolResult shapes below (id/name/
// arguments on the call, top-level role:'toolResult' row with toolCallId/
// isError/content on the result) are the real OpenClaw 2026.7.1 chat.history
// shape, confirmed against a live gateway on 2026-08-09 — it replaced an
// earlier set of untested field-name guesses. The tool_use/nested-tool_result
// fixtures further down exercise a second, still-unconfirmed convention kept
// as a tolerant fallback.

const SESSION_KEY = 'agent:example:probe'

describe('seedFromHistory', () => {
  test('plain string content -> text item, anchored on __openclaw.id', () => {
    const rows = [
      { role: 'user', content: 'move outlook to 7:30', __openclaw: { id: 'abc123', seq: 1 } },
      { role: 'assistant', content: 'done', __openclaw: { id: 'def456', seq: 2 } },
    ]
    const items = seedFromHistory(rows)
    expect(items).toEqual([
      { id: 'hist-abc123', kind: 'user-message', text: 'move outlook to 7:30' },
      { id: 'hist-def456', kind: 'assistant-text', text: 'done' },
    ])
  })

  test('block-array content -> text extracted, no-tool rows are text only', () => {
    const rows = [
      { role: 'assistant', content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'there.' }], __openclaw: { id: 'x1', seq: 1 } },
    ]
    const items = seedFromHistory(rows)
    expect(items).toEqual([{ id: 'hist-x1', kind: 'assistant-text', text: 'Hello there.' }])
  })

  test('falls back to hist-seq-N when __openclaw.id is absent, then hist-idx-N when neither is present', () => {
    const rows = [
      { role: 'user', content: 'a', __openclaw: { seq: 7 } },
      { role: 'assistant', content: 'b' },
    ]
    const items = seedFromHistory(rows)
    expect(items[0].id).toBe('hist-seq-7')
    expect(items[1].id).toBe('hist-idx-1')
  })

  test('rows whose extracted text is empty are dropped, not rendered as blank items', () => {
    const rows = [
      { role: 'user', content: '', __openclaw: { id: 'empty1' } },
      { role: 'assistant', content: 'real text', __openclaw: { id: 'real1' } },
    ]
    const items = seedFromHistory(rows)
    expect(items).toEqual([{ id: 'hist-real1', kind: 'assistant-text', text: 'real text' }])
  })

  test('tool_use block (Anthropic-style) with no matching result -> status unknown, not done', () => {
    const rows = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Running a command.' },
          { type: 'tool_use', id: 'tu_1', name: 'exec', input: { command: 'echo hi' } },
        ],
        __openclaw: { id: 'r1' },
      },
    ]
    const items = seedFromHistory(rows)
    expect(items).toEqual([
      { id: 'hist-r1', kind: 'assistant-text', text: 'Running a command.' },
      { id: 'hist-tool-tu_1', kind: 'tool-card', title: 'exec: echo hi', status: 'unknown' },
    ])
  })

  // Real captured shape (2026-08-09): a `read` call's argument is `path`,
  // not `command` — the title builder needs more than one recognized key or
  // every non-exec tool loses its argument entirely.
  test('a toolCall whose argument is "path" (e.g. read) includes it in the title too', () => {
    const rows = [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tu_read', name: 'read', arguments: { path: '/home/user/.openclaw/workspace/AGENTS.md' } }],
        __openclaw: { id: 'r1' },
      },
    ]
    const items = seedFromHistory(rows)
    const card = items.find((i) => i.kind === 'tool-card')
    expect(card && (card as { title: string }).title).toBe('read: /home/user/.openclaw/workspace/AGENTS.md')
  })

  test('toolCall block (OpenClaw-style) with no matching result -> status unknown, keyed by toolCallId when present', () => {
    const rows = [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', toolCallId: 'toolu_ABC', name: 'exec' }],
        __openclaw: { id: 'r2' },
      },
    ]
    const items = seedFromHistory(rows)
    expect(items).toEqual([{ id: 'hist-tool-toolu_ABC', kind: 'tool-card', title: 'exec', status: 'unknown' }])
  })

  // Real shape, confirmed 2026-08-09 against live chat.history (Decision 3):
  // the result is a top-level sibling row with role:'toolResult', not a
  // tool_result-typed content block. A successful call only becomes 'done'
  // once this row is seen — never assumed from the call alone.
  test('top-level toolResult row (real OpenClaw shape) with isError:false flips the matching card to done', () => {
    const rows = [
      { role: 'assistant', content: [{ type: 'toolCall', id: 'tc1', name: 'exec' }], __openclaw: { id: 'r1' } },
      { role: 'toolResult', toolCallId: 'tc1', toolName: 'exec', content: [{ type: 'text', text: 'ok' }], isError: false, __openclaw: { id: 'r2' } },
    ]
    const items = seedFromHistory(rows)
    const card = items.find((i) => i.kind === 'tool-card')
    expect(card).toEqual({ id: 'hist-tool-tc1', kind: 'tool-card', title: 'exec', status: 'done' })
  })

  test('a toolCall with no toolResult row at all (real abort case: gateway never writes one) stays unknown forever', () => {
    const rows = [
      { role: 'user', content: 'run sleep 20', __openclaw: { id: 'u1' } },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'tc2', name: 'exec' }], __openclaw: { id: 'r1' } },
    ]
    const items = seedFromHistory(rows)
    const card = items.find((i) => i.kind === 'tool-card')
    expect(card && (card as { status: string }).status).toBe('unknown')
  })

  // A real toolResult row is never an abort artifact — an abort produces no
  // row at all (see the 'stays unknown forever' test above). 'interrupted' is
  // a live-only status; history can only ever say error or done.
  test('top-level toolResult row with isError:true flips the matching card to error, never interrupted', () => {
    const rows = [
      { role: 'assistant', content: [{ type: 'toolCall', id: 'tc3', name: 'exec' }], __openclaw: { id: 'r1' } },
      { role: 'toolResult', toolCallId: 'tc3', toolName: 'exec', content: [{ type: 'text', text: 'permission denied' }], isError: true, __openclaw: { id: 'r2' } },
    ]
    const items = seedFromHistory(rows)
    const card = items.find((i) => i.kind === 'tool-card')
    expect(card && (card as { status: string }).status).toBe('error')
  })

  test('abort artifact style 1 (synthetic repair result) flips the matching card to interrupted, not error', () => {
    const rows = [
      { role: 'assistant', content: [{ type: 'toolCall', toolCallId: 't1', name: 'exec' }], __openclaw: { id: 'r1' } },
      {
        role: 'tool_result',
        content: [{ type: 'tool_result', toolCallId: 't1', isError: true, text: 'missing tool result in session history; inserted synthetic error result for transcript repair' }],
        __openclaw: { id: 'r2' },
      },
    ]
    const items = seedFromHistory(rows)
    const card = items.find((i) => i.kind === 'tool-card')
    expect(card).toEqual({ id: 'hist-tool-t1', kind: 'tool-card', title: 'exec', status: 'interrupted' })
  })

  test('abort artifact style 2 (explicit "This operation was aborted") also flips to interrupted', () => {
    const rows = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'process_poll' }], __openclaw: { id: 'r1' } },
      { role: 'tool_result', content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, text: 'This operation was aborted' }], __openclaw: { id: 'r2' } },
    ]
    const items = seedFromHistory(rows)
    const card = items.find((i) => i.kind === 'tool-card')
    expect(card && (card as { status: string }).status).toBe('interrupted')
  })

  test('a genuine (non-abort) tool error flips the card to error, not interrupted — never presenting abort as failure implies the reverse too', () => {
    const rows = [
      { role: 'assistant', content: [{ type: 'toolCall', toolCallId: 't3', name: 'exec' }], __openclaw: { id: 'r1' } },
      { role: 'tool_result', content: [{ type: 'tool_result', toolCallId: 't3', isError: true, text: 'permission denied' }], __openclaw: { id: 'r2' } },
    ]
    const items = seedFromHistory(rows)
    const card = items.find((i) => i.kind === 'tool-card')
    expect(card && (card as { status: string }).status).toBe('error')
  })

  test('an orphaned result block with no matching call is tolerated, changes nothing', () => {
    const rows = [
      { role: 'tool_result', content: [{ type: 'tool_result', toolCallId: 'ghost', isError: true, text: 'This operation was aborted' }], __openclaw: { id: 'r1' } },
    ]
    expect(() => seedFromHistory(rows)).not.toThrow()
    expect(seedFromHistory(rows)).toEqual([])
  })

  test('paging prepend: offset keeps positional fallback ids unique across pages', () => {
    const older = [{ role: 'user', content: 'older msg' }]
    const items = seedFromHistory(older, 50)
    expect(items[0].id).toBe('hist-idx-50')
  })
})

describe('applyLiveRun', () => {
  function runWith(events: RunEvent[]): RunState {
    return events.reduce((s, e) => reduceRunEvent(s, e), initialRunState)
  }

  const RUN_ID = 'run-1'
  const lifecycleStart = { runId: RUN_ID, sessionKey: SESSION_KEY, stream: 'lifecycle', data: { phase: 'start', startedAt: 1 } }
  const toolStart = { runId: RUN_ID, sessionKey: SESSION_KEY, stream: 'tool', data: { phase: 'start', name: 'exec', toolCallId: 'tc1' } }
  const toolResult = { runId: RUN_ID, sessionKey: SESSION_KEY, stream: 'tool', data: { phase: 'result', name: 'exec', toolCallId: 'tc1', isError: false } }

  test('pure text run (no tools) -> single streaming assistant-text segment', () => {
    const run = runWith([chatToRunEvent({ runId: RUN_ID, sessionKey: SESSION_KEY, seq: 1, state: 'delta', message: 'Hello there' }, 1)])
    const items = applyLiveRun([], run)
    expect(items).toEqual([{ id: `live:${RUN_ID}:text:0`, kind: 'assistant-text', runId: RUN_ID, text: 'Hello there', isStreaming: true }])
  })

  test('text then tool -> segments interleaved with a tool card at the mark offset', () => {
    const run = runWith([
      normalizeAgentEvent(lifecycleStart, 1) as RunEvent,
      chatToRunEvent({ runId: RUN_ID, sessionKey: SESSION_KEY, seq: 1, state: 'delta', message: 'Running a command now.' }, 2),
      normalizeAgentEvent(toolStart, 3) as RunEvent,
    ])
    const items = applyLiveRun([], run)
    expect(items).toEqual([
      { id: `live:${RUN_ID}:text:0`, kind: 'assistant-text', runId: RUN_ID, text: 'Running a command now.', isStreaming: true },
      { id: `live:${RUN_ID}:tool:tc1`, kind: 'tool-card', title: 'exec', status: 'running' },
    ])
  })

  test('idempotent under repeated cumulative updates: rebuilding with more text replaces, never duplicates, the live segments', () => {
    const runAfterFirst = runWith([chatToRunEvent({ runId: RUN_ID, sessionKey: SESSION_KEY, seq: 1, state: 'delta', message: 'Hello' }, 1)])
    const firstPass = applyLiveRun([], runAfterFirst)

    const runAfterSecond = reduceRunEvent(runAfterFirst, chatToRunEvent({ runId: RUN_ID, sessionKey: SESSION_KEY, seq: 2, state: 'delta', message: 'Hello there' }, 2))
    const secondPass = applyLiveRun(firstPass, runAfterSecond)

    expect(secondPass).toEqual([{ id: `live:${RUN_ID}:text:0`, kind: 'assistant-text', runId: RUN_ID, text: 'Hello there', isStreaming: true }])
    expect(secondPass.length).toBe(1) // not 2 — the stale segment from firstPass was replaced, not appended alongside
  })

  test('idempotent when applied twice with the exact same run state', () => {
    const run = runWith([
      normalizeAgentEvent(lifecycleStart, 1) as RunEvent,
      chatToRunEvent({ runId: RUN_ID, sessionKey: SESSION_KEY, seq: 1, state: 'delta', message: 'text' }, 2),
      normalizeAgentEvent(toolStart, 3) as RunEvent,
    ])
    const once = applyLiveRun([], run)
    const twice = applyLiveRun(once, run)
    expect(twice).toEqual(once)
  })

  test('history-seeded items before the live run are preserved untouched', () => {
    const history: ConversationItem[] = [{ id: 'hist-1', kind: 'user-message', text: 'earlier message' }]
    const run = runWith([chatToRunEvent({ runId: RUN_ID, sessionKey: SESSION_KEY, seq: 1, state: 'delta', message: 'reply' }, 1)])
    const items = applyLiveRun(history, run)
    expect(items[0]).toEqual(history[0])
    expect(items.length).toBe(2)
  })

  test('a tool card reflects a live status transition (running -> done) on rebuild', () => {
    const runRunning = runWith([normalizeAgentEvent(lifecycleStart, 1) as RunEvent, normalizeAgentEvent(toolStart, 2) as RunEvent])
    const running = applyLiveRun([], runRunning)
    expect((running[0] as { status: string }).status).toBe('running')

    const runDone = reduceRunEvent(runRunning, normalizeAgentEvent(toolResult, 3) as RunEvent)
    const done = applyLiveRun(running, runDone)
    expect((done[0] as { status: string }).status).toBe('done')
    expect(done.length).toBe(1) // still one card, not duplicated
  })

  test('a run with no runId (never started) leaves items untouched', () => {
    const items: ConversationItem[] = [{ id: 'hist-1', kind: 'user-message', text: 'x' }]
    expect(applyLiveRun(items, initialRunState)).toEqual(items)
  })
})

describe('finalizeRun', () => {
  function runWith(events: RunEvent[]): RunState {
    return events.reduce((s, e) => reduceRunEvent(s, e), initialRunState)
  }

  const RUN_ID = 'run-2'

  test('settles isStreaming to false on the run\'s text segments, regardless of runActive at call time', () => {
    const run = runWith([chatToRunEvent({ runId: RUN_ID, sessionKey: SESSION_KEY, seq: 1, state: 'delta', message: 'streaming...' }, 1)])
    const live = applyLiveRun([], run)
    expect((live[0] as { isStreaming?: boolean }).isStreaming).toBe(true)

    const finalized = finalizeRun(live, run)
    expect((finalized[0] as { isStreaming?: boolean }).isStreaming).toBe(false)
  })

  test('after a real run end, open tools are already interrupted by the reducer and finalizeRun preserves that', () => {
    const lifecycleStart = { runId: RUN_ID, sessionKey: SESSION_KEY, stream: 'lifecycle', data: { phase: 'start', startedAt: 1 } }
    const toolStart = { runId: RUN_ID, sessionKey: SESSION_KEY, stream: 'tool', data: { phase: 'start', name: 'exec', toolCallId: 'tc1' } }
    const lifecycleEnd = { runId: RUN_ID, sessionKey: SESSION_KEY, stream: 'lifecycle', data: { phase: 'end', stopReason: 'abort', aborted: true } }
    let run = runWith([normalizeAgentEvent(lifecycleStart, 1) as RunEvent, normalizeAgentEvent(toolStart, 2) as RunEvent])
    const live = applyLiveRun([], run)
    run = reduceRunEvent(run, normalizeAgentEvent(lifecycleEnd, 3) as RunEvent)
    const finalized = finalizeRun(live, run)
    expect((finalized[0] as { status: string }).status).toBe('interrupted')
  })
})
