import { describe, expect, test } from 'vitest'
import {
  initialTurnManagerState,
  reduce,
  snapshot,
  type AudioSupply,
  type ControlsReport,
  type Mode,
  type Report,
  type TurnManagerConfig,
  type TurnManagerState,
  type UtteranceOutcome,
  type UtterancePhase,
} from './turn-manager'
import type { Activity } from '../run-state'

// The turn manager's reduction rules, one test per rule, grouped by subject.
// Each test is named by the rule it protects; the transitions they add up to
// are tabled in docs/components/voice-turn-taking.md.

const CONFIG: TurnManagerConfig = { interruptionMinRemainingS: 0.5 }
const ABOVE = 2.0
const AT_OR_BELOW = 0.5

function fold(reports: Report[], config: TurnManagerConfig = CONFIG): TurnManagerState {
  return foldFrom(reduce(initialTurnManagerState(config), mode('live')), reports)
}

function foldFrom(state: TurnManagerState, reports: Report[]): TurnManagerState {
  let s = state
  for (const r of reports) s = reduce(s, r)
  return s
}

function human(
  id: string,
  phase: UtterancePhase['human'],
  extra: { outcome?: UtteranceOutcome['human']; transcript?: string } = {},
): Report {
  return { actor: 'human', utterance: { speaker: 'human', id, phase, ...extra } }
}

function agent(
  id: string | null,
  phase: UtterancePhase['agent'] | null,
  supply: Partial<AudioSupply> = {},
  outcome?: UtteranceOutcome['agent'],
): Report {
  const utterance = id !== null && phase !== null ? { speaker: 'agent' as const, id, phase, ...(outcome ? { outcome } : {}) } : null
  return { actor: 'agent', utterance, supply: { run: null, mounted: false, pending: 0, remaining: 0, ...supply } }
}

function run(runId: string | null, runActive: boolean, activity: Activity = runActive ? 'active' : 'idle'): Report {
  return { actor: 'conversation', conversation: { known: true, runActive, runId, activity } }
}

function controls(c: Partial<ControlsReport>): Report {
  return { actor: 'controls', controls: { micMuted: false, speechMuted: false, autoMuted: false, ...c } }
}

function mode(m: Mode): Report {
  return { actor: 'mode', mode: m }
}

function composer(sends: number, focused: boolean): Report {
  return { actor: 'composer', sends, focused }
}

/** An agent run `id` open and audible with `remaining` seconds buffered. */
function agentSpeaking(id: string, remaining = ABOVE, activity: Activity = 'speaking'): Report[] {
  return [run(id, true, activity), agent(id, 'audible', { run: id, mounted: true, remaining })]
}

/** A human utterance heard, handed off and transcribed. */
function humanSaid(id: string, transcript = 'hello'): Report[] {
  return [human(id, 'hearing'), human(id, 'transcribing'), human(id, 'ended', { outcome: 'transcribed', transcript })]
}

