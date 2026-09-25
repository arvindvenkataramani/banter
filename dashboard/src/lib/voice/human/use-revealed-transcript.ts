/**
 * The transcript's pending portion, rendered: `settled` is not this file's
 * concern (callers already read it straight off the store) — this is the
 * view over `pending` alone, the part the spec calls "the pending entries."
 *
 * Only the entry currently being heard is paced, trailing by roughly one
 * partial's worth — see `word-reveal.ts` for why a burst arriving at once
 * reads as a delayed result where the same words arriving singly read as
 * the system keeping up. Every other entry — final, paused, or handed off and
 * transcribing — is shown whole. The pacing runs once, in the store; this is a
 * read of it, so every caller sees the same words at the same moment
 * however many of them are mounted.
 */

import { useStore } from 'zustand'
import { useTranscriptStore, pacedEntry } from '../store/transcript-store'
import { revealed } from './word-reveal'

/** Every pending entry's text as read-only display, in spoken order: its
 * final if it has one, its raw text whole if paused or transcribing, and the
 * paced reveal for the entry being heard. */
export function usePendingView(): string {
  return useStore(useTranscriptStore, (s) => {
    const paced = pacedEntry(s.pending)
    const parts = s.pending.map((p) => {
      if (p.final !== null) return p.final
      if (p.paused) return p.text
      return p === paced ? revealed(s.reveal) : p.text
    })
    return parts.filter(Boolean).join(' ')
  })
}
