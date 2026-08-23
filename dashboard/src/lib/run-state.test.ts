import { describe, expect, test } from 'vitest'
import {
  initialRunState,
  reduceRunEvent,
  normalizeAgentEvent,
  normalizeSessionToolEvent,
  chatToRunEvent,
  type RunEvent,
  type RunState,
} from './run-state'
import type { ChatEventPayload } from './gateway-types'

// Fixtures below are trimmed to the fields normalizeAgentEvent actually reads
// (runId/sessionKey/stream/data), lifted from real probe captures rather than
// invented. Tool-phase fixtures: control/probe/captures/2026-08-07T06-56-50.jsonl.
// Lifecycle 'start' fixture: control/probe/captures/2026-08-09T04-56-42.jsonl
// (its only entry). Other lifecycle phases and the lifecycle 'error' fixture
// come from the same 06-56-50 run and from 2026-08-07T06-30-20.jsonl respectively,
// since 04-56-42 carries no other phases.

const RUN_A = 'probe-1786085822762-lpdiyemq03'
const TOOL_CALL_A = 'toolu_01YRVMtXVqKXLTDxdyYtJEMM'
const SESSION_KEY = 'agent:example:probe'

const toolStart = {
  runId: RUN_A,
  sessionKey: SESSION_KEY,
  stream: 'tool',
  data: { phase: 'start', name: 'exec', toolCallId: TOOL_CALL_A, args: { command: 'sleep 8 && echo probe-slow-done' } },
}

const toolUpdate = {
  runId: RUN_A,
  sessionKey: SESSION_KEY,
  stream: 'tool',
  data: { phase: 'update', name: 'exec', toolCallId: TOOL_CALL_A, partialResult: { content: [{ type: 'text', text: 'probe-slow-done\n' }] } },
}

const toolResult = {
  runId: RUN_A,
  sessionKey: SESSION_KEY,
  stream: 'tool',
  data: { phase: 'result', name: 'exec', toolCallId: TOOL_CALL_A, isError: false, meta: 'run sleep 8 → print text', result: { content: [{ type: 'text', text: 'probe-slow-done' }] } },
}

const toolResultError = {
  runId: RUN_A,
  sessionKey: SESSION_KEY,
  stream: 'tool',
  data: { phase: 'result', name: 'exec', toolCallId: TOOL_CALL_A, isError: true, result: { content: [{ type: 'text', text: 'boom' }] } },
}

// control/probe/captures/2026-08-09T04-56-42.jsonl — its only entry
const lifecycleStartFrom0456 = {
  runId: 'probe-1786251414522-1hy5kdem90v',
  sessionKey: SESSION_KEY,
  stream: 'lifecycle',
  data: { phase: 'start', startedAt: 1786251418072 },
}

const lifecycleStart = {
  runId: RUN_A,
  sessionKey: SESSION_KEY,
  stream: 'lifecycle',
  data: { phase: 'start', startedAt: 1786085825493 },
}

const lifecycleFinishing = {
  runId: RUN_A,
  sessionKey: SESSION_KEY,
  stream: 'lifecycle',
  data: { phase: 'finishing', stopReason: 'stop', aborted: false, livenessState: 'working', replayInvalid: true, endedAt: 1786085840879 },
}

const lifecycleEnd = {
  runId: RUN_A,
  sessionKey: SESSION_KEY,
  stream: 'lifecycle',
  data: { phase: 'end', stopReason: 'stop', aborted: false, livenessState: 'working', replayInvalid: true, endedAt: 1786085841059 },
}

// control/probe/captures/2026-08-07T06-30-20.jsonl
const lifecycleError = {
  runId: 'probe-1786084176382-ccs74xf6gqs',
  sessionKey: SESSION_KEY,
  stream: 'lifecycle',
  data: {
    phase: 'error',
    endedAt: 1786084221222,
    error: 'session file changed while embedded prompt lock was released: /home/user/.openclaw/agents/example/sessions/7b17c59b-20b0-4844-94cf-539f279d4cdc.jsonl',
    fallbackExhaustedFailure: true,
  },
}

