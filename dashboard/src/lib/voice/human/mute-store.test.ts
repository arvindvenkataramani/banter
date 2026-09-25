import { describe, it, expect, beforeEach } from 'vitest'
import {
  useMuteStore, resetMutes, toggleMuteAll, toggleSpeechMuted, relinkMutes, setMicAutoMuted,
} from './mute-store'
import { useTurnManagerStore, resetTurnManager } from '../store/turn-manager-store'

// The mute coupling: two states, LINKED and UNLINKED, over two independent
// booleans. Each transition is asserted on the store and on the controls
// report the floor last received, which is what the loop and the player
// reconcile against.

function mutes() {
  return useMuteStore.getState()
}

function reported() {
  return useTurnManagerStore.getState().snapshot.controls
}

/** UNLINKED with the mic muted and speech live. */
function unlinkedMicMutedSpeechLive(): void {
  toggleSpeechMuted()
  toggleMuteAll()
  toggleSpeechMuted()
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

  it('LINKED + mic: both flip together, stays LINKED', () => {
    toggleMuteAll()
    expect(mutes()).toEqual({ micMuted: true, speechMuted: true, muteLinked: true })
    expect(reported()).toMatchObject({ micMuted: true, speechMuted: true })

    toggleMuteAll()
    expect(mutes()).toEqual({ micMuted: false, speechMuted: false, muteLinked: true })
    expect(reported()).toMatchObject({ micMuted: false, speechMuted: false })
  })

  it('LINKED + speech: speech flips alone, becomes UNLINKED', () => {
    toggleSpeechMuted()

    expect(mutes()).toEqual({ micMuted: false, speechMuted: true, muteLinked: false })
    expect(reported()).toMatchObject({ micMuted: false, speechMuted: true })
  })

  it('UNLINKED + mic: mic flips alone, speech untouched, stays UNLINKED', () => {
    toggleSpeechMuted()
    toggleMuteAll()

    expect(mutes()).toEqual({ micMuted: true, speechMuted: true, muteLinked: false })
  })

  it('UNLINKED + speech: speech flips alone, stays UNLINKED while the mic is muted', () => {
    toggleSpeechMuted()
    toggleMuteAll()
    toggleSpeechMuted()

    expect(mutes()).toEqual({ micMuted: true, speechMuted: false, muteLinked: false })
    expect(reported()).toMatchObject({ micMuted: true, speechMuted: false })
  })

  it('UNLINKED + chain: speech adopts the mic value, becomes LINKED', () => {
    unlinkedMicMutedSpeechLive()

    relinkMutes()

    expect(mutes()).toEqual({ micMuted: true, speechMuted: true, muteLinked: true })
    expect(reported()).toMatchObject({ micMuted: true, speechMuted: true })
  })

  it('chain from mic live, speech muted: speech unmutes, becomes LINKED', () => {
    toggleSpeechMuted()

    relinkMutes()

    expect(mutes()).toEqual({ micMuted: false, speechMuted: false, muteLinked: true })
    expect(reported()).toMatchObject({ micMuted: false, speechMuted: false })
  })

  it('UNLINKED + mic landing on both live returns to LINKED', () => {
    unlinkedMicMutedSpeechLive()

    toggleMuteAll()

    expect(mutes()).toEqual({ micMuted: false, speechMuted: false, muteLinked: true })
  })

  it('UNLINKED + speech landing on both live returns to LINKED', () => {
    toggleSpeechMuted()
    toggleSpeechMuted()

    expect(mutes()).toEqual({ micMuted: false, speechMuted: false, muteLinked: true })
  })

  it('resetMutes returns to live and linked from any state', () => {
    unlinkedMicMutedSpeechLive()

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
