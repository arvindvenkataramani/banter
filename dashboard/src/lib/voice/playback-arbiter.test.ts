import { describe, it, expect, beforeEach } from 'vitest'
import { useMuteStore, resetMutes } from './store/mute-store'
import { reportRunBeginning, reportRunEnding, shouldDiscardChunk } from './playback-arbiter'

// Covers B4: a run that begins while speech is muted stays unvoiced for its
// whole duration, even if the user unmutes mid-run. Nothing else reaches
// this — it's a statement about *when* mute was true, not what it is now,
// which only the arbiter's run-scoped latch can answer.
//
// Under jsdom STREAMING_BACKEND resolves to 'blob' and engine.beginRun() /
// cancel() are safe without init(), so no mocking beyond resetMutes() is
// needed. The latch is module-level state in the arbiter, not test-scoped —
// every test ends its own run via reportRunEnding() so it doesn't leak.
describe('playback-arbiter — run-scoped unvoiced latch (B4)', () => {
  beforeEach(() => {
    resetMutes()
  })

  it('a run begun muted stays unvoiced, even after unmuting mid-run', () => {
    useMuteStore.setState({ speechMuted: true })

    reportRunBeginning()
    expect(shouldDiscardChunk()).toBe(true)

    useMuteStore.setState({ speechMuted: false }) // unmute mid-run
    expect(shouldDiscardChunk()).toBe(true) // the latch is the point — still discarded

    reportRunEnding()
    expect(shouldDiscardChunk()).toBe(false)
  })

  it('a run begun live stays voiced across a mid-run mute', () => {
    useMuteStore.setState({ speechMuted: false })

    reportRunBeginning()
    expect(shouldDiscardChunk()).toBe(false)

    useMuteStore.setState({ speechMuted: true }) // mute mid-run
    expect(shouldDiscardChunk()).toBe(false) // this run was already voiced

    reportRunEnding()
    expect(shouldDiscardChunk()).toBe(false)
  })
})