const itemTool = {
  runId: RUN_A,
  sessionKey: SESSION_KEY,
  stream: 'item',
  data: { itemId: `tool:${TOOL_CALL_A}`, phase: 'start', kind: 'tool', title: 'exec run sleep 8 → print text', status: 'running', name: 'exec', toolCallId: TOOL_CALL_A, startedAt: 1786085829362 },
}

const itemCommand = {
  runId: RUN_A,
  sessionKey: SESSION_KEY,
  stream: 'item',
  data: { itemId: `command:${TOOL_CALL_A}`, phase: 'start', kind: 'command', title: 'command run sleep 8 → print text', status: 'running', name: 'exec', toolCallId: TOOL_CALL_A, startedAt: 1786085829362 },
}

const thinkingFrame = {
  runId: RUN_A,
  sessionKey: SESSION_KEY,
  stream: 'thinking',
  data: { text: 'The user is asking', delta: 'The user is asking' },
}

// No compaction event exists in either named capture (or any capture on disk —
// verified by search across the whole captures/ dir). Synthesized from the
// existing production consumer's type, not invented: dashboard/src/lib/
// gateway-connection.ts CompactionEventData ({ phase, completed?, willRetry? }),
// already handled by Session.applyCompactionEvent.
const compactionStart = { sessionKey: SESSION_KEY, stream: 'compaction', data: { phase: 'start' } }
const compactionEndRetrying = { sessionKey: SESSION_KEY, stream: 'compaction', data: { phase: 'end', completed: true, willRetry: true } }
const compactionEndComplete = { sessionKey: SESSION_KEY, stream: 'compaction', data: { phase: 'end', completed: true } }
const compactionEndFailed = { sessionKey: SESSION_KEY, stream: 'compaction', data: { phase: 'end', completed: false } }

// Real but unmapped streams observed in the same captures — evidence that the
// normalizer must tolerate more stream kinds than the plan enumerates.
const assistantStream = {
  runId: RUN_A,
  sessionKey: SESSION_KEY,
  stream: 'assistant',
  data: { text: "I'm going to execute a shell command", delta: "I'm going to execute a shell command" },
}

const commandOutputStream = {
  runId: RUN_A,
  sessionKey: SESSION_KEY,
  stream: 'command_output',
  data: { itemId: `command:${TOOL_CALL_A}`, phase: 'delta', toolCallId: TOOL_CALL_A, name: 'exec', output: 'probe-slow-done', status: 'running' },
}

