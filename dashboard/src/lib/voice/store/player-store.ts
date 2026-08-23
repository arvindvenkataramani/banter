import { create } from 'zustand'
import { PlaybackEngine } from '../playback-engine'
import type { PlayerState } from '../playback-engine'

export interface PlayerStoreState {
  state: PlayerState
  remainingSeconds: number
  heldChunkCount: number
}

let engine: PlaybackEngine | null = null

/**
 * Get (or create) the engine. The engine writes to the store via callbacks.
 * Consumers should treat the store as the source of truth for state and
 * the engine as the dispatch surface for commands.
 */
export function getPlaybackEngine(): PlaybackEngine {
  if (!engine) {
    engine = new PlaybackEngine({
      onState: (state) => usePlayerStore.setState({ state }),
      onRemainingSeconds: (remainingSeconds) => usePlayerStore.setState({ remainingSeconds }),
      onHeldChunkCount: (heldChunkCount) => usePlayerStore.setState({ heldChunkCount }),
    })
  }
  return engine
}

/** Reset the engine — used by tests and full teardown. */
export function disposePlaybackEngine(): void {
  if (engine) {
    engine.destroy()
    engine = null
  }
  usePlayerStore.setState({ state: 'idle', remainingSeconds: 0, heldChunkCount: 0 })
}

export const usePlayerStore = create<PlayerStoreState>(() => ({
  state: 'idle',
  remainingSeconds: 0,
  heldChunkCount: 0,
}))
