import { describe, it, expect, beforeEach } from 'vitest'
import { useMediaEngine, playTrack, debugElement, close } from './media-engine'

// What ending means depends on where the track came from. A slot is always
// reachable again from the surface that launched it, so its chrome closes; a
// library track has no such home, so it stays and rewinds. Nothing else in the
// suite reaches the engine's own `ended` handling — the page tests drive
// through rendered components and never fire element events.

// ─────────────────────────────────────────────────────────────────────────
// the design record-H8 — the three
// writers and the two-click gate.
//
// INVENTED: `@/lib/media-voice-mode` does not exist yet on this branch. §8
// delegates every name here ("Where `armed` lives... the mechanism") and the
// README's own "State management" section already gives the shape almost
// verbatim — this import contract transcribes that pseudocode rather than
// inventing a fresh one:
//
//   getMediaVoiceState(): 1 | 2 | 3 | 4 | 6   // the five reachable states
//   isArmed(): boolean
//   armVoice(): void      // first press with media loaded — arms, commits nothing
//   commitVoice(track loaded): void  // second press — dismisses media, voice on
//   voiceOn(): void       // the third writer, called directly when nothing is loaded (H5)
//   voiceOff(): void      // exit ✕ / composer voice-off — H10's stop-everything entry
//   cancelArm(): void     // cancel / Escape / field focus / navigation / any writer
//
// A builder who shapes the derived state as a union or several booleans
// instead of 1|2|3|4|6, or who folds armVoice/commitVoice/voiceOn into one
// function with an argument, is not violating H1/H5-H8 — only this test
// file's own import surface would need updating to match. Tagged per
// DECISION-TIERS invention rule 6; logged here rather than scattered per-test.
//
// Every test in this block is therefore expected to fail with a
// module-resolution error until the build lands — tests-first, not a defect
// in this file. H2's own text calls for driving *every* writer from *every*
// reachable state, including calling voiceOn() directly with media loaded —
// that is not the UI path (H6's gate governs the on-screen control), but it
// is a legitimate defense-in-depth check on the writer itself: even called
// out of the gate's sequence, voiceOn() must still never produce an
// unreachable state. H5/H6's own tests separately pin the gated UI path.
// ─────────────────────────────────────────────────────────────────────────

async function loadMode() {
  return import('./media-voice-mode') as Promise<{
    getMediaVoiceState: () => 1 | 2 | 3 | 4 | 6
    isArmed: () => boolean
    armVoice: () => void
    commitVoice: () => void
    voiceOn: () => void
    voiceOff: () => void
    cancelArm: () => void
  }>
}

describe('H1 — the three writers hold the invariant', () => {
  beforeEach(() => {
    close()
    useMediaEngine.setState({ closedState: 'never-played' })
  })

  it('loadTrack (playTrack) leaves media loaded and playing, voice off, armed false', async () => {
    const mode = await loadMode()
    await playTrack({ id: 'a', title: 'A', manifestDuration: 60, origin: 'library' })

    expect(useMediaEngine.getState().track).not.toBeNull()
    expect(useMediaEngine.getState().playing).toBe(true)
    expect(mode.getMediaVoiceState()).not.toBe(2)
    expect(mode.getMediaVoiceState()).not.toBe(3)
    expect(mode.isArmed()).toBe(false)
  })

  it('voiceOn() with nothing loaded leaves voice live, no media, nothing playing, armed false', async () => {
    const mode = await loadMode()
    mode.voiceOn()

    expect(useMediaEngine.getState().track).toBeNull()
    expect(useMediaEngine.getState().playing).toBe(false)
    expect(mode.isArmed()).toBe(false)
    expect(mode.getMediaVoiceState()).toBe(2)

    mode.voiceOff()
  })

  it('closeMedia (close) leaves no media loaded, nothing playing, armed false', async () => {
    const mode = await loadMode()
    await playTrack({ id: 'a', title: 'A', manifestDuration: 60, origin: 'library' })
    close()

    expect(useMediaEngine.getState().track).toBeNull()
    expect(useMediaEngine.getState().playing).toBe(false)
    expect(mode.isArmed()).toBe(false)
  })
})