describe('normalizeAgentEvent', () => {
  test('tool start', () => {
    const e = normalizeAgentEvent(toolStart, 100)
    expect(e).toEqual({ kind: 'tool', runId: RUN_A, phase: 'start', toolCallId: TOOL_CALL_A, name: 'exec', isError: undefined, at: 100 })
  })

  test('tool update', () => {
    const e = normalizeAgentEvent(toolUpdate, 101)
    expect(e).toEqual({ kind: 'tool', runId: RUN_A, phase: 'update', toolCallId: TOOL_CALL_A, name: 'exec', isError: undefined, at: 101 })
  })

  test('tool result (success)', () => {
    const e = normalizeAgentEvent(toolResult, 102)
    expect(e).toEqual({ kind: 'tool', runId: RUN_A, phase: 'result', toolCallId: TOOL_CALL_A, name: 'exec', isError: false, at: 102 })
  })

  test('tool result (error)', () => {
    const e = normalizeAgentEvent(toolResultError, 103)
    expect(e).toEqual({ kind: 'tool', runId: RUN_A, phase: 'result', toolCallId: TOOL_CALL_A, name: 'exec', isError: true, at: 103 })
  })

  test('lifecycle start — literal fixture from 2026-08-09T04-56-42.jsonl', () => {
    const e = normalizeAgentEvent(lifecycleStartFrom0456, 200)
    expect(e).toEqual({ kind: 'lifecycle', runId: 'probe-1786251414522-1hy5kdem90v', phase: 'start', aborted: undefined, stopReason: undefined, at: 200 })
  })

  test('lifecycle finishing', () => {
    const e = normalizeAgentEvent(lifecycleFinishing, 201)
    expect(e).toEqual({ kind: 'lifecycle', runId: RUN_A, phase: 'finishing', aborted: false, stopReason: 'stop', at: 201 })
  })

  test('lifecycle end', () => {
    const e = normalizeAgentEvent(lifecycleEnd, 202)
    expect(e).toEqual({ kind: 'lifecycle', runId: RUN_A, phase: 'end', aborted: false, stopReason: 'stop', at: 202 })
  })

  test('lifecycle error', () => {
    const e = normalizeAgentEvent(lifecycleError, 203)
    expect(e).toEqual({ kind: 'lifecycle', runId: 'probe-1786084176382-ccs74xf6gqs', phase: 'error', aborted: undefined, stopReason: undefined, at: 203 })
  })

  test('item kind:tool backfills title', () => {
    const e = normalizeAgentEvent(itemTool, 300)
    expect(e).toEqual({ kind: 'item', runId: RUN_A, toolCallId: TOOL_CALL_A, title: 'exec run sleep 8 → print text', at: 300 })
  })

  test('item kind:command is filtered to unknown, never an item RunEvent', () => {
    const e = normalizeAgentEvent(itemCommand, 301)
    expect(e?.kind).toBe('unknown')
    if (e?.kind === 'unknown') {
      expect(e.runId).toBe(RUN_A)
      expect(e.stream).toBe('item')
    }
  })

  test('thinking', () => {
    const e = normalizeAgentEvent(thinkingFrame, 400)
    expect(e).toEqual({ kind: 'thinking', runId: RUN_A, at: 400 })
  })

  test('compaction start', () => {
    const e = normalizeAgentEvent(compactionStart, 500)
    expect(e).toEqual({ kind: 'compaction', phase: 'start', completed: undefined, willRetry: undefined, at: 500 })
  })

  test('compaction end, completed+willRetry -> retrying', () => {
    const e = normalizeAgentEvent(compactionEndRetrying, 501)
    expect(e).toEqual({ kind: 'compaction', phase: 'end', completed: true, willRetry: true, at: 501 })
  })

  test('compaction end, completed only -> complete', () => {
    const e = normalizeAgentEvent(compactionEndComplete, 502)
    expect(e).toEqual({ kind: 'compaction', phase: 'end', completed: true, willRetry: undefined, at: 502 })
  })

  test('compaction end, neither -> skipped/failed', () => {
    const e = normalizeAgentEvent(compactionEndFailed, 503)
    expect(e).toEqual({ kind: 'compaction', phase: 'end', completed: false, willRetry: undefined, at: 503 })
  })

  test('real but unmapped stream "assistant" -> unknown, never throws', () => {
    const e = normalizeAgentEvent(assistantStream, 600)
    expect(e).toEqual({ kind: 'unknown', runId: RUN_A, stream: 'assistant', raw: assistantStream, at: 600 })
  })

  test('real but unmapped stream "command_output" -> unknown, never throws', () => {
    const e = normalizeAgentEvent(commandOutputStream, 601)
    expect(e).toEqual({ kind: 'unknown', runId: RUN_A, stream: 'command_output', raw: commandOutputStream, at: 601 })
  })

  test('garbage: non-object payload -> null (no identity at all)', () => {
    expect(normalizeAgentEvent('not an object', 700)).toBeNull()
    expect(normalizeAgentEvent(null, 701)).toBeNull()
    expect(normalizeAgentEvent(undefined, 702)).toBeNull()
    expect(normalizeAgentEvent(42, 703)).toBeNull()
  })

  test('garbage: object with no runId and no sessionKey -> null', () => {
    expect(normalizeAgentEvent({ stream: 'tool', data: {} }, 704)).toBeNull()
  })

  test('garbage: recognized stream with malformed data degrades to unknown, never throws', () => {
    const e = normalizeAgentEvent({ runId: RUN_A, sessionKey: SESSION_KEY, stream: 'tool', data: { phase: 'start' /* missing toolCallId/name */ } }, 705)
    expect(e?.kind).toBe('unknown')
  })

  test('garbage: has sessionKey but no runId and unrecognized stream -> unknown with runId null', () => {
    const e = normalizeAgentEvent({ sessionKey: SESSION_KEY, stream: 'something-new' }, 706)
    expect(e).toEqual({ kind: 'unknown', runId: null, stream: 'something-new', raw: { sessionKey: SESSION_KEY, stream: 'something-new' }, at: 706 })
  })
})

