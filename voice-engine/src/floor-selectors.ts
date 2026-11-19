// Design: docs/components/voice-turn-taking.md

import { useTurnManagerStore } from './store/turn-manager-store'

/** The player's own state, derived from the floor snapshot's agent
 * utterance — not a separate store. */
export type PlaybackState = 'idle' | 'playing' | 'paused'

/** The loop's own view, derived from the floor snapshot's human utterance —
 * not a separate store. */
export type LoopState = 'idle' | 'hearing' | 'transcribing'

/** The loop's state, derived from the floor snapshot's live human utterance. */
export function loopStateFromSnapshot(): LoopState {
  const human = useTurnManagerStore.getState().snapshot.human
  if (human === null) return 'idle'
  const live = human.utterances.find((u) => u.phase !== 'ended')
  if (!live) return 'idle'
  if (live.phase === 'hearing') return 'hearing'
  if (live.phase === 'transcribing') return 'transcribing'
  // 'paused' reads as idle: the chrome's glow is for active hearing, and a
  // paused utterance is, from the chrome's point of view, indistinguishable
  // from nothing being heard — the mic is muted either way.
  return 'idle'
}

/** See `loopStateFromSnapshot` — same reasoning, for `micReady`. */
export function micReadyFromSnapshot(): boolean {
  const mode = useTurnManagerStore.getState().snapshot.mode
  return mode === 'live' || mode === 'muted'
}

/** See `loopStateFromSnapshot` — same reasoning, for the player's state:
 * derived from the agent utterance's phase rather than held in a separate
 * store. */
export function playbackStateFromSnapshot(): PlaybackState {
  const agent = useTurnManagerStore.getState().snapshot.agent
  if (agent === null) return 'idle'
  const current = agent.utterances.find((u) => u.id === agent.id) ?? null
  if (current === null) return 'idle'
  if (current.phase === 'audible') return 'playing'
  if (current.phase === 'paused') return 'paused'
  return 'idle'
}