describe('H2 — states 5, 7 and 8 are unproducible from any reachable state', () => {
  beforeEach(() => {
    close()
    useMediaEngine.setState({ closedState: 'never-played' })
  })

  it('driving each writer from each reachable state never lands on state 5, 7 or 8', async () => {
    const mode = await loadMode()

    const REACHABLE = [1, 2, 3, 4, 6] as const
    const UNREACHABLE = [5, 7, 8]

    async function resetToState(state: 1 | 2 | 3 | 4 | 6) {
      mode.voiceOff()
      close()
      useMediaEngine.setState({ closedState: 'never-played' })
      if (state === 1) return
      if (state === 2) { mode.voiceOn(); return }
      if (state === 3) { mode.voiceOn(); /* mute is a V1<->V2 transition, orthogonal here per §3 */ return }
      if (state === 4) { await playTrack({ id: 'x', title: 'X', manifestDuration: 60, origin: 'library' }); return }
      if (state === 6) {
        await playTrack({ id: 'x', title: 'X', manifestDuration: 60, origin: 'library' })
        const { toggle } = await import('./media-engine')
        await toggle() // paused, still loaded -> state 6
        return
      }
    }

    for (const start of REACHABLE) {
      await resetToState(start)

      // Every writer, driven from this state.
      await playTrack({ id: 'y', title: 'Y', manifestDuration: 60, origin: 'library' })
      expect(UNREACHABLE).not.toContain(mode.getMediaVoiceState())
      close()

      await resetToState(start)
      mode.voiceOn()
      expect(UNREACHABLE).not.toContain(mode.getMediaVoiceState())
      mode.voiceOff()

      await resetToState(start)
      close()
      expect(UNREACHABLE).not.toContain(mode.getMediaVoiceState())
    }

    mode.voiceOff()
    close()
  })

  it('arm -> navigate (cancelArm) -> press does not commit; it re-arms', async () => {
    const mode = await loadMode()
    await playTrack({ id: 'a', title: 'A', manifestDuration: 60, origin: 'library' })

    mode.armVoice()
    expect(mode.isArmed()).toBe(true)

    mode.cancelArm() // stands in for a route change (H7)
    expect(mode.isArmed()).toBe(false)
    // Media is still loaded — a stale arm must not have silently committed.
    expect(useMediaEngine.getState().track).not.toBeNull()

    mode.armVoice()
    expect(mode.isArmed()).toBe(true)
    // Still armed, not committed — the invariant holds mid-gate too.
    expect(useMediaEngine.getState().track).not.toBeNull()

    close()
    mode.cancelArm()
  })

  it('a library track ending (state 6) then voiceOn() commits cleanly, not through a stale arm', async () => {
    const mode = await loadMode()
    await playTrack({ id: 'a', title: 'A', manifestDuration: 10, origin: 'library' })
    const audio = debugElement()!
    audio.currentTime = 10
    audio.dispatchEvent(new Event('ended')) // library track -> state 6, still loaded

    expect(useMediaEngine.getState().track).not.toBeNull()
    expect(mode.getMediaVoiceState()).toBe(6)

    mode.armVoice()
    mode.commitVoice()

    expect(useMediaEngine.getState().track).toBeNull()
    expect(mode.getMediaVoiceState()).toBe(2)

    mode.voiceOff()
  })

  it('a slot track ending while armed clears both the track and the arm', async () => {
    const mode = await loadMode()
    await playTrack({ id: 'briefing', title: 'Briefing', manifestDuration: 10, origin: 'slot' })
    mode.armVoice()
    expect(mode.isArmed()).toBe(true)

    const audio = debugElement()!
    audio.currentTime = 10
    audio.dispatchEvent(new Event('ended')) // slot -> closes itself -> state 1

    expect(useMediaEngine.getState().track).toBeNull()
    // A stale armed state naming a track that no longer exists must not
    // survive the track's own disappearance.
    expect(mode.isArmed()).toBe(false)
  })
})