describe('normalizeSessionToolEvent (tolerant — no real session.tool capture exists)', () => {
  test('accepts the agent-stream tool shape as a best-effort guess', () => {
    const e = normalizeSessionToolEvent(toolStart, 800)
    expect(e).toEqual({ kind: 'tool', runId: RUN_A, phase: 'start', toolCallId: TOOL_CALL_A, name: 'exec', isError: undefined, at: 800 })
  })

  test('never throws on a wrong-guess shape; degrades to unknown/null', () => {
    expect(() => normalizeSessionToolEvent({ totally: 'different' }, 801)).not.toThrow()
    expect(() => normalizeSessionToolEvent(null, 802)).not.toThrow()
    expect(() => normalizeSessionToolEvent('garbage', 803)).not.toThrow()
    expect(normalizeSessionToolEvent(null, 804)).toBeNull()
  })
})

describe('chatToRunEvent', () => {
  test('delta — message is cumulative full text, not an increment (verified: same runId, later delta is a strict prefix-extension)', () => {
    const first: ChatEventPayload = { runId: RUN_A, sessionKey: SESSION_KEY, seq: 7, state: 'delta', message: "I'm going to execute a shell command that pauses for 8 seconds and then" }
    const second: ChatEventPayload = { runId: RUN_A, sessionKey: SESSION_KEY, seq: 8, state: 'delta', message: "I'm going to execute a shell command that pauses for 8 seconds and then prints \"probe-slow-done\" to verify that the system handles delayed command execution correctly. This tests" }
    expect(chatToRunEvent(first, 900)).toEqual({ kind: 'chat', runId: RUN_A, state: 'delta', text: first.message, errorMessage: undefined, at: 900 })
    const e2 = chatToRunEvent(second, 901)
    expect(e2.kind === 'chat' && e2.text.startsWith(first.message)).toBe(true)
  })

  test('final', () => {
    const p: ChatEventPayload = { runId: RUN_A, sessionKey: SESSION_KEY, seq: 2, state: 'final', message: 'Model set to anthropic/claude-haiku-4-5 for this session.' }
    expect(chatToRunEvent(p, 902)).toEqual({ kind: 'chat', runId: RUN_A, state: 'final', text: p.message, errorMessage: undefined, at: 902 })
  })

  test('error — literal from 2026-08-07T06-30-20.jsonl', () => {
    const p: ChatEventPayload = {
      runId: 'probe-1786084176382-ccs74xf6gqs',
      sessionKey: SESSION_KEY,
      seq: 32,
      state: 'error',
      message: 'Error: session file changed while embedded prompt lock was released: /home/user/.openclaw/agents/example/sessions/7b17c59b-20b0-4844-94cf-539f279d4cdc.jsonl',
      errorMessage: 'session file changed while embedded prompt lock was released: /home/user/.openclaw/agents/example/sessions/7b17c59b-20b0-4844-94cf-539f279d4cdc.jsonl',
    }
    expect(chatToRunEvent(p, 903)).toEqual({ kind: 'chat', runId: p.runId, state: 'error', text: p.message, errorMessage: p.errorMessage, at: 903 })
  })

  test('aborted (no real capture of this state exists; constructed per the documented ChatEventState union)', () => {
    const p: ChatEventPayload = { runId: RUN_A, sessionKey: SESSION_KEY, seq: 99, state: 'aborted', message: 'partial text before interruption' }
    expect(chatToRunEvent(p, 904)).toEqual({ kind: 'chat', runId: RUN_A, state: 'aborted', text: p.message, errorMessage: undefined, at: 904 })
  })
})

