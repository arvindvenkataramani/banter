// Design: docs/components/voice-turn-taking.md

import { create } from 'zustand'
import { emptyReveal, receive, advance, backlog, intervalFor, revealed } from '../human/word-reveal'
import type { RevealState } from '../human/word-reveal'
import { settledText } from '../human/transcript-view'
import { cleanTranscript } from '../human/clean-transcript'

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
  /** Per utterance id, the leading words already sent by someone other than
   * the engine (see `markWordsSent`). Absent means none. Kept apart from
   * `pending` so a mark outlives the entry it was made on. */
  sent: Record<string, SentMark>
}

/** A mark: `shown` is how many leading words the host sent, as the raw partial
 * showed them (what `pendingText` cuts); `cut` is how many words those make
 * once cleaned the way a final is (what `drain` cuts from the final). */
export interface SentMark {
  shown: number
  cut: number
}

export const useTranscriptStore = create<TranscriptStoreState>(() => ({
  settled: '',
  pending: [],
  reveal: emptyReveal(),
  sent: {},
}))

function wordsOf(text: string): string[] {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\s+/) : []
}

/** `text` without its first `count` words, single-spaced. Counts words, not
 * characters, so a final that revises wording or punctuation is cut at the
 * same position. A count of zero leaves `text` as it was. */
function withoutFirstWords(text: string, count: number): string {
  if (!count) return text
  return wordsOf(text).slice(count).join(' ')
}

/** Moves every leading entry that already has a final into `settled`, in
 * order, stopping at the first entry that does not — an entry mid-list with
 * no final blocks everything behind it from appearing, so words never land
 * out of the order they were spoken. Returns the new `settled` and `pending`
 * without writing; callers combine this with whatever else they write in
 * the same `setState` call. */
function drain(settled: string, pending: PendingUtterance[], sent: Record<string, SentMark>): { settled: string; pending: PendingUtterance[] } {
  let out = settled
  let i = 0
  while (i < pending.length && pending[i].final !== null) {
    const mark = sent[pending[i].id]
    // A final settled from a raw partial still carries its filler words; the cut counts cleaned words.
    const final = pending[i].final as string
    const text = mark ? withoutFirstWords(cleanTranscript(final), mark.cut) : final
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
  const { settled, pending, sent } = useTranscriptStore.getState()
  const withFinal = upsertPending(pending, id, { final: text })
  useTranscriptStore.setState(drain(settled, withFinal, sent))
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
  const { settled, pending, sent } = useTranscriptStore.getState()
  const without = pending.filter((p) => p.id !== id)
  useTranscriptStore.setState(drain(settled, without, sent))
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

/** What each pending utterance shows, in spoken order: its final if it has
 * one, its raw text whole if paused or transcribing, and the paced reveal
 * for the entry being heard. `text` is as the composer renders it before any
 * marked words are removed; `sent` is the utterance's mark. */
export function pendingDisplay(state: TranscriptStoreState): { id: string; text: string; sent: number }[] {
  const paced = pacedEntry(state.pending)
  return state.pending.map((p) => {
    let text: string
    if (p.final !== null) text = p.final
    else if (p.paused) text = p.text
    else text = p === paced ? revealed(state.reveal) : p.text
    return { id: p.id, text, sent: state.sent[p.id]?.shown ?? 0 }
  })
}

/** The pending portion as the composer shows it: `pendingDisplay` with each
 * utterance's marked leading words removed, joined in spoken order. */
export function pendingText(state: TranscriptStoreState): string {
  return pendingDisplay(state)
    .map((d) => withoutFirstWords(d.text, d.sent))
    .filter(Boolean)
    .join(' ')
}

/**
 * Marks the first `count` words of utterance `id` as already sent by someone
 * other than the engine (a host composer that sent the shown text itself).
 * The words stop showing in the pending text and are removed from the final
 * when it settles, so the engine sends only what was said after them; an
 * utterance with nothing left sends nothing. `count` is absolute, measured
 * from the utterance's first word as `pendingDisplay` shows it, and zero
 * clears the mark. The mark belongs to the id, so it holds for an entry a
 * late final creates anew. Marks of ids no longer pending are discarded
 * with each call, except `id`'s own.
 *
 * Partials are raw and a final is cleaned of filler words, so the final is
 * cut by the word count of the marked words once cleaned (`cut`), not by
 * `count`. A number the final reformats ("twenty five" to "25") can still
 * leave the cut a word off.
 */
export function markWordsSent(id: string, count: number): void {
  const state = useTranscriptStore.getState()
  const { pending, sent } = state
  const next: Record<string, SentMark> = {}
  for (const [key, value] of Object.entries(sent)) {
    if (key !== id && pending.some((p) => p.id === key)) next[key] = value
  }
  if (count > 0) {
    const shown = pendingDisplay(state).find((d) => d.id === id)
    // With no entry on screen there are no words to clean: cut what was counted.
    const cut = shown ? wordsOf(cleanTranscript(wordsOf(shown.text).slice(0, count).join(' '))).length : count
    next[id] = { shown: count, cut }
  }
  useTranscriptStore.setState({ sent: next })
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
