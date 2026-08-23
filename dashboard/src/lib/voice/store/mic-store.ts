import { create } from 'zustand'

export type MicState = 'idle' | 'hearing' | 'paused' | 'committing'

export interface MicStoreState {
  state: MicState
  speaking: boolean      // derived: state !== 'idle'
  ready: boolean         // VAD + SmartTurn loaded
}

export const useMicStore = create<MicStoreState>(() => ({
  state: 'idle',
  speaking: false,
  ready: false,
}))

/** Derived: is the user currently speaking? Used by the player to hold chunks. */
export function isUserSpeaking(): boolean {
  return useMicStore.getState().speaking
}
