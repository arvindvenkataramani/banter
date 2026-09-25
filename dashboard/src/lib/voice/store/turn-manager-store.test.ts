import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  attachSession,
  configureTurnManager,
  detachSession,
  report,
  reportComposerFocus,
  reportComposerSend,
  resetTurnManager,
  useTurnManagerStore,
} from './turn-manager-store'
import { editTranscript, useTranscriptStore } from './transcript-store'
import type { Report, UtteranceOutcome, UtterancePhase } from '../turn-manager'
import type { Activity } from '../../run-state'

// The turn manager's writes to the conversation: delivering a human turn
// that closes sent, and aborting a run the human interrupted. Both act once
// per turn however many snapshots report the same outcome.

function human(
  id: string,
  phase: UtterancePhase['human'],
  extra: { outcome?: UtteranceOutcome['human']; transcript?: string } = {},
): Report {
  return { actor: 'human', utterance: { speaker: 'human', id, phase, ...extra } }
}

function run(runId: string | null, runActive: boolean, activity: Activity = runActive ? 'active' : 'idle'): Report {
  return { actor: 'conversation', conversation: { known: true, runActive, runId, activity } }
}

function say(id: string, words: string): void {
  report(human(id, 'hearing'))
  report(human(id, 'transcribing'))
  editTranscript(`${useTranscriptStore.getState().settled} ${words}`.trim())
  report(human(id, 'ended', { outcome: 'transcribed', transcript: words }))
}

function fakeSession() {
  return {
    controls: {
      send: vi.fn((_text: string, _opts?: { annotation?: 'interrupted-speaking' | 'interrupted-working' }) => Promise.resolve()),
      abort: vi.fn(() => Promise.resolve()),
    },
  }
}

beforeEach(() => {
  detachSession()
  resetTurnManager()
  configureTurnManager({ interruptionMinRemainingS: 0.5 })
  useTranscriptStore.setState({ settled: '', pending: [] })
  report({ actor: 'mode', mode: 'live' })
})

describe('Delivering a human turn', () => {
  test('a turn closing sent delivers the transcript once, and later snapshots of the same turn send nothing', () => {
    const session = fakeSession()
    attachSession(session)

    say('h1', 'hello')
    expect(session.controls.send).toHaveBeenCalledTimes(1)
    expect(session.controls.send).toHaveBeenCalledWith('hello', { annotation: undefined })
    expect(useTranscriptStore.getState().settled).toBe('')

    editTranscript('typed while closing')
    report({ actor: 'controls', controls: { micMuted: false, speechMuted: false, autoMuted: false } })
    report({ actor: 'controls', controls: { micMuted: true, speechMuted: false, autoMuted: true } })
    expect(useTurnManagerStore.getState().snapshot.human?.outcome).toBe('sent')
    expect(session.controls.send).toHaveBeenCalledTimes(1)
    expect(useTranscriptStore.getState().settled).toBe('typed while closing')
  })

  test('a turn that reopens and closes sent again delivers only what was said since the first delivery', () => {
    const session = fakeSession()
    attachSession(session)

    say('h1', 'hello')
    say('h2', 'world')
    expect(useTurnManagerStore.getState().snapshot.human?.utterances.map((u) => u.id)).toEqual(['h1', 'h2'])
    expect(session.controls.send.mock.calls.map((c) => c[0])).toEqual(['hello', 'world'])
  })

  test('two utterances in one turn go out as one message', () => {
    const session = fakeSession()
    attachSession(session)

    report(human('a', 'hearing'))
    report(human('a', 'transcribing'))
    report(human('b', 'hearing'))
    editTranscript('hello')
    report(human('a', 'ended', { outcome: 'transcribed', transcript: 'hello' }))
    report(human('b', 'transcribing'))
    editTranscript('hello world')
    report(human('b', 'ended', { outcome: 'transcribed', transcript: 'world' }))

    expect(session.controls.send).toHaveBeenCalledTimes(1)
    expect(session.controls.send).toHaveBeenCalledWith('hello world', { annotation: undefined })
  })

  test('a send carries the annotation the snapshot holds at the close', () => {
    const session = fakeSession()
    attachSession(session)

    report(run('A', true, 'speaking'))
    report({ actor: 'agent', utterance: { speaker: 'agent', id: 'A', phase: 'audible' }, supply: { run: 'A', mounted: true, pending: 0, remaining: 2 } })
    report(human('h1', 'hearing'))
    report(run('A', false))
    report(human('h1', 'transcribing'))
    editTranscript('stop')
    report(human('h1', 'ended', { outcome: 'transcribed', transcript: 'stop' }))

    expect(session.controls.send).toHaveBeenCalledWith('stop', { annotation: 'interrupted-working' })
  })

  test('a turn ending abandoned or rejected delivers nothing and leaves the transcript as it is', () => {
    const session = fakeSession()
    attachSession(session)
    editTranscript('unsent words')

    report(human('h1', 'hearing'))
    report(human('h1', 'ended', { outcome: 'abandoned', transcript: 'cut off' }))
    expect(useTurnManagerStore.getState().snapshot.human?.outcome).toBe('abandoned')

    report(human('h2', 'hearing'))
    report(human('h2', 'transcribing'))
    report(human('h2', 'ended', { outcome: { rejected: 'empty' } }))
    expect(useTurnManagerStore.getState().snapshot.human?.outcome).toBe('rejected')

    expect(session.controls.send).not.toHaveBeenCalled()
    expect(useTranscriptStore.getState().settled).toBe('unsent words')
  })

  test('a turn closing sent with an empty transcript sends nothing', () => {
    const session = fakeSession()
    attachSession(session)

    report(human('h1', 'hearing'))
    report(human('h1', 'transcribing'))
    report(human('h1', 'ended', { outcome: 'transcribed', transcript: 'hi' }))

    expect(useTurnManagerStore.getState().snapshot.human?.outcome).toBe('sent')
    expect(session.controls.send).not.toHaveBeenCalled()
  })

  test('attaching delivers nothing for a turn already sent when the session attaches', () => {
    say('h1', 'hello')
    const session = fakeSession()
    attachSession(session)
    report({ actor: 'controls', controls: { micMuted: false, speechMuted: false, autoMuted: false } })

    expect(session.controls.send).not.toHaveBeenCalled()
    expect(useTranscriptStore.getState().settled).toBe('hello')
  })

  test('re-attaching to a new session does not resend a turn already delivered to the old one', () => {
    const a = fakeSession()
    const b = fakeSession()
    attachSession(a)
    say('h1', 'hello')
    expect(a.controls.send).toHaveBeenCalledTimes(1)

    attachSession(b)
    report({ actor: 'controls', controls: { micMuted: false, speechMuted: false, autoMuted: false } })
    expect(b.controls.send).not.toHaveBeenCalled()
    expect(a.controls.send).toHaveBeenCalledTimes(1)

    say('h2', 'again')
    expect(b.controls.send).toHaveBeenCalledTimes(1)
    expect(b.controls.send).toHaveBeenCalledWith('again', { annotation: undefined })
    expect(a.controls.send).toHaveBeenCalledTimes(1)
  })

  test('after detaching, a turn closing sent is not delivered and its words stay in the transcript', () => {
    const session = fakeSession()
    attachSession(session)
    detachSession()

    say('h1', 'hello')
    expect(session.controls.send).not.toHaveBeenCalled()
    expect(useTranscriptStore.getState().settled).toBe('hello')
  })
})