describe('Turns open and close', () => {
  test('a turn of either speaker is speaking while it has an utterance whose phase is not ended', () => {
    const h = fold([human('h1', 'hearing'), human('h1', 'transcribing')])
    expect(h.human?.phase).toBe('speaking')

    const a = fold(agentSpeaking('A'))
    expect(a.agent?.phase).toBe('speaking')
  })

  test('an accepted candidate with no human turn open opens a human turn as speaking', () => {
    const s = fold([human('h1', 'hearing')])
    expect(s.human?.phase).toBe('speaking')
    expect(s.human?.utterances.map((u) => u.id)).toEqual(['h1'])
  })

  test('a candidate accepted while the human turn is speaking joins it as another utterance', () => {
    const s = fold([human('h1', 'hearing'), human('h1', 'transcribing'), human('h2', 'hearing')])
    expect(s.human?.id).toBe('h1')
    expect(s.human?.phase).toBe('speaking')
    expect(s.human?.utterances.map((u) => u.id)).toEqual(['h1', 'h2'])
  })

  test('a candidate accepted while the human turn is closing reopens it as speaking', () => {
    let s = fold(humanSaid('h1'))
    expect(s.human?.phase).toBe('closing')

    s = reduce(s, human('h2', 'hearing'))
    expect(s.human?.id).toBe('h1')
    expect(s.human?.phase).toBe('speaking')
    expect(s.human?.outcome).toBeUndefined()
    expect(s.human?.utterances.map((u) => u.id)).toEqual(['h1', 'h2'])
  })

  test('a human turn moves to closing, with outcome sent, when none of its utterances is live and at least one is transcribed', () => {
    const s = fold(humanSaid('h1'))
    expect(s.human?.phase).toBe('closing')
    expect(s.human?.outcome).toBe('sent')
  })

  test('a human turn does not close while the mic is muted; a controls report unmuting the mic re-applies the close', () => {
    let s = fold([human('h1', 'hearing'), controls({ micMuted: true }), human('h1', 'paused')])
    s = foldFrom(s, [human('h1', 'transcribing'), human('h1', 'ended', { outcome: 'transcribed', transcript: 'hi' })])
    expect(s.human?.phase).toBe('speaking')
    expect(s.human?.outcome).toBeUndefined()

    s = reduce(s, controls({ micMuted: false }))
    expect(s.human?.phase).toBe('closing')
    expect(s.human?.outcome).toBe('sent')
  })

  test('a closing human turn stays closing whatever the hold or the mute', () => {
    let s = fold(humanSaid('h1'))
    s = foldFrom(s, [controls({ micMuted: true }), composer(0, true)])
    expect(s.human?.phase).toBe('closing')
    expect(s.human?.outcome).toBe('sent')

    s = reduce(s, controls({ micMuted: false }))
    expect(s.human?.phase).toBe('closing')
    expect(s.human?.outcome).toBe('sent')
  })

  test('a human utterance reported paused is live: its turn stays speaking and the floor stays the human\'s', () => {
    const s = fold([human('h1', 'hearing'), controls({ micMuted: true }), human('h1', 'paused')])
    expect(s.human?.phase).toBe('speaking')
    expect(snapshot(s).floor).toBe('human')
  })

  test('a paused utterance reported hearing again resumes as the same utterance, opening nothing and recording no new interruption', () => {
    let s = fold([...agentSpeaking('A'), human('h1', 'hearing'), human('h1', 'paused')])
    const interruption = s.relations.interruption
    s = reduce(s, human('h1', 'hearing'))
    expect(s.human?.id).toBe('h1')
    expect(s.human?.utterances).toEqual([{ speaker: 'human', id: 'h1', phase: 'hearing' }])
    expect(s.relations.interruption).toBe(interruption)

    s = foldFrom(s, [human('h1', 'transcribing'), human('h1', 'ended', { outcome: 'transcribed', transcript: 'hi' })])
    expect(s.human?.utterances).toHaveLength(1)
    expect(s.human?.outcome).toBe('sent')
  })

  test('a hearing report after transcribing on a known id joins the same utterance rather than opening one', () => {
    const s = fold([human('h1', 'hearing'), human('h1', 'transcribing'), human('h1', 'hearing')])
    expect(s.human?.id).toBe('h1')
    expect(s.human?.phase).toBe('speaking')
    expect(s.human?.utterances).toEqual([{ speaker: 'human', id: 'h1', phase: 'hearing' }])
  })

  test('a composer report saying focused, while the human turn is speaking, holds it', () => {
    const s = fold([human('h1', 'hearing'), composer(0, true)])
    expect(s.human?.held).toBe(true)
  })

  test('a composer report saying focused while the human turn is closing does not hold it', () => {
    const s = fold([...humanSaid('h1'), composer(0, true)])
    expect(s.human?.held).toBeFalsy()
    expect(s.human?.phase).toBe('closing')
  })

  test('a held human turn does not close by voice and does not end as rejected, whatever its utterances hold', () => {
    const transcribed = fold([human('h1', 'hearing'), composer(0, true), human('h1', 'transcribing'), human('h1', 'ended', { outcome: 'transcribed', transcript: 'hi' })])
    expect(transcribed.human?.phase).toBe('speaking')
    expect(transcribed.human?.outcome).toBeUndefined()

    const rejected = fold([human('h1', 'hearing'), composer(0, true), human('h1', 'transcribing'), human('h1', 'ended', { outcome: { rejected: 'empty' } })])
    expect(rejected.human?.phase).toBe('speaking')
    expect(rejected.human?.outcome).toBeUndefined()
  })

  test('a new utterance heard in a held turn releases the hold; a paused one resuming does not', () => {
    const held = fold([human('h1', 'hearing'), composer(0, true), human('h1', 'transcribing'), human('h1', 'ended', { outcome: 'transcribed', transcript: 'hi' })])
    expect(held.human?.held).toBe(true)

    let released = reduce(held, human('h2', 'hearing'))
    expect(released.human?.held).toBe(false)
    released = foldFrom(released, [human('h2', 'transcribing'), human('h2', 'ended', { outcome: 'transcribed', transcript: 'there' })])
    expect(released.human?.phase).toBe('closing')
    expect(released.human?.outcome).toBe('sent')

    const resumed = fold([human('h1', 'hearing'), composer(0, true), human('h1', 'paused'), human('h1', 'hearing')])
    expect(resumed.human?.held).toBe(true)
  })

  test('a composer report whose sends differs from the last one\'s, while the human turn is speaking, marks a send pending', () => {
    const s = fold([human('h1', 'hearing'), composer(1, false)])
    expect(s.human?.sendPending).toBe(true)
    expect(s.human?.phase).toBe('speaking')
  })

  test('a turn with a send pending closes as sent once nothing in it is live, whatever its utterances hold', () => {
    const s = fold([human('h1', 'hearing'), composer(1, false), human('h1', 'transcribing'), human('h1', 'ended', { outcome: { rejected: 'empty' } })])
    expect(s.human?.phase).toBe('closing')
    expect(s.human?.outcome).toBe('sent')
  })

  test('a turn with a send pending closes as sent whether or not it is held or the mic is muted', () => {
    const held = fold([human('h1', 'hearing'), composer(0, true), ...humanSaid('h1').slice(1)])
    expect(held.human?.phase).toBe('speaking')
    const heldSent = reduce(held, composer(1, true))
    expect(heldSent.human?.phase).toBe('closing')
    expect(heldSent.human?.outcome).toBe('sent')

    const muted = fold([human('h1', 'hearing'), controls({ micMuted: true }), human('h1', 'paused'), human('h1', 'transcribing'), human('h1', 'ended', { outcome: 'transcribed', transcript: 'hi' })])
    expect(muted.human?.phase).toBe('speaking')
    const mutedSent = reduce(muted, composer(1, false))
    expect(mutedSent.human?.phase).toBe('closing')
    expect(mutedSent.human?.outcome).toBe('sent')
  })

  test('a turn closing on a pending send records agentAtClosing as any close does', () => {
    const s = fold([...agentSpeaking('A'), human('h1', 'hearing'), composer(0, true), ...humanSaid('h1').slice(1), composer(1, true)])
    expect(s.human?.phase).toBe('closing')
    expect(s.human?.agentAtClosing).toBe('A')

    const none = fold([human('h1', 'hearing'), composer(0, true), ...humanSaid('h1').slice(1), composer(1, true)])
    expect(none.human?.agentAtClosing).toBeNull()
  })

  test('a composer report changes nothing about an ended turn or when no human turn is open', () => {
    const empty = fold([])
    const afterEmpty = reduce(empty, composer(1, true))
    expect(afterEmpty.human).toBeNull()
    expect(afterEmpty.previous).toBe(empty.previous)

    const ended = fold([human('h1', 'hearing'), human('h1', 'transcribing'), human('h1', 'ended', { outcome: { rejected: 'empty' } })])
    expect(ended.human?.phase).toBe('ended')
    const afterEnded = reduce(ended, composer(1, true))
    expect(afterEnded.human).toBe(ended.human)
    expect(afterEnded.previous).toBe(ended.previous)
  })

  test('a rejected utterance in a turn that has a transcribed one does not stop the turn closing as sent', () => {
    const s = fold([
      human('h1', 'hearing'),
      human('h1', 'transcribing'),
      human('h2', 'hearing'),
      human('h1', 'ended', { outcome: 'transcribed', transcript: 'hi' }),
      human('h2', 'transcribing'),
      human('h2', 'ended', { outcome: { rejected: 'failed' } }),
    ])
    expect(s.human?.phase).toBe('closing')
    expect(s.human?.outcome).toBe('sent')
  })

  test('a human turn ends as rejected when none of its utterances is live and none is transcribed', () => {
    const s = fold([human('h1', 'hearing'), human('h1', 'transcribing'), human('h1', 'ended', { outcome: { rejected: 'empty' } })])
    expect(s.human?.phase).toBe('ended')
    expect(s.human?.outcome).toBe('rejected')
  })

  test('a human utterance ending as abandoned ends the human turn as abandoned, whatever its other utterances hold', () => {
    const s = fold([
      human('h1', 'hearing'),
      human('h1', 'transcribing'),
      human('h2', 'hearing'),
      human('h1', 'ended', { outcome: 'transcribed', transcript: 'hi' }),
      human('h2', 'ended', { outcome: 'abandoned' }),
    ])
    expect(s.human?.phase).toBe('ended')
    expect(s.human?.outcome).toBe('abandoned')
  })

  test('a transcript arriving on an utterance already ended as abandoned is stored on it and changes no turn, in the current human turn', () => {
    const before = fold([human('h1', 'hearing'), human('h1', 'ended', { outcome: 'abandoned' })])
    const s = reduce(before, human('h1', 'ended', { outcome: 'abandoned', transcript: 'late' }))
    expect(s.human?.id).toBe('h1')
    expect(s.human?.phase).toBe('ended')
    expect(s.human?.outcome).toBe('abandoned')
    expect(s.human?.utterances).toEqual([{ speaker: 'human', id: 'h1', phase: 'ended', outcome: 'abandoned', transcript: 'late' }])
    expect(s.relations).toBe(before.relations)
  })

  test('a transcript stored on the ended current human turn is still on it once the next turn makes it the previous one', () => {
    const s = fold([
      human('h1', 'hearing'),
      human('h1', 'ended', { outcome: 'abandoned' }),
      human('h1', 'ended', { outcome: 'abandoned', transcript: 'late' }),
      human('h2', 'hearing'),
    ])
    expect(s.human?.id).toBe('h2')
    expect(s.previous.human?.id).toBe('h1')
    expect(s.previous.human?.utterances[0].transcript).toBe('late')
  })

  test('a transcript arriving on an utterance already ended as abandoned is stored on it and changes no turn, in the previous human turn', () => {
    const before = fold([
      human('h1', 'hearing'),
      human('h1', 'ended', { outcome: 'abandoned' }),
      ...humanSaid('h2'),
    ])
    expect(before.human?.id).toBe('h2')
    expect(before.previous.human?.id).toBe('h1')

    const s = reduce(before, human('h1', 'ended', { outcome: 'abandoned', transcript: 'late' }))
    expect(s.human).toBe(before.human)
    expect(s.relations).toBe(before.relations)
    expect(snapshot(s).floor).toBe(snapshot(before).floor)
    expect(s.previous.human?.utterances[0]).toEqual({ speaker: 'human', id: 'h1', phase: 'ended', outcome: 'abandoned', transcript: 'late' })
    expect(s.previous.human?.outcome).toBe('abandoned')
  })

  test('a late report on an ended utterance does not revive its phase or outcome; only its transcript is taken', () => {
    const before = fold([human('h1', 'hearing'), human('h1', 'ended', { outcome: 'abandoned' })])
    const s = reduce(before, human('h1', 'hearing', { outcome: 'transcribed', transcript: 'late' }))
    expect(s.human?.utterances[0]).toEqual({ speaker: 'human', id: 'h1', phase: 'ended', outcome: 'abandoned', transcript: 'late' })
    expect(s.human?.phase).toBe('ended')
  })

  test('a transcript arriving on a live utterance is stored on it and closes no turn, because the utterance is not finished', () => {
    let s = fold([human('h1', 'hearing'), human('h1', 'transcribing'), human('h1', 'hearing', { outcome: 'transcribed', transcript: 'hi' })])
    expect(s.human?.phase).toBe('speaking')
    expect(s.human?.outcome).toBeUndefined()
    expect(s.human?.utterances[0].transcript).toBe('hi')

    s = reduce(s, human('h1', 'ended', { outcome: 'transcribed', transcript: 'hi there' }))
    expect(s.human?.phase).toBe('closing')
    expect(s.human?.outcome).toBe('sent')
  })

  test('only a report of an utterance in phase hearing opens a human turn; a later phase reporting an id no turn holds changes nothing', () => {
    const empty = fold([])
    const noTurn = reduce(empty, human('h1', 'transcribing'))
    expect(noTurn.human).toBeNull()
    expect(noTurn.previous).toBe(empty.previous)

    const open = fold([human('h1', 'hearing')])
    const withOpen = reduce(open, human('h2', 'ended', { outcome: 'transcribed', transcript: 'stray' }))
    expect(withOpen.human).toBe(open.human)
    expect(withOpen.human?.utterances.map((u) => u.id)).toEqual(['h1'])
  })

  test('a human turn moving to closing records the agent turn current at that moment, or null when none is, and a reopen clears it', () => {
    let s = fold([...agentSpeaking('A'), ...humanSaid('h1')])
    expect(s.human?.phase).toBe('closing')
    expect(s.human?.agentAtClosing).toBe('A')

    s = reduce(s, human('h2', 'hearing'))
    expect(s.human?.phase).toBe('speaking')
    expect(s.human?.agentAtClosing).toBeUndefined()

    const none = fold(humanSaid('h1'))
    expect(none.human?.agentAtClosing).toBeNull()
  })

  test('a human turn in closing ends when an agent utterance first reports audible', () => {
    let s = fold([...humanSaid('h1'), run('B', true)])
    expect(s.human?.phase).toBe('closing')

    s = reduce(s, agent('B', 'audible', { run: 'B', mounted: true, remaining: ABOVE }))
    expect(s.human?.phase).toBe('ended')
    expect(s.human?.outcome).toBe('sent')
    expect(s.previous.human).toEqual(s.human)
  })

  test('a human turn in closing ends when the agent turn that opened after it adopts an audible utterance as it opens', () => {
    let s = fold([...humanSaid('h1'), agent('B', 'audible', { run: 'B', mounted: true, remaining: ABOVE })])
    expect(s.human?.phase).toBe('closing')

    s = reduce(s, run('B', true))
    expect(s.agent?.phase).toBe('speaking')
    expect(s.human?.phase).toBe('ended')
  })

  test('a human turn in closing ends when the agent turn that opened after it ends without ever speaking', () => {
    const s = fold([...humanSaid('h1'), run('B', true), run('B', false)])
    expect(s.agent?.outcome).toBe('completed')
    expect(s.human?.phase).toBe('ended')
    expect(s.human?.outcome).toBe('sent')
  })

  test('the agent turn a closing human turn closed over ending does not end it', () => {
    let s = fold([...agentSpeaking('A'), human('h1', 'hearing'), human('h1', 'transcribing'), human('h1', 'ended', { outcome: 'transcribed', transcript: 'hi' })])
    expect(s.agent?.outcome).toBe('superseded')
    expect(s.human?.agentAtClosing).toBe('A')

    s = foldFrom(s, [run('A', false), agent('A', 'ended', { run: null }, 'cut')])
    expect(s.human?.phase).toBe('closing')

    s = foldFrom(s, [run('B', true), run('B', false)])
    expect(s.human?.phase).toBe('ended')
  })

  test('runActive with a run id the turn manager has not seen opens an agent turn as opening', () => {
    const s = fold([run('A', true)])
    expect(s.agent?.id).toBe('A')
    expect(s.agent?.phase).toBe('opening')
    expect(s.agent?.utterances).toEqual([])
  })

  test('an agent turn moves to speaking when the player first reports an utterance for its run', () => {
    let s = fold([run('A', true)])
    s = reduce(s, agent('A', 'audible', { run: 'A', mounted: true, remaining: ABOVE }))
    expect(s.agent?.phase).toBe('speaking')
    expect(s.agent?.utterances.map((u) => u.phase)).toEqual(['audible'])
  })

  test('an agent utterance reported as paused keeps the agent turn speaking', () => {
    const s = fold([...agentSpeaking('A'), agent('A', 'paused', { run: 'A', mounted: true, remaining: ABOVE })])
    expect(s.agent?.phase).toBe('speaking')
  })

  test('an agent turn moves to closing when runActive goes false while its utterance is live', () => {
    const s = fold([...agentSpeaking('A'), run('A', false)])
    expect(s.agent?.phase).toBe('closing')
  })

  test('an agent turn moves to closing when runActive goes false while the player\'s run is still set', () => {
    const s = fold([run('A', true), agent(null, null, { run: 'A' }), run('A', false)])
    expect(s.agent?.phase).toBe('closing')
  })

  test('an agent turn moves to closing when runActive goes false while pending is above zero', () => {
    const s = fold([run('A', true), agent(null, null, { pending: 1 }), run('A', false)])
    expect(s.agent?.phase).toBe('closing')
  })

  test('an agent turn ends as completed when runActive is false, its utterance has ended, the player\'s run is null and pending is zero', () => {
    const s = fold([
      ...agentSpeaking('A'),
      run('A', false),
      agent('A', 'ended', { run: null, mounted: true }, 'completed'),
    ])
    expect(s.agent?.phase).toBe('ended')
    expect(s.agent?.outcome).toBe('completed')
  })

  test('an agent turn that never had audio goes from opening to completed without passing through speaking or closing (a tool-only run)', () => {
    const opening = fold([run('A', true)])
    expect(opening.agent?.phase).toBe('opening')
    const s = reduce(opening, run('A', false))
    expect(s.agent?.phase).toBe('ended')
    expect(s.agent?.outcome).toBe('completed')
  })

  test('an agent turn halted by the stop control ends as completed once the conversation and the player both report it over', () => {
    let s = fold([...agentSpeaking('A'), run('A', false)])
    expect(s.agent?.phase).toBe('closing')
    s = reduce(s, agent('A', 'ended', { run: null, mounted: true }, 'cut'))
    expect(s.agent?.phase).toBe('ended')
    expect(s.agent?.outcome).toBe('completed')
  })

  test('an agent turn opened while speech is muted is unvoiced for its whole duration, and unmuting mid-turn does not change that', () => {
    let s = fold([controls({ speechMuted: true }), run('A', true)])
    expect(s.relations.agentVoiced).toBe(false)
    s = reduce(s, controls({ speechMuted: false }))
    expect(s.relations.agentVoiced).toBe(false)
    expect(snapshot(s).newAudio).toBe('discard')
  })

  test('an unvoiced agent turn ends with outcome unvoiced when runActive goes false, and never as completed even though the completed conditions also hold', () => {
    const s = fold([controls({ speechMuted: true }), run('A', true), run('A', false)])
    expect(s.agent?.phase).toBe('ended')
    expect(s.agent?.outcome).toBe('unvoiced')
  })

  test('an agent report naming a run the turn manager has not seen changes nothing about turns; the turn opens when the conversation reports the run, and adopts the player\'s last report', () => {
    const before = fold([])
    let s = reduce(before, agent('A', 'audible', { run: 'A', mounted: true, remaining: ABOVE }))
    expect(s.agent).toBeNull()
    expect(s.previous).toBe(before.previous)

    s = reduce(s, run('A', true))
    expect(s.agent?.phase).toBe('speaking')
    expect(s.agent?.utterances).toEqual([{ speaker: 'agent', id: 'A', phase: 'audible' }])
  })

  test('a new run id while an agent turn is open ends the old turn as cancelled and opens the new one, and the cancelled turn is readable as the previous agent turn', () => {
    const s = fold([...agentSpeaking('A'), run('B', true)])
    expect(s.agent?.id).toBe('B')
    expect(s.agent?.phase).toBe('opening')
    expect(s.previous.agent?.id).toBe('A')
    expect(s.previous.agent?.phase).toBe('ended')
    expect(s.previous.agent?.outcome).toBe('cancelled')
  })
})

