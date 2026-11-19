// Design: docs/components/voice-turn-taking.md

import { create } from 'zustand'
import { emptyReveal, receive, advance, backlog, intervalFor } from '../human/word-reveal'
import type { RevealState } from '../human/word-reveal'
import { settledText } from '../human/transcript-view'

/** One utterance's own entry in the pending list, kept in the order the
 * utterance was heard. `final` is unset while the utterance is still being
 * heard or transcribed; once set, the entry is eligible to move into
 * `settled` — but only once every entry before it already has. */
export interface PendingUtterance {
  id: string
  text: string
  paused: boolean
  final: string | null
}

/**
 * The message being composed: the words the person has said and not yet
 * sent, plus what they are saying right now. Module-level so it outlives any
 * one `HumanVoice` session and is what the composer shows with voice off.
 *
 * Utterances can overlap — one transcribing while the next is heard — so
 * each has its own entry, kept in the order it was heard; an entry settles
 * into `settled` only once every entry before it has, so words land in the
 * order they were spoken whatever order their transcriptions return.
 *
 * `HumanVoice` is the only writer from the voice side; the composer's edits
 * and a send are the only others. A turn that ends without sending, and
 * voice-off itself, leave `settled` exactly as they found it — only a send
 * empties it.
 */
export interface TranscriptStoreState {
  /** The message as it stands: typed text, and every settled utterance's
   * words, in order. Shown whole, never paced. */
  settled: string
  /** Utterances not yet settled, in the order they were heard. */
  pending: PendingUtterance[]
  /** Pacing state for the entry currently being heard. Not part of the
   * spec's two named fields; kept here because it paces `pending`
   * specifically and there is nowhere else for it to live without a third
   * store. */
  reveal: RevealState
}

export const useTranscriptStore = create<TranscriptStoreState>(() => ({
  settled: '',
  pending: [],
  reveal: emptyReveal(),
}))

/** Moves every leading entry that already has a final into `settled`, in
 * order, stopping at the first entry that does not — an entry mid-list with
 * no final blocks everything behind it from appearing, so words never land
 * out of the order they were spoken. Returns the new `settled` and `pending`
 * without writing; callers combine this with whatever else they write in
 * the same `setState` call. */
function drain(settled: string, pending: PendingUtterance[]): { settled: string; pending: PendingUtterance[] } {
  let out = settled
  let i = 0
  while (i < pending.length && pending[i].final !== null) {
    const text = pending[i].final as string
    if (text) out = out ? `${out} ${text}` : text
    i += 1
  }
  return { settled: out, pending: i === 0 ? pending : pending.slice(i) }
}

function upsertPending(pending: PendingUtterance[], id: string, patch: Partial<PendingUtterance>): PendingUtterance[] {
  const idx = pending.findIndex((p) => p.id === id)
  if (idx === -1) {
    return [...pending, { id, text: '', paused: false, final: null, ...patch }]
  }
  return pending.map((p, i) => (i === idx ? { ...p, ...patch } : p))
}

/** HumanVoice: creates or updates `id`'s entry, raw; entries keep utterance
 * order (a fresh id is appended at the end, an existing one updated in
 * place). */
export function setPartial(id: string, text: string, paused: boolean): void {
  const { pending } = useTranscriptStore.getState()
  useTranscriptStore.setState({ pending: upsertPending(pending, id, { text, paused }) })
}

/** HumanVoice: records `id`'s final. Every leading entry with a final —
 * this one included, once it has one — moves into `settled`, in order, in
 * one write. */
export function settle(id: string, text: string): void {
  const { settled, pending } = useTranscriptStore.getState()
  const withFinal = upsertPending(pending, id, { final: text })
  useTranscriptStore.setState(drain(settled, withFinal))
}

/** HumanVoice: a failed commit, a stop past its wait, or an utterance cut
 * by a reconnect — settles `id` with the text currently on screen for it,
 * so words the person saw are kept rather than erased. */
export function settleVisible(id: string): void {
  const { pending } = useTranscriptStore.getState()
  const entry = pending.find((p) => p.id === id)
  settle(id, entry?.final ?? entry?.text ?? '')
}

/** HumanVoice: an utterance that came back empty — removes its entry
 * outright, with nothing to carry into `settled`. */
export function drop(id: string): void {
  const { settled, pending } = useTranscriptStore.getState()
  const without = pending.filter((p) => p.id !== id)
  useTranscriptStore.setState(drain(settled, without))
}

/** The composer's field, while focused: replaces settled. */
export function editTranscript(text: string): void {
  useTranscriptStore.setState({ settled: text })
}

/** A send: returns settled and empties it; pending entries are untouched. */
export function takeTranscript(): string {
  const { settled } = useTranscriptStore.getState()
  useTranscriptStore.setState({ settled: '' })
  return settled
}

// ── The word reveal's single timer ─────────────────────────────────────────
//
// Paces the entry being heard onto the screen a word at a time — see
// `human/word-reveal.ts` for why. One subscription, set up once with the
// module, so every reader (the desktop composer, the mobile readout) sees
// the same pacing rather than running a timer each.

let revealTimer: ReturnType<typeof setTimeout> | null = null
let minIntervalMs = 55
let maxIntervalMs = 200

/** The reveal's interval bounds, from `voiceConfig.stt.reveal`. Read at
 * pipeline construction; defaults hold until then. */
export function configureReveal(bounds: { minIntervalMs?: number; maxIntervalMs?: number }): void {
  if (typeof bounds.minIntervalMs === 'number') minIntervalMs = bounds.minIntervalMs
  if (typeof bounds.maxIntervalMs === 'number') maxIntervalMs = bounds.maxIntervalMs
}

/** The entry being heard, or held paused: the newest pending entry with no
 * final. Earlier entries without one are transcribing — handed off, their
 * words no longer arriving — and are shown whole, not paced. */
export function pacedEntry(pending: PendingUtterance[]): PendingUtterance | null {
  for (let i = pending.length - 1; i >= 0; i--) {
    if (pending[i].final === null) return pending[i]
  }
  return null
}

// Which entry the reveal is pacing. A new entry starts its reveal from
// nothing rather than inheriting the previous entry's count.
let pacedId: string | null = null

function viewOf(entry: PendingUtterance | null): string {
  if (entry === null) return ''
  return entry.paused ? entry.text : settledText(entry.text)
}

function scheduleReveal(state: RevealState): void {
  if (revealTimer) {
    clearTimeout(revealTimer)
    revealTimer = null
  }
  if (backlog(state) <= 0) return
  revealTimer = setTimeout(() => {
    revealTimer = null
    const next = advance(useTranscriptStore.getState().reveal)
    useTranscriptStore.setState({ reveal: next })
    scheduleReveal(next)
  }, intervalFor(state, minIntervalMs, maxIntervalMs))
}

useTranscriptStore.subscribe((state, prev) => {
  const entry = pacedEntry(state.pending)
  const view = viewOf(entry)
  const prevView = viewOf(pacedEntry(prev.pending))
  const id = entry?.id ?? null
  if (view === prevView && id === pacedId) return
  const base = id === pacedId ? state.reveal : emptyReveal()
  pacedId = id
  const next = receive(base, view)
  useTranscriptStore.setState({ reveal: next })
  scheduleReveal(next)
})