describe('reducer: run start', () => {
  test('lifecycle start with a new runId resets to a fresh active run', () => {
    const e = normalizeAgentEvent(lifecycleStart, 1000) as RunEvent
    const s = reduceRunEvent(initialRunState, e)
    expect(s.runActive).toBe(true)
    expect(s.runId).toBe(RUN_A)
    expect(s.openTools.size).toBe(0)
    expect(s.marks).toEqual([])
    expect(s.text).toBe('')
  })

  test('chat delta with a new runId starts a run when lifecycle start was missed', () => {
    const e = chatToRunEvent({ runId: RUN_A, sessionKey: SESSION_KEY, seq: 1, state: 'delta', message: 'hello' }, 1001)
    const s = reduceRunEvent(initialRunState, e)
    expect(s.runActive).toBe(true)
    expect(s.runId).toBe(RUN_A)
    expect(s.text).toBe('hello')
    expect(s.activity).toBe('speaking')
  })

  test('a duplicate lifecycle start for the SAME runId does not wipe accumulated marks', () => {
    let s = reduceRunEvent(initialRunState, normalizeAgentEvent(lifecycleStart, 1) as RunEvent)
    s = reduceRunEvent(s, normalizeAgentEvent(toolStart, 2) as RunEvent)
    expect(s.marks.length).toBe(1)
    s = reduceRunEvent(s, normalizeAgentEvent(lifecycleStart, 3) as RunEvent)
    expect(s.marks.length).toBe(1) // not reset
    expect(s.openTools.size).toBe(1)
  })

  test('a tool event for a runId we have never seen (no start trigger) is ignored, not adopted', () => {
    const e = normalizeAgentEvent(toolStart, 1) as RunEvent
    const s = reduceRunEvent(initialRunState, e)
    expect(s).toEqual(initialRunState)
  })
})

describe('reducer: run end', () => {
  function startedRun(): RunState {
    return reduceRunEvent(initialRunState, normalizeAgentEvent(lifecycleStart, 1) as RunEvent)
  }

  test('lifecycle end deactivates the run and interrupts still-open tools', () => {
    let s = startedRun()
    s = reduceRunEvent(s, normalizeAgentEvent(toolStart, 2) as RunEvent)
    expect(s.openTools.size).toBe(1)
    s = reduceRunEvent(s, normalizeAgentEvent(lifecycleEnd, 3) as RunEvent)
    expect(s.runActive).toBe(false)
    expect(s.activity).toBe('idle')
    expect(s.openTools.size).toBe(0)
    expect(s.marks).toEqual([{ toolCallId: TOOL_CALL_A, name: 'exec', textOffset: 0, status: 'interrupted' }])
  })

  test('lifecycle error deactivates the run the same way', () => {
    // lifecycleError's runId must actually be started first — an 'error' phase
    // is not a start trigger, so an end-event for a never-started run is
    // correctly ignored (tolerant-of-stale-events contract), not adopted.
    const startForSameRun = { runId: lifecycleError.runId, sessionKey: SESSION_KEY, stream: 'lifecycle', data: { phase: 'start', startedAt: 1 } }
    let s = reduceRunEvent(initialRunState, normalizeAgentEvent(startForSameRun, 1) as RunEvent)
    s = reduceRunEvent(s, { kind: 'tool', runId: lifecycleError.runId, phase: 'start', toolCallId: 'x', name: 'exec', at: 2 })
    s = reduceRunEvent(s, normalizeAgentEvent(lifecycleError, 3) as RunEvent)
    expect(s.runActive).toBe(false)
    expect(s.activity).toBe('idle')
    expect(s.marks[0].status).toBe('interrupted')
  })

  test('a lifecycle end/error event for a run that was never started is ignored, not adopted', () => {
    const s = reduceRunEvent(initialRunState, normalizeAgentEvent(lifecycleError, 1) as RunEvent)
    expect(s).toEqual(initialRunState)
  })

  test('chat final ends the run and settles text', () => {
    let s = reduceRunEvent(initialRunState, chatToRunEvent({ runId: RUN_A, sessionKey: SESSION_KEY, seq: 1, state: 'delta', message: 'partial' }, 1))
    s = reduceRunEvent(s, chatToRunEvent({ runId: RUN_A, sessionKey: SESSION_KEY, seq: 2, state: 'final', message: 'partial done' }, 2))
    expect(s.runActive).toBe(false)
    expect(s.activity).toBe('idle')
    expect(s.text).toBe('partial done')
  })

  test('chat aborted ends the run and interrupts open tools', () => {
    let s = reduceRunEvent(initialRunState, normalizeAgentEvent(lifecycleStart, 1) as RunEvent)
    s = reduceRunEvent(s, normalizeAgentEvent(toolStart, 2) as RunEvent)
    s = reduceRunEvent(s, chatToRunEvent({ runId: RUN_A, sessionKey: SESSION_KEY, seq: 3, state: 'aborted', message: 'cut off' }, 3))
    expect(s.runActive).toBe(false)
    expect(s.marks[0].status).toBe('interrupted')
  })

  test('chat error ends the run', () => {
    let s = reduceRunEvent(initialRunState, chatToRunEvent({ runId: RUN_A, sessionKey: SESSION_KEY, seq: 1, state: 'delta', message: 'x' }, 1))
    s = reduceRunEvent(s, chatToRunEvent({ runId: RUN_A, sessionKey: SESSION_KEY, seq: 2, state: 'error', message: 'Error: boom', errorMessage: 'boom' }, 2))
    expect(s.runActive).toBe(false)
    expect(s.activity).toBe('idle')
  })
})