describe('Interrupting the agent', () => {
  test('a candidate accepted while the agent turn is speaking ends the agent turn as superseded', () => {
    const s = fold([...agentSpeaking('A'), human('h1', 'hearing')])
    expect(s.agent?.phase).toBe('ended')
    expect(s.agent?.outcome).toBe('superseded')
  })

  test('a candidate accepted while the agent turn is closing ends the agent turn as superseded', () => {
    const s = fold([...agentSpeaking('A'), run('A', false), human('h1', 'hearing')])
    expect(s.agent?.outcome).toBe('superseded')
  })

  test('a candidate reopening a closing human turn while the agent turn is closing ends it as superseded', () => {
    // B closes without having spoken, so the human turn is still closing.
    let s = fold([...humanSaid('h1'), run('B', true), agent(null, null, { run: 'B', pending: 1 }), run('B', false)])
    expect(s.human?.phase).toBe('closing')
    expect(s.agent?.phase).toBe('closing')

    s = reduce(s, human('h2', 'hearing'))
    expect(s.human?.phase).toBe('speaking')
    expect(s.agent?.outcome).toBe('superseded')
  })

  test('a candidate accepted while the agent turn is opening ends it as preempted', () => {
    const s = fold([run('A', true), human('h1', 'hearing')])
    expect(s.agent?.phase).toBe('ended')
    expect(s.agent?.outcome).toBe('preempted')
  })

  test('a candidate reopening a closing human turn while the agent turn is opening ends it as preempted', () => {
    const s = fold([...humanSaid('h1'), run('B', true), human('h2', 'hearing')])
    expect(s.human?.phase).toBe('speaking')
    expect(s.agent?.outcome).toBe('preempted')
  })

  test('an agent turn opened while the human turn is speaking ends as preempted in the reduction that opens it, and is readable as the previous agent turn', () => {
    const s = fold([human('h1', 'hearing'), run('A', true)])
    expect(s.agent?.id).toBe('A')
    expect(s.agent?.phase).toBe('ended')
    expect(s.agent?.outcome).toBe('preempted')
    expect(s.previous.agent).toEqual(s.agent)
  })

  test('a human turn moving to closing ends no agent turn', () => {
    const speaking = fold([...agentSpeaking('A'), human('h1', 'hearing'), human('h1', 'transcribing')])
    const s = reduce(speaking, human('h1', 'ended', { outcome: 'transcribed', transcript: 'hi' }))
    expect(s.human?.phase).toBe('closing')
    expect(s.agent).toBe(speaking.agent)
    expect(s.previous.agent).toBe(speaking.previous.agent)
  })

  test('a human turn ending as rejected or abandoned leaves the agent turn it interrupted ended', () => {
    const rejected = fold([...agentSpeaking('A'), human('h1', 'hearing'), human('h1', 'transcribing'), human('h1', 'ended', { outcome: { rejected: 'empty' } })])
    expect(rejected.human?.outcome).toBe('rejected')
    expect(rejected.agent?.phase).toBe('ended')
    expect(rejected.agent?.outcome).toBe('superseded')

    const abandoned = fold([...agentSpeaking('A'), human('h1', 'hearing'), human('h1', 'ended', { outcome: 'abandoned' })])
    expect(abandoned.human?.outcome).toBe('abandoned')
    expect(abandoned.agent?.outcome).toBe('superseded')
  })
})

