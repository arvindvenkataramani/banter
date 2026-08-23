import { describe, it, expect, beforeEach } from 'vitest'
import { usePlayerStore, disposePlaybackEngine } from './player-store'

describe('player-store', () => {
  beforeEach(() => {
    disposePlaybackEngine()
  })

  it('starts in idle state', () => {
    const s = usePlayerStore.getState()
    expect(s.state).toBe('idle')
    expect(s.remainingSeconds).toBe(0)
    expect(s.heldChunkCount).toBe(0)
  })

  it('disposePlaybackEngine resets store', () => {
    usePlayerStore.setState({ state: 'playing', remainingSeconds: 5, heldChunkCount: 2 })
    disposePlaybackEngine()
    const s = usePlayerStore.getState()
    expect(s.state).toBe('idle')
    expect(s.remainingSeconds).toBe(0)
    expect(s.heldChunkCount).toBe(0)
  })
})