describe('The composer\'s reports', () => {
  test('the send button with a turn speaking closes it sent once its utterance ends, and delivers', () => {
    const session = fakeSession()
    attachSession(session)

    report(human('h1', 'hearing'))
    reportComposerFocus(true)
    reportComposerSend()
    expect(useTurnManagerStore.getState().snapshot.human?.phase).toBe('speaking')

    report(human('h1', 'transcribing'))
    editTranscript('hello')
    report(human('h1', 'ended', { outcome: 'transcribed', transcript: 'hello' }))
    expect(useTurnManagerStore.getState().snapshot.human?.outcome).toBe('sent')
    expect(session.controls.send).toHaveBeenCalledWith('hello', { annotation: undefined })
  })

  test('focusing the composer after a voice-off holds the turn and sends nothing, whatever sends an earlier session made', () => {
    report(human('h0', 'hearing'))
    reportComposerSend()
    report({ actor: 'mode', mode: 'off' })
    resetTurnManager()
    report({ actor: 'mode', mode: 'live' })

    const session = fakeSession()
    attachSession(session)
    editTranscript('draft')
    report(human('h1', 'hearing'))
    reportComposerFocus(true)
    report(human('h1', 'transcribing'))
    report(human('h1', 'ended', { outcome: 'transcribed', transcript: 'draft' }))

    expect(useTurnManagerStore.getState().snapshot.human?.phase).toBe('speaking')
    expect(session.controls.send).not.toHaveBeenCalled()
    expect(useTranscriptStore.getState().settled).toBe('draft')
  })
})

describe('Aborting an interrupted run', () => {
  test('a run the human interrupts while it is active is aborted once', () => {
    const session = fakeSession()
    attachSession(session)

    report(run('A', true))
    report(human('h1', 'hearing'))
    expect(useTurnManagerStore.getState().snapshot.agent?.outcome).toBe('preempted')
    expect(session.controls.abort).toHaveBeenCalledTimes(1)

    report({ actor: 'controls', controls: { micMuted: false, speechMuted: false, autoMuted: false } })
    report(human('h2', 'hearing'))
    expect(session.controls.abort).toHaveBeenCalledTimes(1)
  })

  test('a run already over when the human interrupts its turn is not aborted', () => {
    const session = fakeSession()
    attachSession(session)

    report(run('A', true, 'speaking'))
    report({ actor: 'agent', utterance: { speaker: 'agent', id: 'A', phase: 'audible' }, supply: { run: 'A', mounted: true, pending: 0, remaining: 2 } })
    report(run('A', false))
    report(human('h1', 'hearing'))

    expect(useTurnManagerStore.getState().snapshot.agent?.outcome).toBe('superseded')
    expect(session.controls.abort).not.toHaveBeenCalled()
  })

  test('a run opening under human speech is preempted and aborted', () => {
    const session = fakeSession()
    attachSession(session)

    report(human('h1', 'hearing'))
    report(run('B', true))

    const snap = useTurnManagerStore.getState().snapshot
    expect(snap.agent?.outcome).toBe('preempted')
    expect(snap.relations.interruption?.working).toBe(true)
    expect(session.controls.abort).toHaveBeenCalledTimes(1)
  })

  test('attaching aborts a run already interrupted and still active', () => {
    report(run('A', true))
    report(human('h1', 'hearing'))
    const session = fakeSession()
    attachSession(session)
    expect(session.controls.abort).toHaveBeenCalledTimes(1)
  })
})

describe('Reset and config', () => {
  test('resetTurnManager returns to the initial state keeping the configured threshold', () => {
    configureTurnManager({ interruptionMinRemainingS: 1.5 })
    report(human('h1', 'hearing'))
    resetTurnManager()
    const { state, snapshot } = useTurnManagerStore.getState()
    expect(state.human).toBeNull()
    expect(state.last).toEqual({})
    expect(state.config).toEqual({ interruptionMinRemainingS: 1.5 })
    expect(snapshot.floor).toBe('nobody')
  })
})