describe('The previous turn', () => {
  test('a turn that ends is retained as that speaker\'s previous turn, with its outcome', () => {
    const h = fold([human('h1', 'hearing'), human('h1', 'transcribing'), human('h1', 'ended', { outcome: { rejected: 'empty' } })])
    expect(h.previous.human?.id).toBe('h1')
    expect(h.previous.human?.outcome).toBe('rejected')

    const a = fold([run('A', true), run('A', false)])
    expect(a.previous.agent?.id).toBe('A')
    expect(a.previous.agent?.outcome).toBe('completed')
  })

  test('a turn replaced without passing through ended — a new run id over an open agent turn — is retained with the outcome the replacement gave it', () => {
    const s = fold([run('A', true), run('B', true)])
    expect(s.previous.agent?.id).toBe('A')
    expect(s.previous.agent?.outcome).toBe('cancelled')
  })

  test('the previous turn of one speaker is unaffected by the other speaker\'s turns ending', () => {
    const before = fold([run('A', true), run('A', false)])
    const afterHuman = foldFrom(before, [human('h1', 'hearing'), human('h1', 'transcribing'), human('h1', 'ended', { outcome: { rejected: 'empty' } })])
    expect(afterHuman.previous.agent).toBe(before.previous.agent)

    const humanEnded = fold([human('h1', 'hearing'), human('h1', 'ended', { outcome: 'abandoned' })])
    const afterAgent = foldFrom(humanEnded, [run('A', true), run('A', false)])
    expect(afterAgent.previous.human).toBe(humanEnded.previous.human)
  })

  test('a speaker\'s previous turn survives until that speaker\'s next turn ends, and is then replaced by it', () => {
    let s = fold([human('h1', 'hearing'), human('h1', 'ended', { outcome: 'abandoned' })])
    const first = s.previous.human
    s = foldFrom(s, [human('h2', 'hearing'), human('h2', 'transcribing')])
    expect(s.previous.human).toBe(first)
    s = reduce(s, human('h2', 'ended', { outcome: { rejected: 'failed' } }))
    expect(s.previous.human?.id).toBe('h2')
    expect(s.previous.human?.outcome).toBe('rejected')
  })

  test('mode off clears both previous turns with the rest of the state', () => {
    let s = fold([run('A', true), run('A', false), human('h1', 'hearing'), human('h1', 'ended', { outcome: 'abandoned' })])
    expect(s.previous.human).not.toBeNull()
    expect(s.previous.agent).not.toBeNull()
    s = reduce(s, mode('off'))
    expect(s.previous).toEqual({ human: null, agent: null })
  })

  test('the snapshot carries both previous turns as the state holds them', () => {
    const s = fold([run('A', true), run('B', true), human('h1', 'hearing'), human('h1', 'ended', { outcome: 'abandoned' })])
    expect(snapshot(s).previous).toBe(s.previous)
  })
})