describe('reducer: dedupe', () => {
  test('duplicate tool start (agent stream + session.tool mirror) yields identical state', () => {
    const s = reduceRunEvent(initialRunState, normalizeAgentEvent(lifecycleStart, 1) as RunEvent)
    const afterFirst = reduceRunEvent(s, normalizeAgentEvent(toolStart, 2) as RunEvent)
    const afterSecond = reduceRunEvent(afterFirst, normalizeSessionToolEvent(toolStart, 3) as RunEvent)
    expect(afterSecond).toEqual(afterFirst)
  })

  test('duplicate tool result yields identical state', () => {
    let s = reduceRunEvent(initialRunState, normalizeAgentEvent(lifecycleStart, 1) as RunEvent)
    s = reduceRunEvent(s, normalizeAgentEvent(toolStart, 2) as RunEvent)
    const afterFirst = reduceRunEvent(s, normalizeAgentEvent(toolResult, 3) as RunEvent)
    const afterSecond = reduceRunEvent(afterFirst, normalizeAgentEvent(toolResult, 4) as RunEvent)
    expect(afterSecond).toEqual(afterFirst)
  })

  test('tool update is idempotent — repeating it changes nothing', () => {
    let s = reduceRunEvent(initialRunState, normalizeAgentEvent(lifecycleStart, 1) as RunEvent)
    s = reduceRunEvent(s, normalizeAgentEvent(toolStart, 2) as RunEvent)
    const afterFirst = reduceRunEvent(s, normalizeAgentEvent(toolUpdate, 3) as RunEvent)
    const afterSecond = reduceRunEvent(afterFirst, normalizeAgentEvent(toolUpdate, 4) as RunEvent)
    expect(afterSecond).toEqual(afterFirst)
  })

  test('item events only backfill title, never duplicate marks', () => {
    let s = reduceRunEvent(initialRunState, normalizeAgentEvent(lifecycleStart, 1) as RunEvent)
    s = reduceRunEvent(s, normalizeAgentEvent(toolStart, 2) as RunEvent)
    s = reduceRunEvent(s, normalizeAgentEvent(itemTool, 3) as RunEvent)
    expect(s.marks.length).toBe(1)
    expect(s.marks[0].title).toBe('exec run sleep 8 → print text')
    s = reduceRunEvent(s, normalizeAgentEvent(itemTool, 4) as RunEvent)
    expect(s.marks.length).toBe(1)
  })
})