describe('H5, H6 — the two-click gate', () => {
  beforeEach(() => {
    close()
    useMediaEngine.setState({ closedState: 'never-played' })
  })

  it('H5: with nothing loaded, voiceOn() reaches state 2 on one call — no arming', async () => {
    const mode = await loadMode()
    mode.voiceOn()

    expect(mode.isArmed()).toBe(false)
    expect(mode.getMediaVoiceState()).toBe(2)

    mode.voiceOff()
  })

  it('H6: with media loaded, the first arm changes no media x voice state', async () => {
    const mode = await loadMode()
    await playTrack({ id: 'a', title: 'A', manifestDuration: 60, origin: 'library' })
    const wasPlaying = useMediaEngine.getState().playing
    const trackBefore = useMediaEngine.getState().track

    mode.armVoice()

    expect(mode.isArmed()).toBe(true)
    expect(useMediaEngine.getState().track).toEqual(trackBefore)
    expect(useMediaEngine.getState().playing).toBe(wasPlaying)

    close()
  })

  it('H6: the second press (commit) dismisses media and turns voice on, landing in state 2', async () => {
    const mode = await loadMode()
    await playTrack({ id: 'a', title: 'A', manifestDuration: 60, origin: 'library' })
    mode.armVoice()

    mode.commitVoice()

    expect(useMediaEngine.getState().track).toBeNull()
    expect(useMediaEngine.getState().playing).toBe(false)
    expect(mode.isArmed()).toBe(false)
    expect(mode.getMediaVoiceState()).toBe(2)

    mode.voiceOff()
  })

  it('H7: armed is cleared by cancel, Escape-equivalent, and by each of the three writers', async () => {
    const mode = await loadMode()

    // cancel
    await playTrack({ id: 'a', title: 'A', manifestDuration: 60, origin: 'library' })
    mode.armVoice()
    mode.cancelArm()
    expect(mode.isArmed()).toBe(false)

    // cleared by loadTrack (loading a different track while armed)
    mode.armVoice()
    expect(mode.isArmed()).toBe(true)
    await playTrack({ id: 'b', title: 'B', manifestDuration: 60, origin: 'library' })
    expect(mode.isArmed()).toBe(false)

    // cleared by closeMedia
    mode.armVoice()
    expect(mode.isArmed()).toBe(true)
    close()
    expect(mode.isArmed()).toBe(false)

    // cleared by voiceOn/commit itself (post-condition, already covered above)
    await playTrack({ id: 'c', title: 'C', manifestDuration: 60, origin: 'library' })
    mode.armVoice()
    mode.commitVoice()
    expect(mode.isArmed()).toBe(false)
    mode.voiceOff()
  })
})

function fireEnded(): void {
  const audio = debugElement()
  if (!audio) throw new Error('no element — playTrack should have created one')
  audio.dispatchEvent(new Event('ended'))
}

describe('what happens when a track ends', () => {
  beforeEach(() => {
    close()
    useMediaEngine.setState({ closedState: 'never-played' })
  })

  it('closes the player when a slot finishes', async () => {
    await playTrack({ id: 'briefing', title: 'Daily briefing', manifestDuration: 300, origin: 'slot' })
    expect(useMediaEngine.getState().track).not.toBeNull()

    fireEnded()

    const state = useMediaEngine.getState()
    expect(state.track).toBeNull()
    expect(state.playing).toBe(false)
    expect(state.closedState).toBe('closed')
  })

  it('keeps the player and rewinds when a library track finishes', async () => {
    await playTrack({ id: 'lighthouse', title: 'Lighthouse', manifestDuration: 354, origin: 'library' })
    const audio = debugElement()
    if (audio) audio.currentTime = 354

    fireEnded()

    const state = useMediaEngine.getState()
    expect(state.track?.id).toBe('lighthouse')
    expect(state.playing).toBe(false)
    // Rewound, so the play control restarts the track rather than resuming a
    // finished one at its end.
    expect(state.currentTime).toBe(0)
    expect(debugElement()?.currentTime).toBe(0)
  })
})