describe('The floor', () => {
  test('the floor is the human\'s while the human turn is speaking, including while its utterance is transcribing', () => {
    expect(snapshot(fold([human('h1', 'hearing')])).floor).toBe('human')
    expect(snapshot(fold([human('h1', 'hearing'), human('h1', 'transcribing')])).floor).toBe('human')
  })

  test('the floor is the agent\'s while the agent turn is opening, speaking or closing', () => {
    expect(snapshot(fold([run('A', true)])).floor).toBe('agent')
    expect(snapshot(fold(agentSpeaking('A'))).floor).toBe('agent')
    expect(snapshot(fold([...agentSpeaking('A'), run('A', false)])).floor).toBe('agent')
  })

  test('the floor is the agent\'s during the overlap of a closing human turn and an opening agent turn', () => {
    const s = fold([...humanSaid('h1'), run('B', true)])
    expect(s.human?.phase).toBe('closing')
    expect(s.agent?.phase).toBe('opening')
    expect(snapshot(s).floor).toBe('agent')
  })

  test('the floor is nobody when no turn is open', () => {
    expect(snapshot(fold([])).floor).toBe('nobody')
    expect(snapshot(fold([run('A', true), run('A', false)])).floor).toBe('nobody')
  })

  test('the floor is nobody whenever the mode is starting, ending or off, whatever the turns say', () => {
    const speaking = fold([human('h1', 'hearing')])
    expect(snapshot(reduce(speaking, mode('starting'))).floor).toBe('nobody')
    expect(snapshot(reduce(speaking, mode('ending'))).floor).toBe('nobody')
    expect(snapshot(reduce(speaking, mode('off'))).floor).toBe('nobody')
  })
})

