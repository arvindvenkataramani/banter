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

// Promises: docs/reference/components/chat.md, "Run signalling" and "Run state".
//
// Fixtures are trimmed to the fields normalizeAgentEvent reads, lifted from
// probe captures under control/probe/captures/: tool phases and lifecycle
// finishing/end from 2026-08-07T06-56-50.jsonl, lifecycle start from
// 2026-08-09T04-56-42.jsonl, lifecycle error from 2026-08-07T06-30-20.jsonl,
// run_status and chat status from 2026-09-01T01-22-46.jsonl. No capture holds
// a compaction event; that fixture follows CompactionEventData in
// gateway-connection.ts.

const RUN_A = 'probe-1786085822762-lpdiyemq03'
const TOOL_CALL_A = 'toolu_01YRVMtXVqKXLTDxdyYtJEMM'
const SESSION_KEY = 'agent:example:probe'

const agentEvent = (stream: string, data: Record<string, unknown>, runId: string | null = RUN_A) =>
  ({ ...(runId !== null && { runId }), sessionKey: SESSION_KEY, stream, data })

const toolStart = agentEvent('tool', { phase: 'start', name: 'exec', toolCallId: TOOL_CALL_A, args: { command: 'sleep 8 && echo probe-slow-done' } })
const toolUpdate = agentEvent('tool', { phase: 'update', name: 'exec', toolCallId: TOOL_CALL_A, partialResult: { content: [{ type: 'text', text: 'probe-slow-done\n' }] } })
const toolResult = agentEvent('tool', { phase: 'result', name: 'exec', toolCallId: TOOL_CALL_A, isError: false, meta: 'run sleep 8 → print text', result: { content: [{ type: 'text', text: 'probe-slow-done' }] } })
const toolResultError = agentEvent('tool', { phase: 'result', name: 'exec', toolCallId: TOOL_CALL_A, isError: true, result: { content: [{ type: 'text', text: 'boom' }] } })
const lifecycleStart = agentEvent('lifecycle', { phase: 'start', startedAt: 1786251418072 })
const lifecycleFinishing = agentEvent('lifecycle', { phase: 'finishing', stopReason: 'stop', aborted: false, livenessState: 'working', replayInvalid: true, endedAt: 1786085840879 })
const lifecycleEnd = agentEvent('lifecycle', { phase: 'end', stopReason: 'stop', aborted: false, livenessState: 'working', replayInvalid: true, endedAt: 1786085841059 })
const lifecycleError = agentEvent('lifecycle', {
  phase: 'error',
  endedAt: 1786084221222,
  error: 'session file changed while embedded prompt lock was released: /home/user/.openclaw/agents/example/sessions/7b17c59b-20b0-4844-94cf-539f279d4cdc.jsonl',
  fallbackExhaustedFailure: true,
})
const itemTool = agentEvent('item', { itemId: `tool:${TOOL_CALL_A}`, phase: 'start', kind: 'tool', title: 'exec run sleep 8 → print text', status: 'running', name: 'exec', toolCallId: TOOL_CALL_A, startedAt: 1786085829362 })
const itemCommand = agentEvent('item', { itemId: `command:${TOOL_CALL_A}`, phase: 'start', kind: 'command', title: 'command run sleep 8 → print text', status: 'running', name: 'exec', toolCallId: TOOL_CALL_A, startedAt: 1786085829362 })
const thinkingFrame = agentEvent('thinking', { text: 'The user is asking', delta: 'The user is asking' })
const runStatus = (phase: string) => agentEvent('run_status', { phase })
const compactionEnd = agentEvent('compaction', { phase: 'end', completed: true, willRetry: true }, null)
const assistantStream = agentEvent('assistant', { text: "I'm going to execute a shell command", delta: "I'm going to execute a shell command" })
const commandOutputStream = agentEvent('command_output', { itemId: `command:${TOOL_CALL_A}`, phase: 'delta', toolCallId: TOOL_CALL_A, name: 'exec', output: 'probe-slow-done', status: 'running' })

const ev = (payload: unknown): RunEvent => normalizeAgentEvent(payload, 1) as RunEvent
const chat = (state: ChatEventPayload['state'], message: string, runId = RUN_A): RunEvent =>
  chatToRunEvent({ runId, sessionKey: SESSION_KEY, seq: 0, state, message } as ChatEventPayload, 1)
const fold = (events: RunEvent[], from: RunState = initialRunState): RunState => events.reduce(reduceRunEvent, from)

