// Design: docs/components/voice-turn-taking.md

import { MicLoop, type MicLoopCallbacks } from './mic-loop'
import { useTurnManagerStore, report } from '../store/turn-manager-store'
import { useTranscriptStore, setPartial, settle, settleVisible, drop } from '../store/transcript-store'
import type { SileroVad } from './silero-vad'
import type { SmartTurn } from './smart-turn'
import type { SttTransport } from './stt-transport'
import type { Utterance } from '../turn-manager'

/** Strip filler words from Parakeet transcripts. */
function cleanTranscript(text: string): string {
  const cleaned = text
    .replace(/\b(uh|um|uhh|umm)\b[,.]?\s*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  // The model answers a stretch of silence with bare punctuation; with no
  // letter or digit in it, nothing was said.
  return /[\p{L}\p{N}]/u.test(cleaned) ? cleaned : ''
}

export interface HumanVoiceCallbacks {
  onError: (msg: string) => void
}

/** A terminal report held back because unconfirmed speech was in progress
 * when it would otherwise have gone out. Released, in order, once that
 * speech resolves one way or the other. */
interface HeldReport {
  id: string
  outcome: Utterance<'human'>['outcome']
  transcript?: string
}

const DEFAULT_SETTLE_ON_STOP_MS = 1500

/**
 * The human side: the microphone loop and the transport that turns its
 * audio into words. Owns transcription and reports the human's utterances
 * to the floor; reconciles mic mute from the floor's controls report, and
 * writes the transcript — the words the person has said and not yet sent.
 * Reaches no gateway — delivering a finished turn is the floor's own work,
 * wired through `store/turn-manager-store.ts`'s `attachSession`.
 *
 * A hand-off ends the utterance, so this class holds no state that spans
 * more than the two utterances a hold can bridge — the one being held and
 * the one whose confirmation or rejection releases it. A pause is not a
 * hand-off: the paused utterance stays the loop's own current one, and this
 * class tracks it only through the loop's `utteranceInProgress`. Nothing
 * here is a staleness marker: no fact is compared against a value captured
 * when a commit began, and no commit is ever re-issued or superseded.
 * `unconfirmed`, `held` and `transcribing` are each a current fact about
 * the session, read at the moment they matter, never against history.
 */
export class HumanVoice {
  readonly loop: MicLoop
  transport: SttTransport | null = null
  private cb: HumanVoiceCallbacks
  private unsubscribeControls: (() => void) | null = null
  /** Re-read after every await, per the standing rule: a commit resolving
   * after stop() must not report into a torn-down pipeline or surface an
   * error for a session nobody is listening to any more. */
  private running = false

  /** True from the loop's onSpeechBegan() until whichever of
   * onSpeechConfirmed/onUnconfirmed next resolves it. Answers exactly one
   * question, asked only when a commit resolves: would reporting this
   * utterance's end now close a turn the person has already resumed
   * speaking in. */
  private unconfirmed = false

  /** Terminal reports queued while `unconfirmed` was true, in the order
   * they were queued — released, in that order, the moment unconfirmed
   * speech resolves either way. */
  private held: HeldReport[] = []

  /** Ids with a commit currently outstanding. A plain set: the only
   * question it answers is membership, since a mute no longer redirects a
   * commit's outcome (a mute pauses the loop, it does not touch a commit
   * already in flight). */
  private transcribing = new Set<string>()

  /** Each outstanding commit's own settle promise, keyed the same as
   * `transcribing` — collected so `stop()` can race them against
   * `settleOnStopMs` without re-deriving anything from `transcribing`
   * itself, which carries no promise. */
  private transcribingSettled = new Map<string, Promise<void>>()

  /** Confirmed utterances under way when the transport was replaced. Each
   * is committed as abandoned when it ends, so its surviving words reach the
   * composer rather than a message. */
  private cutByReconnect = new Set<string>()

  /** The words on screen for an utterance a reconnect cut, taken at the swap.
   * The new socket hears only what follows, so its partials and final are
   * shown and settled after these. */
  private cutPrefix = new Map<string, string>()

  /** Unconfirmed speech was under way when the transport was replaced. If
   * it goes on to be confirmed, that utterance is cut the same way. */
  private speechCutByReconnect = false

  /** Ids `stop()` force-settled with `settleVisible` because their commit
   * was still outstanding when it stopped waiting. Once an id's entry has
   * moved into `settled`, a late resolution for it must not touch the
   * transcript store again — `settle`/`drop` would treat the missing id as
   * a fresh entry and reinsert it out of order. */
  private forceSettled = new Set<string>()

  constructor(vad: SileroVad, smartTurn: SmartTurn, cb: HumanVoiceCallbacks) {
    this.cb = cb
    const loopCallbacks: MicLoopCallbacks = {
      onSpeechBegan: () => { this.unconfirmed = true },
      onSpeechConfirmed: (id) => this.handleSpeechConfirmed(id),
      onUtteranceEnded: (id, audio) => this.handleUtteranceEnded(id, audio),
      onUnconfirmed: () => this.handleUnconfirmed(),
      onFrame: (chunk) => this.transport?.onFrame(chunk),
    }
    this.loop = new MicLoop(vad, smartTurn, loopCallbacks)
  }

  /** Begins reconciling mic mute to the floor's controls, and starts the
   * loop. Reconciles once immediately, in case a mute happened before this
   * call, and once more after the loop has started — `unmuteMic()` no-ops
   * before then. */
  start(): void {
    this.running = true
    this.reconcileMute()
    this.unsubscribeControls = useTurnManagerStore.subscribe(() => this.reconcileMute())
    this.loop.start()
    this.reconcileMute()
  }

  /**
   * Commits an utterance the loop is hearing or holding paused, and
   * resolves once every outstanding commit has returned or
   * `voiceConfig.stt.settleOnStopMs` has passed. The commit must be forced
   * before `loop.stop()` runs — the loop bails on a forced hand-off once it
   * is no longer running — so the order here is fixed.
   */
  async stop(): Promise<void> {
    const inProgress = this.loop.utteranceInProgress
    if (inProgress !== null) {
      if (this.loop.micState === 'hearing') this.loop.commitUtterance()
      else if (this.loop.micState === 'paused') this.loop.commitPaused(inProgress)
    }

    this.loop.stop()

    const settleOnStopMs = this.loop.voiceConfig?.stt?.settleOnStopMs ?? DEFAULT_SETTLE_ON_STOP_MS
    const pending = Promise.all(Array.from(this.transcribingSettled.values()))
    await Promise.race([pending, delay(settleOnStopMs)])

    // A commit still outstanding when the wait above gave up keeps the
    // words that were visible for it rather than losing them. Marked so
    // that commit's own eventual resolution does not write the transcript
    // store a second time — its entry has already moved into `settled`,
    // and a second write would be read as a fresh entry and reinserted out
    // of order.
    for (const id of this.transcribing) {
      settleVisible(id)
      this.forceSettled.add(id)
    }

    // Words already transcribed and held for speech that will now never be
    // confirmed go out as they would have without the hold.
    this.unconfirmed = false
    this.releaseHeld()
    this.running = false
    this.unsubscribeControls?.()
    this.unsubscribeControls = null
    this.transcribing.clear()
    this.transcribingSettled.clear()
    this.cutByReconnect.clear()
    this.cutPrefix.clear()
    this.speechCutByReconnect = false
  }

  /**
   * Swap in a transport built to replace one that closed. It starts sending,
   * so a mute already in force is applied to it here. From this call on,
   * frames captured before its socket opens are held by the socket and sent
   * once it does; frames between the old socket's close and this call are
   * lost.
   *
   * Speech under way at the swap began on the old socket, so its final from
   * the new one covers only the rest. Sent, it would give the agent the
   * second half of a sentence; it goes to the composer instead, through the
   * abandoned path, where the person can see what survived. Returns whether
   * a confirmed utterance was cut, so the caller can say words were lost.
   */
  replaceTransport(transport: SttTransport): boolean {
    this.transport = transport
    transport.setSending(!this.loop.micMuted)
    const cut = this.loop.utteranceInProgress
    if (cut !== null) {
      this.cutByReconnect.add(cut)
      const shown = useTranscriptStore.getState().pending.find((p) => p.id === cut)?.text
      if (shown) this.cutPrefix.set(cut, shown)
      return true
    }
    if (this.unconfirmed) this.speechCutByReconnect = true
    return false
  }

  /**
   * The streaming transport's partial, as it currently stands — raw,
   * untrimmed. Attributed to the loop's own current utterance (hearing or
   * paused); a partial arriving with none open (a socket-level event with
   * no utterance behind it) is dropped. The streaming transport carries no
   * id of its own, but `Finalize` resets the server's context at every
   * hand-off, so at most one utterance is ever receiving partials at a
   * time — the loop's `utteranceInProgress` is unambiguous.
   */
  receivePartial(text: string): void {
    const id = this.loop.utteranceInProgress
    if (id === null) return
    const prefix = this.cutPrefix.get(id)
    setPartial(id, prefix ? `${prefix} ${text}` : text, this.loop.micState === 'paused')
  }

  private reconcileMute(): void {
    const snapshot = useTurnManagerStore.getState().snapshot
    const micMuted = snapshot.controls.micMuted
    if (micMuted && !this.loop.micMuted) {
      // muteMic() first: its own first line sets loop.micMuted, the flag
      // every report below re-enters this same subscriber through. Calling
      // it first means that re-entrant pass already reads micMuted true and
      // takes no further action.
      const pausing = this.loop.micState === 'hearing' && this.loop.utteranceInProgress !== null
      this.loop.muteMic()
      this.transport?.setSending(false, pausing ? (this.loop.voiceConfig?.stt?.pauseFlushMs ?? 1500) : 0)
      if (pausing) {
        const id = this.loop.utteranceInProgress
        if (id !== null) {
          this.report(id, 'paused')
          setPartial(id, this.currentEntryText(id), true)
        }
      }
      // A mute landing on an outstanding commit does nothing here — the
      // commit resolves on its own schedule and reports its ordinary
      // outcome when it does; the reducer's own rules (held, sendPending,
      // micMuted) decide what that does to the turn, not a redirect here.
    } else if (!micMuted && this.loop.micMuted) {
      const resuming = this.loop.micState === 'paused'
      const id = this.loop.utteranceInProgress
      this.loop.unmuteMic()
      this.transport?.setSending(true)
      if (resuming && id !== null) {
        this.report(id, 'hearing')
        setPartial(id, this.currentEntryText(id), false)
      }
    }
    this.reconcileFocusSettle()
  }

  /** The text currently on screen for `id`'s pending entry, or empty for
   * one that does not exist yet — used to flip `paused` on an entry without
   * disturbing its text. */
  private currentEntryText(id: string): string {
    return useTranscriptStore.getState().pending.find((p) => p.id === id)?.text ?? ''
  }

  /**
   * Focusing the composer settles the utterance the mute just paused,
   * whatever kind of mute is in force. Reads the last composer report's
   * `focused` field off the turn manager's own state — not `autoMuted`,
   * which is a no-op when the mic was already manually muted and so cannot
   * be relied on to reach here on its own.
   */
  private reconcileFocusSettle(): void {
    if (this.loop.micState !== 'paused') return
    const id = this.loop.utteranceInProgress
    if (id === null) return
    if (useTurnManagerStore.getState().snapshot.composer.focused) this.commitPaused(id)
  }

  /**
   * Commits the utterance the loop is holding paused, so its words become
   * text the composer can edit. Guarded on the loop still holding this id,
   * paused — a stale call (mute cleared by another path first) is a no-op.
   */
  private commitPaused(id: string): void {
    if (this.loop.micState !== 'paused' || this.loop.utteranceInProgress !== id) return
    this.loop.commitPaused(id)
  }

  // ── Loop callbacks ─────────────────────────────────────────────────────

  private handleSpeechConfirmed(id: string): void {
    // A fresh id — the loop never re-fires this for a resume, which is
    // driven by reconcileMute's unmute branch instead. Its entry is made
    // here, at confirmation, so it holds its place in spoken order whether a
    // partial ever arrives for it (batch never sends one) or not.
    setPartial(id, '', false)
    // Reported first, before the held report(s) below: this is what lets
    // the new utterance join the still-open turn ahead of whatever closes
    // it, so both land in the same turn and one message carries both.
    this.report(id, 'hearing')
    this.releaseHeld()
    this.unconfirmed = false
    if (this.speechCutByReconnect) {
      this.speechCutByReconnect = false
      this.cutByReconnect.add(id)
    }
  }

  private handleUnconfirmed(): void {
    // No `hearing` precedes this release — there is no new utterance to
    // report; the person's speech never crossed the gate.
    this.releaseHeld()
    this.unconfirmed = false
    this.speechCutByReconnect = false
    void this.transport?.discard()
  }

  /** Releases every held report in order. A held report carries its own
   * outcome as resolved; whether the turn it lands in is held by a mute is
   * the reducer's business, not a redirect performed here. */
  private releaseHeld(): void {
    const toRelease = this.held
    this.held = []
    for (const entry of toRelease) {
      this.report(entry.id, 'ended', entry.outcome, entry.transcript)
    }
  }

  private handleUtteranceEnded(id: string, audio: Float32Array): void {
    this.report(id, 'transcribing')
    this.transcribing.add(id)
    this.transcribingSettled.set(id, this.commitAndReport(id, audio))
  }

  /**
   * Commit `audio` for `id` and settle it exactly once, at the end — the
   * contract's own "no commit can go stale and nothing partial is
   * reported": there is nothing here to re-check against, because a
   * hand-off is terminal and this call is, unconditionally, the one true
   * transcription for this id.
   *
   * The transcript store is written unconditionally on return, before any
   * check of whether the session is still running and before the
   * utterance's `ended` report — so text held for unconfirmed speech is
   * already on screen, a late transcript lands wherever the turn manager
   * has moved on to, and a commit awaited by `stop()` is not thrown away.
   */
  private async commitAndReport(
    id: string,
    audio: Float32Array,
  ): Promise<void> {
    let raw: string | null = null
    let failed = false
    let closedByTransport = false
    try {
      raw = await this.requireTransport().commit(audio)
    } catch (err) {
      failed = true
      closedByTransport = err instanceof Error && err.name === 'SttTransportClosed'
      if (this.running && !closedByTransport) {
        const detail = err instanceof Error ? err.message : String(err)
        this.cb.onError(`Transcription failed — your input was dropped. ${detail}`)
      }
    }

    const text = failed ? '' : cleanTranscript(raw ?? '')

    // The write happens unconditionally on return, before any check of
    // whether the session is still running and before the ended report —
    // per phase 3's contract. A failed commit, one cut by a reconnect, or
    // one stop() stopped waiting for keeps the words that were visible
    // (settleVisible) rather than erasing them; an ordinary success settles
    // its cleaned text; an ordinary empty result drops the entry outright.
    // Skipped entirely once stop() has already force-settled this id — its
    // entry has already moved into `settled`, and writing again would be
    // read as a fresh entry and reinserted out of order.
    if (!this.forceSettled.has(id)) {
      const prefix = this.cutPrefix.get(id)
      this.cutPrefix.delete(id)
      const words = [prefix, text].filter(Boolean).join(' ')
      if (failed) {
        settleVisible(id)
      } else if (words) {
        settle(id, words)
      } else {
        drop(id)
      }
    }

    this.transcribing.delete(id)
    this.transcribingSettled.delete(id)

    if (!this.running) return

    if (this.cutByReconnect.delete(id)) {
      this.report(id, 'ended', 'abandoned', text || undefined)
      return
    }

    const result: HeldReport = failed
      ? { id, outcome: { rejected: 'failed' } }
      : !text
        ? { id, outcome: { rejected: 'empty' } }
        : { id, outcome: 'transcribed', transcript: text }

    if (this.unconfirmed) {
      this.held.push(result)
      return
    }
    this.report(id, 'ended', result.outcome, result.transcript)
  }

  private requireTransport(): SttTransport {
    if (!this.transport) throw new Error('No STT transport configured')
    return this.transport
  }

  private report(
    id: string,
    phase: 'hearing' | 'paused' | 'transcribing' | 'ended',
    outcome?: Utterance<'human'>['outcome'],
    transcript?: string,
  ): void {
    const utterance: Utterance<'human'> = { speaker: 'human', id, phase }
    if (outcome !== undefined) utterance.outcome = outcome
    if (transcript !== undefined) utterance.transcript = transcript
    report({ actor: 'human', utterance })
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