describe('What the human interrupted', () => {
  test('a candidate accepted while the agent turn is speaking with remaining above the configured minimum records an interruption of speaking with that remaining', () => {
    const s = fold([...agentSpeaking('A', ABOVE), human('h1', 'hearing')])
    expect(s.relations.interruption).toEqual({ phase: 'speaking', remaining: ABOVE, working: true })
  })

  test('a candidate accepted while the agent turn is speaking with remaining at or below the minimum records an interruption of speaking with that remaining', () => {
    const s = fold([...agentSpeaking('A', AT_OR_BELOW), human('h1', 'hearing')])
    expect(s.relations.interruption).toEqual({ phase: 'speaking', remaining: AT_OR_BELOW, working: true })
  })

  test('a candidate accepted while the agent turn is opening records an interruption of opening', () => {
    const s = fold([run('A', true), human('h1', 'hearing')])
    expect(s.relations.interruption?.phase).toBe('opening')
  })

  test('a candidate accepted while the agent turn is closing records an interruption of closing', () => {
    const s = fold([...agentSpeaking('A'), run('A', false), human('h1', 'hearing')])
    expect(s.relations.interruption?.phase).toBe('closing')
  })

  test('an interruption records working as runActive at the moment of the candidate', () => {
    const working = fold([...agentSpeaking('A'), human('h1', 'hearing')])
    expect(working.relations.interruption?.working).toBe(true)

    const notWorking = fold([...agentSpeaking('A'), run('A', false), human('h1', 'hearing')])
    expect(notWorking.relations.interruption?.working).toBe(false)
  })

  test('a candidate joining a speaking human turn does not overwrite what the turn interrupted', () => {
    const s = fold([...agentSpeaking('A', ABOVE), human('h1', 'hearing')])
    const first = s.relations.interruption
    const joined = reduce(s, human('h2', 'hearing'))
    expect(joined.relations.interruption).toBe(first)
  })

  test('a candidate reopening a closing human turn replaces what the turn interrupted with what it interrupts now', () => {
    let s = fold([...agentSpeaking('A', ABOVE), ...humanSaid('h1'), run('B', true)])
    expect(s.relations.interruption?.phase).toBe('speaking')
    s = reduce(s, human('h2', 'hearing'))
    expect(s.relations.interruption?.phase).toBe('opening')
    expect(s.relations.interruption?.working).toBe(true)
  })

  test('a candidate reopening a closing human turn with no agent turn open replaces what the turn interrupted with nothing', () => {
    let s = fold([...agentSpeaking('A', ABOVE), ...humanSaid('h1')])
    expect(s.relations.interruption).not.toBeNull()
    s = reduce(s, human('h2', 'hearing'))
    expect(s.human?.phase).toBe('speaking')
    expect(s.relations.interruption).toBeNull()
  })

  test('an agent turn preempted as it opens under a speaking human turn marks the turn\'s interruption as working', () => {
    const s = fold([...agentSpeaking('A', ABOVE), run('A', false), human('h1', 'hearing')])
    expect(s.relations.interruption).toEqual({ phase: 'closing', remaining: ABOVE, working: false })
    const opened = reduce(s, run('B', true))
    expect(opened.relations.interruption).toEqual({ phase: 'closing', remaining: ABOVE, working: true })
  })

  test('an agent turn preempted as it opens under a speaking human turn records an interruption of opening when there was none', () => {
    const s = fold([human('h1', 'hearing'), run('A', true)])
    expect(s.relations.interruption).toEqual({ phase: 'opening', remaining: 0, working: true })
  })

  test('a candidate accepted with no agent turn open records no interruption', () => {
    expect(fold([human('h1', 'hearing')]).relations.interruption).toBeNull()
    expect(fold([run('A', true), run('A', false), human('h1', 'hearing')]).relations.interruption).toBeNull()
  })
})

describe('The annotation a send carries', () => {
  test('the snapshot\'s annotation is null while the conversation is not known, whatever was interrupted', () => {
    const s = fold([...agentSpeaking('A', ABOVE), human('h1', 'hearing')])
    expect(snapshot(s).annotation).toBe('interrupted-working')
    const unknown = reduce(s, { actor: 'conversation', conversation: { known: false, runActive: false, runId: null, activity: 'idle' } })
    expect(snapshot(unknown).annotation).toBeNull()
  })

  test('the snapshot\'s annotation is interrupted-working when the interruption is working, whatever phase it interrupted', () => {
    expect(snapshot(fold([run('A', true), human('h1', 'hearing')])).annotation).toBe('interrupted-working')
    expect(snapshot(fold([...agentSpeaking('A', AT_OR_BELOW), human('h1', 'hearing')])).annotation).toBe('interrupted-working')
  })

  test('the snapshot\'s annotation is interrupted-speaking when the interruption is not working and interrupted a speaking or closing agent turn with remaining above the minimum', () => {
    const s = fold([...agentSpeaking('A', ABOVE), run('A', false), human('h1', 'hearing')])
    expect(s.relations.interruption?.phase).toBe('closing')
    expect(snapshot(s).annotation).toBe('interrupted-speaking')
  })

  test('the snapshot\'s annotation is null when the interruption is not working and the remaining was at or below the minimum', () => {
    const s = fold([...agentSpeaking('A', AT_OR_BELOW), run('A', false), human('h1', 'hearing')])
    expect(snapshot(s).annotation).toBeNull()
  })

  test('the threshold is the configured one, carried in the state', () => {
    const reports = [...agentSpeaking('A', 1.0), run('A', false), human('h1', 'hearing')]
    expect(snapshot(fold(reports, { interruptionMinRemainingS: 0.5 })).annotation).toBe('interrupted-speaking')
    expect(snapshot(fold(reports, { interruptionMinRemainingS: 1.5 })).annotation).toBeNull()
  })

  test('the snapshot\'s annotation is null when the human turn interrupted nothing', () => {
    expect(snapshot(fold([run(null, false), human('h1', 'hearing')])).annotation).toBeNull()
  })

  test('the annotation reads the interruption and never runActive, so the abort the interruption causes does not change it', () => {
    const s = fold([
      ...agentSpeaking('A', ABOVE),
      human('h1', 'hearing'),
      run('A', false),
      human('h1', 'transcribing'),
      human('h1', 'ended', { outcome: 'transcribed', transcript: 'hi' }),
    ])
    expect(s.human?.phase).toBe('closing')
    expect(snapshot(s).annotation).toBe('interrupted-working')
  })
})

