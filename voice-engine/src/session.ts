import type { Activity, RunEvent } from './run-event'

export type VoiceAnnotation = 'interrupted-speaking' | 'interrupted-working'

/** What the engine reads of a conversation: the run's state and its event stream. */
export interface VoiceConversation {
  getSnapshot(): { known: boolean; runActive: boolean; runId: string | null; activity: Activity }
  subscribe(listener: () => void): () => void
  onEvent(listener: (e: RunEvent) => void): () => void
}

/** What the engine needs of a chat session. The host's session class satisfies it structurally. */
export interface VoiceSession {
  conversation: VoiceConversation
  controls: {
    send(text: string, opts?: { annotation?: VoiceAnnotation }): Promise<void>
    abort(): Promise<void>
  }
}