describe('reducer: activity precedence', () => {
  test('inactive run -> idle regardless of anything else', () => {
    expect(initialRunState.activity).toBe('idle')
  })

  test('open tools take precedence over everything -> tool', () => {
    let s = reduceRunEvent(initialRunState, normalizeAgentEvent(lifecycleStart, 1) as RunEvent)
    s = reduceRunEvent(s, chatToRunEvent({ runId: RUN_A, sessionKey: SESSION_KEY, seq: 1, state: 'delta', message: 'thinking about it' }, 2))
    expect(s.activity).toBe('speaking')
    s = reduceRunEvent(s, normalizeAgentEvent(toolStart, 3) as RunEvent)
    expect(s.activity).toBe('tool')
  })

  test('chat delta -> speaking', () => {
    const s = reduceRunEvent(initialRunState, chatToRunEvent({ runId: RUN_A, sessionKey: SESSION_KEY, seq: 1, state: 'delta', message: 'hi' }, 1))
    expect(s.activity).toBe('speaking')
  })

  test('thinking -> thinking', () => {
    let s = reduceRunEvent(initialRunState, normalizeAgentEvent(lifecycleStart, 1) as RunEvent)
    s = reduceRunEvent(s, normalizeAgentEvent(thinkingFrame, 2) as RunEvent)
    expect(s.activity).toBe('thinking')
  })

  test('active run, no recognized events (unknown stream) -> active, never thinking', () => {
    let s = reduceRunEvent(initialRunState, normalizeAgentEvent(lifecycleStart, 1) as RunEvent)
    s = reduceRunEvent(s, normalizeAgentEvent(thinkingFrame, 2) as RunEvent)
    expect(s.activity).toBe('thinking')
    s = reduceRunEvent(s, normalizeAgentEvent(assistantStream, 3) as RunEvent)
    expect(s.activity).toBe('active')
    expect(s.activity).not.toBe('thinking')
  })

  test('lifecycle finishing with no other signal -> active', () => {
    let s = reduceRunEvent(initialRunState, normalizeAgentEvent(lifecycleStart, 1) as RunEvent)
    s = reduceRunEvent(s, normalizeAgentEvent(lifecycleFinishing, 2) as RunEvent)
    expect(s.activity).toBe('active')
  })

  test('a tool result that closes the last open tool falls back to active, not stuck on tool', () => {
    let s = reduceRunEvent(initialRunState, normalizeAgentEvent(lifecycleStart, 1) as RunEvent)
    s = reduceRunEvent(s, normalizeAgentEvent(toolStart, 2) as RunEvent)
    expect(s.activity).toBe('tool')
    s = reduceRunEvent(s, normalizeAgentEvent(toolResult, 3) as RunEvent)
    expect(s.activity).toBe('active')
  })
})

describe('reducer: marks', () => {
  test('tool start records textOffset = text.length at the moment it starts', () => {
    let s = reduceRunEvent(initialRunState, normalizeAgentEvent(lifecycleStart, 1) as RunEvent)
    s = reduceRunEvent(s, chatToRunEvent({ runId: RUN_A, sessionKey: SESSION_KEY, seq: 1, state: 'delta', message: 'I will run a command now.' }, 2))
    s = reduceRunEvent(s, normalizeAgentEvent(toolStart, 3) as RunEvent)
    expect(s.marks[0].textOffset).toBe('I will run a command now.'.length)
  })

  test('unknown streams are tolerated and change no marks', () => {
    let s = reduceRunEvent(initialRunState, normalizeAgentEvent(lifecycleStart, 1) as RunEvent)
    s = reduceRunEvent(s, normalizeAgentEvent(toolStart, 2) as RunEvent)
    const before = s.marks
    s = reduceRunEvent(s, normalizeAgentEvent(commandOutputStream, 3) as RunEvent)
    expect(s.marks).toEqual(before)
  })

  test('compaction events do not affect RunState at all (not run-scoped)', () => {
    let s = reduceRunEvent(initialRunState, normalizeAgentEvent(lifecycleStart, 1) as RunEvent)
    s = reduceRunEvent(s, normalizeAgentEvent(toolStart, 2) as RunEvent)
    const before = s
    const after = reduceRunEvent(s, normalizeAgentEvent(compactionStart, 3) as RunEvent)
    expect(after).toEqual(before)
  })

  test('a completed tool call marks status done, not running', () => {
    let s = reduceRunEvent(initialRunState, normalizeAgentEvent(lifecycleStart, 1) as RunEvent)
    s = reduceRunEvent(s, normalizeAgentEvent(toolStart, 2) as RunEvent)
    s = reduceRunEvent(s, normalizeAgentEvent(toolResult, 3) as RunEvent)
    expect(s.marks[0].status).toBe('done')
  })

  test('an errored tool call marks status error', () => {
    let s = reduceRunEvent(initialRunState, normalizeAgentEvent(lifecycleStart, 1) as RunEvent)
    s = reduceRunEvent(s, normalizeAgentEvent(toolStart, 2) as RunEvent)
    s = reduceRunEvent(s, normalizeAgentEvent(toolResultError, 3) as RunEvent)
    expect(s.marks[0].status).toBe('error')
  })
})