describe('Pausing the agent', () => {
  test('speech muted while an agent turn is open sets pauseReason to speechMuted', () => {
    const s = fold([...agentSpeaking('A'), controls({ speechMuted: true })])
    expect(s.relations.pauseReason).toBe('speechMuted')
  })

  test('unmuting speech clears pauseReason to null', () => {
    const s = fold([...agentSpeaking('A'), controls({ speechMuted: true }), controls({ speechMuted: false })])
    expect(s.relations.pauseReason).toBeNull()
  })

  test('a new agent turn opening clears pauseReason to null, whatever the previous turn left', () => {
    let s = fold([...agentSpeaking('A'), controls({ speechMuted: true })])
    expect(s.relations.pauseReason).toBe('speechMuted')
    s = reduce(s, run('B', true))
    expect(s.relations.pauseReason).toBeNull()
  })

  test('human speech never sets pauseReason: it ends the agent turn', () => {
    const s = fold([...agentSpeaking('A'), human('h1', 'hearing')])
    expect(s.relations.pauseReason).toBeNull()
    expect(s.agent?.phase).toBe('ended')
  })

  test('mayBeAudible is true when the floor is the agent\'s, pauseReason is null, and the agent turn is voiced and not superseded or preempted', () => {
    expect(snapshot(fold(agentSpeaking('A'))).mayBeAudible).toBe(true)
    expect(snapshot(fold([run('A', true)])).mayBeAudible).toBe(true)
  })

  test('mayBeAudible is false for an unvoiced agent turn', () => {
    expect(snapshot(fold([controls({ speechMuted: true }), run('A', true)])).mayBeAudible).toBe(false)
  })

  test('mayBeAudible is false while the floor is the human\'s', () => {
    const s = fold([human('h1', 'hearing')])
    expect(snapshot(s).floor).toBe('human')
    expect(snapshot(s).mayBeAudible).toBe(false)
  })

  test('mayBeAudible is false while speech is muted, and true again on unmute if nothing else holds it', () => {
    let s = fold([...agentSpeaking('A'), controls({ speechMuted: true })])
    expect(snapshot(s).mayBeAudible).toBe(false)
    s = reduce(s, controls({ speechMuted: false }))
    expect(snapshot(s).mayBeAudible).toBe(true)
  })

  test('mayBeAudible is false while the agent turn is superseded, even before a new run id arrives', () => {
    const s = fold([...agentSpeaking('A'), human('h1', 'hearing'), human('h1', 'transcribing'), human('h1', 'ended', { outcome: { rejected: 'empty' } })])
    expect(s.agent?.outcome).toBe('superseded')
    expect(snapshot(s).mayBeAudible).toBe(false)
  })
})

describe('New audio', () => {
  test('newAudio is discard while the agent turn is unvoiced, whoever holds the floor', () => {
    const agentFloor = fold([controls({ speechMuted: true }), run('A', true)])
    expect(snapshot(agentFloor).floor).toBe('agent')
    expect(snapshot(agentFloor).newAudio).toBe('discard')

    const ended = reduce(agentFloor, run('A', false))
    expect(ended.agent?.outcome).toBe('unvoiced')
    expect(snapshot(ended).newAudio).toBe('discard')
  })

  test('newAudio is discard while the agent turn is superseded, whoever holds the floor', () => {
    const s = fold([...agentSpeaking('A'), human('h1', 'hearing')])
    expect(snapshot(s).floor).toBe('human')
    expect(snapshot(s).newAudio).toBe('discard')
  })

  test('newAudio is discard while the agent turn is preempted, whoever holds the floor', () => {
    const s = fold([human('h1', 'hearing'), run('A', true)])
    expect(snapshot(s).floor).toBe('human')
    expect(snapshot(s).newAudio).toBe('discard')
  })

  test('newAudio is park while the floor is the human\'s and the agent turn is none of those', () => {
    const s = fold([run('A', true), run('A', false), human('h1', 'hearing')])
    expect(s.agent?.outcome).toBe('completed')
    expect(snapshot(s).newAudio).toBe('park')
  })

  test('newAudio is play while the floor is the agent\'s and none of the above holds', () => {
    expect(snapshot(fold([run('A', true)])).newAudio).toBe('play')
    expect(snapshot(fold(agentSpeaking('A'))).newAudio).toBe('play')
  })
})

