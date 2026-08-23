import { create } from 'zustand'

export type LLMState = 'idle' | 'generating' | 'streaming' | 'done'

export interface LLMStoreState {
  state: LLMState
  activeRunId: string | null
}

export const useLLMStore = create<LLMStoreState>(() => ({
  state: 'idle',
  activeRunId: null,
}))