describe('normalizing gateway events', () => {
  test.each([
    ['a tool start', toolStart, { kind: 'tool', runId: RUN_A, phase: 'start', toolCallId: TOOL_CALL_A, name: 'exec', isError: undefined }],
    ['a tool update', toolUpdate, { kind: 'tool', phase: 'update', toolCallId: TOOL_CALL_A }],
    ['a tool result', toolResult, { kind: 'tool', phase: 'result', isError: false }],
    ['a failed tool result', toolResultError, { kind: 'tool', phase: 'result', isError: true }],
    ['a lifecycle start', lifecycleStart, { kind: 'lifecycle', runId: RUN_A, phase: 'start', aborted: undefined, stopReason: undefined }],
    ['a lifecycle finishing', lifecycleFinishing, { kind: 'lifecycle', phase: 'finishing', aborted: false, stopReason: 'stop' }],
    ['a lifecycle end', lifecycleEnd, { kind: 'lifecycle', phase: 'end' }],
    ['a lifecycle error', lifecycleError, { kind: 'lifecycle', phase: 'error' }],
    ['a tool item', itemTool, { kind: 'item', runId: RUN_A, toolCallId: TOOL_CALL_A, title: 'exec run sleep 8 → print text' }],
    ['a thinking frame, holding the reasoning so far', thinkingFrame, { kind: 'thinking', runId: RUN_A, text: 'The user is asking' }],
    ['a run_status phase', runStatus('preparing_workspace'), { kind: 'run-status', runId: RUN_A, phase: 'preparing_workspace' }],
    ['a compaction end', compactionEnd, { kind: 'compaction', phase: 'end', completed: true, willRetry: true }],
  ])('reads %s', (_, payload, expected) => {
    expect(normalizeAgentEvent(payload, 1)).toMatchObject({ ...expected, at: 1 })
  })

  test.each([
    ['an unrecognised stream', assistantStream, RUN_A, 'assistant'],
    ['another unrecognised stream', commandOutputStream, RUN_A, 'command_output'],
    ['an item that is not a tool', itemCommand, RUN_A, 'item'],
    ['a tool event missing its id and name', agentEvent('tool', { phase: 'start' }), RUN_A, 'tool'],
    ['an unrecognised stream with only a session key', agentEvent('something-new', {}, null), null, 'something-new'],
  ])('keeps %s as unknown', (_, payload, runId, stream) => {
    expect(normalizeAgentEvent(payload, 1)).toEqual({ kind: 'unknown', runId, stream, raw: payload, at: 1 })
  })

  test.each([
    ['a string', 'not an object'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['an object with neither runId nor sessionKey', { stream: 'tool', data: {} }],
  ])('drops %s', (_, payload) => {
    expect(normalizeAgentEvent(payload, 1)).toBeNull()
  })

  test('reads the session.tool mirror in the agent stream\'s shape, and drops what it cannot read', () => {
    expect(normalizeSessionToolEvent(toolStart, 1)).toEqual(normalizeAgentEvent(toolStart, 1))
    expect(normalizeSessionToolEvent(null, 1)).toBeNull()
    expect(normalizeSessionToolEvent({ totally: 'different' }, 1)).toBeNull()
  })

  test('carries a chat event\'s state, text and error message', () => {
    const payload = { runId: RUN_A, sessionKey: SESSION_KEY, seq: 32, state: 'error', message: 'Error: boom', errorMessage: 'boom' } as ChatEventPayload
    expect(chatToRunEvent(payload, 1)).toEqual({ kind: 'chat', runId: RUN_A, state: 'error', text: 'Error: boom', errorMessage: 'boom', at: 1 })
  })
})

describe('opening a run', () => {
  test.each([
    ['lifecycle start', ev(lifecycleStart)],
    ['a chat delta', chat('delta', 'hello')],
    ['a chat status', chat('status', '')],
    ['a run_status phase', ev(runStatus('preparing_workspace'))],
    ['reasoning', ev(thinkingFrame)],
  ])('%s opens a run', (_, event) => {
    expect(fold([event])).toMatchObject({ runActive: true, runId: RUN_A })
  })

  test.each([
    ['a tool event', ev(toolStart)],
    ['lifecycle end', ev(lifecycleEnd)],
    ['lifecycle error', ev(lifecycleError)],
    ['empty reasoning', ev(agentEvent('thinking', { text: '' }))],
  ])('%s for a run not open changes nothing', (_, event) => {
    expect(fold([event])).toEqual(initialRunState)
  })

  test('an event for the open run never restarts it', () => {
    const s = fold([ev(lifecycleStart), ev(toolStart), ev(lifecycleStart)])
    expect(s.marks).toHaveLength(1)
    expect(s.openTools.size).toBe(1)
  })

  test('a different run replaces the whole state', () => {
    const before = fold([ev(lifecycleStart), chat('delta', 'old'), ev(toolStart)])
    expect(fold([ev({ ...lifecycleStart, runId: 'run-b' })], before)).toMatchObject({ runId: 'run-b', runActive: true, text: '', marks: [] })
  })
})

describe('ending a run', () => {
  test.each([
    ['lifecycle end', ev(lifecycleEnd)],
    ['lifecycle error', ev(lifecycleError)],
    ['a chat final', chat('final', 'done')],
    ['a chat aborted', chat('aborted', 'cut off')],
    ['a chat error', chat('error', 'Error: boom')],
  ])('%s ends the run and marks open tools interrupted', (_, ender) => {
    const s = fold([ev(lifecycleStart), ev(toolStart), ender])
    expect(s).toMatchObject({ runActive: false, activity: 'idle' })
    expect(s.openTools.size).toBe(0)
    expect(s.marks.map((m) => m.status)).toEqual(['interrupted'])
  })

  test('a terminal chat event\'s text replaces the assembled text unless it carries none; a status event neither ends the run nor clears it', () => {
    const streaming = fold([chat('delta', 'partial'), chat('status', '')])
    expect(streaming).toMatchObject({ runActive: true, text: 'partial' })
    expect(fold([chat('final', 'partial done')], streaming).text).toBe('partial done')
    expect(fold([chat('final', '')], streaming).text).toBe('partial')
  })
})

describe('activity', () => {
  test.each([
    ['no run is open', [], 'idle'],
    ['the latest event is a chat delta', [ev(lifecycleStart), chat('delta', 'hi')], 'speaking'],
    ['the latest event is reasoning', [ev(lifecycleStart), ev(thinkingFrame)], 'thinking'],
    ['an unrecognised stream follows reasoning', [ev(lifecycleStart), ev(thinkingFrame), ev(assistantStream)], 'active'],
    ['the run is finishing', [ev(lifecycleStart), ev(lifecycleFinishing)], 'active'],
    ['the run is still preparing', [chat('status', ''), ...['preparing_workspace', 'preparing_context', 'starting_model'].map((p) => ev(runStatus(p)))], 'active'],
    ['a tool is open, even mid-speech', [ev(lifecycleStart), chat('delta', 'let me check'), ev(toolStart)], 'tool'],
    ['the last open tool has returned', [ev(lifecycleStart), ev(toolStart), ev(toolResult)], 'active'],
  ] as [string, RunEvent[], RunState['activity']][])('when %s', (_, events, activity) => {
    expect(fold(events).activity).toBe(activity)
  })
})

describe('tool calls', () => {
  test.each([
    [toolResult, 'done'],
    [toolResultError, 'error'],
  ])('mark where they started in the text, and settle on their result', (result, status) => {
    const s = fold([ev(lifecycleStart), chat('delta', 'I will run a command now.'), ev(toolStart), ev(result)])
    expect(s.marks).toEqual([{ toolCallId: TOOL_CALL_A, name: 'exec', textOffset: 'I will run a command now.'.length, status }])
  })

  test('take their title from a tool item, however often it arrives', () => {
    const s = fold([ev(lifecycleStart), ev(toolStart), ev(itemTool), ev(itemTool)])
    expect(s.marks).toHaveLength(1)
    expect(s.marks[0].title).toBe('exec run sleep 8 → print text')
  })

  test.each([
    ['a start echoed by the session.tool mirror', [ev(toolStart)], normalizeSessionToolEvent(toolStart, 1) as RunEvent],
    ['a repeated update', [ev(toolStart), ev(toolUpdate)], ev(toolUpdate)],
    ['a repeated result', [ev(toolStart), ev(toolResult)], ev(toolResult)],
  ] as [string, RunEvent[], RunEvent][])('count each phase once, so %s changes nothing', (_, events, repeat) => {
    const once = fold([ev(lifecycleStart), ...events])
    expect(fold([repeat], once)).toEqual(once)
  })
})

test('compaction leaves run state alone', () => {
  const s = fold([ev(lifecycleStart), ev(toolStart)])
  expect(fold([ev(compactionEnd)], s)).toEqual(s)
})

describe('reduceRunEvent: empty chat delta', () => {
  test('a delta with no text keeps the text assembled so far', () => {
    const state = fold([
      { kind: 'chat', runId: 'r1', state: 'delta', text: 'Done. Both', at: 1 },
      { kind: 'chat', runId: 'r1', state: 'delta', text: '', at: 2 },
    ])
    expect(state.text).toBe('Done. Both')
  })
})