describe('Reports that change nothing', () => {
  test('an agent report with no utterance and nothing mounted changes nothing when its run is the same as the last report\'s', () => {
    const before = fold([run('A', true), agent(null, null, { run: 'A', pending: 1 }), run('A', false)])
    expect(before.agent?.phase).toBe('closing')
    const s = reduce(before, agent(null, null, { run: 'A', pending: 2 }))
    expect(s.agent).toBe(before.agent)
    expect(s.human).toBe(before.human)
  })

  test('an agent report that clears the run settles the agent turn like any other, even with nothing mounted', () => {
    const before = fold([run('A', true), agent(null, null, { run: 'A' }), run('A', false)])
    expect(before.agent?.phase).toBe('closing')
    const s = reduce(before, agent(null, null, { run: null }))
    expect(s.agent?.phase).toBe('ended')
    expect(s.agent?.outcome).toBe('completed')
  })

  test('an agent report while no agent turn is open and no run is set changes nothing about turns', () => {
    const before = fold([human('h1', 'hearing')])
    const s = reduce(before, agent(null, null, { pending: 1 }))
    expect(s.agent).toBeNull()
    expect(s.human).toBe(before.human)
    expect(s.previous).toBe(before.previous)
  })

  test('a player report whose utterance names an agent turn already ended writes that utterance onto the ended turn', () => {
    const before = fold([...agentSpeaking('A'), human('h1', 'hearing')])
    expect(before.agent?.outcome).toBe('superseded')
    expect(before.agent?.utterances[0].phase).toBe('audible')

    const s = reduce(before, agent('A', 'ended', { run: 'A', mounted: true }, 'cut'))
    expect(s.agent?.phase).toBe('ended')
    expect(s.agent?.outcome).toBe('superseded')
    expect(s.agent?.utterances).toEqual([{ speaker: 'agent', id: 'A', phase: 'ended', outcome: 'cut' }])
    expect(s.previous.agent).toEqual(s.agent)
    expect(s.human).toBe(before.human)
    expect(s.previous.human).toBe(before.previous.human)
    expect(s.relations).toBe(before.relations)
  })

  test('a player report whose utterance names the previous agent turn writes onto it and leaves the current turn alone', () => {
    const before = fold([...agentSpeaking('A'), human('h1', 'hearing'), human('h1', 'transcribing'), human('h1', 'ended', { outcome: 'transcribed', transcript: 'hi' }), run('B', true)])
    expect(before.agent?.id).toBe('B')
    expect(before.previous.agent?.id).toBe('A')

    const s = reduce(before, agent('A', 'ended', { run: 'B' }, 'cut'))
    expect(s.previous.agent?.utterances).toEqual([{ speaker: 'agent', id: 'A', phase: 'ended', outcome: 'cut' }])
    expect(s.previous.agent?.outcome).toBe('superseded')
    expect(s.agent?.id).toBe('B')
    expect(s.agent?.phase).toBe('opening')
    expect(s.agent?.utterances).toEqual([])
  })

  test('the same report\'s supply still settles the current agent turn, whichever turn the report\'s utterance names', () => {
    let s = fold([
      ...agentSpeaking('A'),
      run('A', false),
      agent('A', 'ended', { run: null, mounted: true }, 'completed'),
      run('B', true),
      agent(null, null, { run: 'B', pending: 1 }),
      run('B', false),
    ])
    expect(s.previous.agent?.id).toBe('A')
    expect(s.agent?.id).toBe('B')
    expect(s.agent?.phase).toBe('closing')

    s = reduce(s, agent('A', 'ended', { run: null, mounted: true }, 'completed'))
    expect(s.agent?.id).toBe('B')
    expect(s.agent?.phase).toBe('ended')
    expect(s.agent?.outcome).toBe('completed')
    expect(s.previous.agent?.id).toBe('B')
  })

  test('an agent utterance recorded ended is not revived by a later report for the same run', () => {
    let s = fold([...agentSpeaking('A'), agent('A', 'ended', { run: 'A', mounted: true }, 'completed')])
    expect(s.agent?.utterances[0]).toEqual({ speaker: 'agent', id: 'A', phase: 'ended', outcome: 'completed' })

    s = reduce(s, agent('A', 'audible', { run: 'A', mounted: true, remaining: ABOVE }))
    expect(s.agent?.utterances[0]).toEqual({ speaker: 'agent', id: 'A', phase: 'ended', outcome: 'completed' })
  })

  test('a conversation report with known false changes no turn', () => {
    const before = fold([...agentSpeaking('A'), human('h1', 'hearing')])
    const s = reduce(before, { actor: 'conversation', conversation: { known: false, runActive: true, runId: 'B', activity: 'active' } })
    expect(s.agent).toBe(before.agent)
    expect(s.human).toBe(before.human)
    expect(s.previous).toBe(before.previous)
    expect(s.relations).toBe(before.relations)
  })

  test('a repeated report identical to the actor\'s last changes nothing', () => {
    const before = fold([...agentSpeaking('A'), human('h1', 'hearing')])
    expect(reduce(before, human('h1', 'hearing'))).toBe(before)
    expect(reduce(before, run('A', true, 'speaking'))).toBe(before)
    expect(reduce(before, mode('live'))).toBe(before)
  })
})

describe('Mode and teardown', () => {
  test('mode off resets every turn and the relations', () => {
    const s = reduce(fold([...agentSpeaking('A'), human('h1', 'hearing'), controls({ speechMuted: true })]), mode('off'))
    expect(s.human).toBeNull()
    expect(s.agent).toBeNull()
    expect(s.relations).toEqual({ interruption: null, pauseReason: null, agentVoiced: false })
    expect(s.config).toEqual(CONFIG)
  })

  test('mode starting or ending leaves turns as they are and reports the floor as nobody', () => {
    const before = fold([human('h1', 'hearing')])
    for (const m of ['starting', 'ending'] as const) {
      const s = reduce(before, mode(m))
      expect(s.human).toBe(before.human)
      expect(s.agent).toBe(before.agent)
      expect(snapshot(s).floor).toBe('nobody')
      expect(snapshot(s).mode).toBe(m)
    }
  })

  test('a mic mute with a human utterance open leaves the utterance to the human side; the turn manager ends nothing on a mute', () => {
    const hearing = fold([human('h1', 'hearing')])
    const mutedHearing = reduce(hearing, controls({ micMuted: true }))
    expect(mutedHearing.human).toBe(hearing.human)

    const transcribing = fold([human('h1', 'hearing'), human('h1', 'transcribing')])
    const mutedTranscribing = reduce(transcribing, controls({ micMuted: true, autoMuted: true }))
    expect(mutedTranscribing.human).toBe(transcribing.human)
    expect(snapshot(mutedTranscribing).controls).toEqual({ micMuted: true, speechMuted: false, autoMuted: true })
  })

  test('with no mode report yet received the turn manager treats the mode as off', () => {
    const s = reduce(initialTurnManagerState(CONFIG), human('h1', 'hearing'))
    expect(snapshot(s).mode).toBe('off')
    expect(snapshot(s).floor).toBe('nobody')
  })

  test('initialTurnManagerState without an argument uses the default threshold', () => {
    expect(initialTurnManagerState().config).toEqual({ interruptionMinRemainingS: 0.5 })
  })

  test('the snapshot carries the composer\'s focus from its last report, false before any', () => {
    expect(snapshot(fold([])).composer).toEqual({ focused: false })
    expect(snapshot(fold([composer(0, true)])).composer).toEqual({ focused: true })
  })
})
