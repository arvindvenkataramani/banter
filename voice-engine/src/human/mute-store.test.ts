import { describe, it, expect, beforeEach } from 'vitest'
import {
  useMuteStore, resetMutes, toggleMuteAll, toggleSpeechMuted, relinkMutes, setMicAutoMuted,
} from './mute-store'
import { useTurnManagerStore, resetTurnManager } from '../store/turn-manager-store'

// The mute coupling in the "Human turn" section of
// docs/components/voice-turn-taking.md and `mute-store.ts`. Each
// transition is asserted on the store and on the controls report the floor
// last received, which is what the loop and the player reconcile against.

function mutes() {
  return useMuteStore.getState()
}

function reported() {
  return useTurnManagerStore.getState().snapshot.controls
}

const press = { mic: toggleMuteAll, speech: toggleSpeechMuted, chain: relinkMutes }
type Press = keyof typeof press

// How to reach each starting state from live and linked.
const FROM: Record<string, Press[]> = {
  'LINKED, both live': [],
  'LINKED, both muted': ['mic'],
  'UNLINKED, speech muted': ['speech'],
  'UNLINKED, mic muted': ['speech', 'mic', 'speech'],
  'UNLINKED, both muted': ['speech', 'mic'],
}

beforeEach(() => {
  resetTurnManager()
  resetMutes()
})

describe('mute coupling', () => {
  it('starts live and linked', () => {
    expect(mutes()).toEqual({ micMuted: false, speechMuted: false, muteLinked: true })
    expect(reported()).toEqual({ micMuted: false, speechMuted: false, autoMuted: false })
  })

  it.each([
    ['LINKED, both live', 'mic', { micMuted: true, speechMuted: true, muteLinked: true }],
    ['LINKED, both muted', 'mic', { micMuted: false, speechMuted: false, muteLinked: true }],
    ['LINKED, both live', 'speech', { micMuted: false, speechMuted: true, muteLinked: false }],
    ['UNLINKED, speech muted', 'mic', { micMuted: true, speechMuted: true, muteLinked: false }],
    ['UNLINKED, both muted', 'speech', { micMuted: true, speechMuted: false, muteLinked: false }],
    ['UNLINKED, mic muted', 'chain', { micMuted: true, speechMuted: true, muteLinked: true }],
    ['UNLINKED, speech muted', 'chain', { micMuted: false, speechMuted: false, muteLinked: true }],
    ['UNLINKED, mic muted', 'mic', { micMuted: false, speechMuted: false, muteLinked: true }],
    ['UNLINKED, speech muted', 'speech', { micMuted: false, speechMuted: false, muteLinked: true }],
  ] as [string, Press, ReturnType<typeof mutes>][])('%s, pressing %s, gives %j', (from, pressed, expected) => {
    for (const p of FROM[from]) press[p]()

    press[pressed]()

    expect(mutes()).toEqual(expected)
    expect(reported()).toMatchObject({ micMuted: expected.micMuted, speechMuted: expected.speechMuted })
  })

  it('resetMutes returns to live and linked from any state', () => {
    for (const p of FROM['UNLINKED, mic muted']) press[p]()

    resetMutes()

    expect(mutes()).toEqual({ micMuted: false, speechMuted: false, muteLinked: true })
    expect(reported()).toEqual({ micMuted: false, speechMuted: false, autoMuted: false })
  })
})

describe('auto-mute', () => {
  it('mutes a live mic and unmutes it again, reporting autoMuted while it holds', () => {
    setMicAutoMuted(true)
    expect(mutes().micMuted).toBe(true)
    expect(reported()).toEqual({ micMuted: true, speechMuted: false, autoMuted: true })

    setMicAutoMuted(false)
    expect(mutes().micMuted).toBe(false)
    expect(reported()).toEqual({ micMuted: false, speechMuted: false, autoMuted: false })
  })

  it('leaves a mic the person muted muted when the auto-mute lifts', () => {
    toggleMuteAll()

    setMicAutoMuted(true)
    expect(reported().autoMuted).toBe(false)
    setMicAutoMuted(false)

    expect(mutes().micMuted).toBe(true)
  })

  it('a manual mic toggle during an auto-mute takes ownership of the mic', () => {
    toggleSpeechMuted()
    setMicAutoMuted(true)

    toggleMuteAll()
    expect(mutes().micMuted).toBe(false)
    toggleMuteAll()
    expect(reported()).toMatchObject({ micMuted: true, autoMuted: false })

    setMicAutoMuted(false)
    expect(mutes().micMuted).toBe(true)
  })
})
