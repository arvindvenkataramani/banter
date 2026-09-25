// Design: docs/components/voice-turn-taking.md

import { UtteranceBuffer } from './utterance-buffer'
import { SileroVad } from './silero-vad'
import { SmartTurn } from './smart-turn'
import { frameSource, MIC_SAMPLE_RATE } from '../../system/devices'
import type { VoiceConfig } from '../voice-config'
import type { VadResult } from './silero-vad'

const DEFAULT_MAX_RECORDING_MS = 300000 // 5 min safety flush
const SMART_TURN_WINDOW_SAMPLES = 8 * MIC_SAMPLE_RATE // SmartTurn looks at the last 8s

/** The loop's own view of its state, for logging alone — nothing downstream
 * of the loop reads this; the floor learns only what `MicLoopCallbacks`
 * reports.
 *
 *   idle       nothing captured
 *   listening  raw speech frames accumulating, not yet confident
 *   hearing    a confident utterance is open (speech or the commit timer
 *              counting down toward it)
 *   paused     a confident utterance is open but the mic is muted — capture
 *              is held, not ended
 *
 * A hand-off ends the utterance: the moment the commit timer or the safety
 * flush fires, the loop reports it and returns to idle at once. Speech that
 * follows is a new utterance, re-earning the confidence gate from zero —
 * there is no state for "handed off, waiting to hear whether it resumes,"
 * except across a pause, which is not a hand-off: the same utterance and id
 * resume on unmute.
 */
export type MicState = 'idle' | 'listening' | 'hearing' | 'paused'

export interface MicLoopCallbacks {
  /** The first raw speech frame of a new, unconfirmed utterance — before
   * anything is known about how it resolves. Carries no id: none is minted
   * until the confidence gate passes. Every span this opens closes through
   * exactly one of `onSpeechConfirmed` or `onUnconfirmed`, never both. */
  onSpeechBegan: () => void
  /** A fresh utterance has been confirmed. Always a new id — a hand-off is
   * terminal, so nothing this loop reports is ever a resume. */
  onSpeechConfirmed: (id: string) => void
  /** Speech judged over: here is everything captured for this utterance,
   * untrimmed. Terminal from the loop's own point of view — the buffer
   * trims to preroll and the id is released synchronously, before this
   * call returns, so speech that follows is captured as a new utterance. */
  onUtteranceEnded: (id: string, audio: Float32Array) => void
  /** Raw speech went quiet without ever crossing the confidence gate: never
   * confirmed, never reported as an utterance, so there is nothing to end —
   * only a fact for `HumanVoice` to clear the transport's context with.
   * Carries no id, since none was ever minted. */
  onUnconfirmed: (durationS: number, peakProb: number) => void
  /** Every captured frame, unconditionally — a streaming transport needs an
   * unbroken stream, and the transport is not this loop's to hold any more.
   * Carries no utterance fact and reports nothing to the floor. */
  onFrame: (chunk: Float32Array) => void
}

let utteranceCounter = 0
function mintUtteranceId(): string {
  return `human-${Date.now()}-${++utteranceCounter}`
}

function concatFloat32(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

/**
 * Mic loop — runs VAD over each chunk delivered by the frame source, decides
 * when an utterance is confidently speech, and tells `HumanVoice` four
 * things about it: speech began and is not yet confirmed, speech confirmed,
 * speech ended with the utterance's audio, and speech that went quiet
 * without ever being confirmed. It returns nothing its caller awaits,
 * re-reads its own state after each model inference it awaits, and calls no
 * `report()` — the floor learns only what `HumanVoice` chooses to tell it,
 * from what this loop hands over.
 *
 * A mute pauses a confirmed utterance rather than ending it — `muteMic()`
 * and `unmuteMic()` move the loop between `hearing` and `paused` directly,
 * called by `HumanVoice`'s own reconciliation rather than reported through a
 * callback, since pausing is not a fact about the utterance's audio the way
 * the four callbacks above are.
 *
 * A hand-off ends the utterance. The moment speech is judged over — the
 * commit timer, the safety flush firing, or a caller forcing one through
 * `commitUtterance()`/`commitPaused()` — the loop reports it and returns to
 * idle at once: the buffer trims to preroll and the id is released before
 * the call returns. Speech that follows is a new utterance, through the
 * confidence gate again from zero; the loop never resumes one it has
 * already handed off — resuming from a pause is not a hand-off, since the
 * utterance never ended.
 *
 * Capture rules: UtteranceBuffer is a single-writer recorder. MicLoop only
 * toggles
 *   - beginUtterance() on first raw speech of a new utterance, and again on
 *     resuming a paused one (switches rolling preroll to append-only mode)
 *   - endUtterance() at every terminal arc: a confirmed noise (no report
 *     ever went out) or a hand-off
 *   - clearBuffer() on a pause, after snapshotting what it held into
 *     pausedAudio — bounds what the still-open microphone captures while
 *     muted to a preroll's worth rather than leaving it to grow unbounded
 *

 * VAD's per-window verdicts drive state transitions and the silence
 * counter, not what gets captured — a captured chunk can span several model
 * windows, and each one's verdict is acted on. Every audio chunk lands in
 * the buffer exactly once via the frame source's callback.
 */
export class MicLoop {
  private vad: SileroVad
  private smartTurn: SmartTurn
  private mic: UtteranceBuffer | null = null
  private cb: MicLoopCallbacks

  // Config
  private _voiceConfig: VoiceConfig | null = null
  get voiceConfig(): VoiceConfig | null { return this._voiceConfig }
  set voiceConfig(v: VoiceConfig | null) {
    this._voiceConfig = v
    const minProb = v?.stt?.vad?.minSpeechProb
    if (typeof minProb === 'number') this.vad.setSpeechThreshold(minProb)
  }

  // State
  private running = false
  private state: MicState = 'idle'
  /** The loop's own current state — `HumanVoice` reads this to decide
   * whether a forced hand-off should go through `commitUtterance()` or
   * `commitPaused()`, and whether a mute is pausing or a mute is landing on
   * unconfirmed/idle capture. */
  get micState(): MicState { return this.state }
  private silenceSamples = 0
  /** A paused utterance has resumed and no speech has been heard since. */
  private awaitingResumedSpeech = false
  private maxSpeechProb = 0
  private vadBusy = false
  private smartTurnOk = true
  private lastSmartTurnProb = 0
  private commitTimer: ReturnType<typeof setTimeout> | null = null
  private safetyTimer: ReturnType<typeof setTimeout> | null = null

  // Mute flag (controls-store mirrored via HumanVoice's reconciliation)
  micMuted = false

  // VAD readiness warn-once
  private warnedNotReady = false

  // The utterance now confirmed and reported, minted when the confidence
  // gate passes. Null while raw speech is accumulating but not yet
  // confident, and cleared again the instant a hand-off or an abandonment
  // fires — a hand-off is terminal, so this never stays set waiting for
  // anything.
  private currentUtteranceId: string | null = null

  /** The confirmed utterance still being heard or held paused, if any. */
  get utteranceInProgress(): string | null { return this.currentUtteranceId }

  /**
   * Audio captured before a pause, snapshotted out of the buffer at the
   * moment of muting so the buffer itself can be cleared (bounded to a
   * rolling preroll) rather than left open, growing with whatever the still-
   * open microphone hears while muted. Concatenated with whatever
   * accumulates after resume at the eventual hand-off. Null except across a
   * pause.
   */
  private pausedAudio: Float32Array | null = null

  constructor(vad: SileroVad, smartTurn: SmartTurn, cb: MicLoopCallbacks) {
    this.vad = vad
    this.smartTurn = smartTurn
    this.cb = cb
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return
    this.running = true

    this.vad.reset()
    this.warnedNotReady = false

    console.log('[mic-loop] starting')

    const mic = new UtteranceBuffer(frameSource)
    this.mic = mic
    mic.start({ onChunk: (chunk) => this.processChunk(chunk) })
  }

  stop(): void {
    if (!this.running) return
    console.log('[mic-loop] stopping')
    this.running = false

    this.cancelCommitTimer()
    this.cancelSafetyFlush()
    this.mic?.stop()
    this.mic = null
    this.resetUtteranceState()
    this.vad.reset()
    this.setState('idle')
  }

  /**
   * Mute is a software gate on analysis — the capture stays open (processChunk
   * bails on micMuted before anything is analysed), so there is no
   * getUserMedia round-trip on unmute — and a signal to stop sending frames
   * onward, so a muted room does not stream to a server or hold its idle
   * timer open.
   *
   * A confirmed utterance in progress is paused, not ended: its audio is
   * snapshotted into `pausedAudio` and the buffer cleared to its bounded
   * rolling-preroll behaviour, so a long mute does not grow the eventual
   * transcript with muted room audio. Unmuting resumes the same utterance.
   * Raw speech that has not yet crossed the confidence gate was never
   * confirmed, so there is nothing to pause — it is reported as unconfirmed
   * speech instead, the same report a cough's own timeout produces, so
   * HumanVoice clears the transport's context for it exactly as it would
   * for one.
   */
  muteMic(): void {
    this.micMuted = true
    this.cancelCommitTimer()
    this.cancelSafetyFlush()
    const pausing = this.currentUtteranceId !== null && this.state === 'hearing'
    const wasListening = this.state === 'listening'
    // Read before resetUtteranceState() below clears maxSpeechProb.
    const durationS = wasListening ? this.mic?.getUtteranceDuration() : undefined
    const peakProb = wasListening ? this.maxSpeechProb : undefined

    if (pausing) {
      // A second pause (mute, unmute, mute again on the same utterance)
      // must accumulate rather than overwrite: what was captured before the
      // first pause is already sitting in pausedAudio, and this pause's own
      // pre-mute span is what the buffer holds right now.
      const captured = this.mic?.getUtteranceAudio() ?? null
      this.pausedAudio = this.pausedAudio !== null && captured !== null
        ? concatFloat32(this.pausedAudio, captured)
        : (this.pausedAudio ?? captured)
      this.mic?.clearBuffer()
      this.vad.reset()
      this.setState('paused')
      console.log('[mic-loop] mic muted — utterance paused')
      return
    }

    this.mic?.endUtterance()
    this.resetUtteranceState()
    // The mic keeps writing into the buffer even though processChunk bails
    // (see the utterance-buffer.ts comment) — clear it so a long mute
    // doesn't grow it unbounded.
    this.mic?.clearBuffer()
    this.vad.reset()
    this.setState('idle')
    console.log('[mic-loop] mic muted — capture stays open')
    if (wasListening && durationS !== undefined && peakProb !== undefined) {
      this.cb.onUnconfirmed(durationS, peakProb)
    }
  }

  unmuteMic(): void {
    if (!this.running) return
    this.micMuted = false
    this.vad.reset()

    if (this.state === 'paused') {
      // Resume the same utterance. The rolling preroll captured since the
      // pause (room audio while muted) must not become this utterance's
      // leading edge — clear it before switching the buffer back to
      // append-only, the same reasoning as the ordinary unmute-from-idle
      // path below.
      this.mic?.clearBuffer()
      this.mic?.beginUtterance()
      // Silence tracked before the pause is stale: a mute landing during
      // trailing silence (already past the pause threshold) must not leave
      // the loop believing the pause threshold is already crossed on
      // resume, which would fire the commit timer on the very first frame
      // rather than judging the resumed speech afresh.
      this.silenceSamples = 0
      // Nobody speaks in the instant they unmute. Until speech is heard
      // again, silence is not the utterance ending; from that speech on, the
      // end is judged as for any other.
      this.awaitingResumedSpeech = true
      this.setState('hearing')
      // The safety flush re-arms for the full window from this moment —
      // the paused span is not charged against it, so a long pause costs
      // the utterance nothing toward the limit.
      this.scheduleSafetyFlush()
      console.log('[mic-loop] mic unmuted — utterance resumed')
      return
    }

    // Drop the rolling preroll captured while muted — otherwise it gets
    // prepended to the first post-unmute utterance and transcribed.
    this.mic?.clearBuffer()
    console.log('[mic-loop] mic unmuted')
  }

  /**
   * Force the loop's ordinary hand-off arc on demand, for a caller (e.g.
   * voice-off) that needs the utterance currently being heard settled
   * without waiting for the commit timer. Requires `state === 'hearing'`;
   * a no-op otherwise.
   */
  commitUtterance(): void {
    if (this.state !== 'hearing') return
    this.fireHandoff(false)
  }

  /**
   * Force the paused utterance named by `id` to hand off, for a caller
   * (composer focus, voice-off) settling words the person has stopped
   * speaking but not yet confirmed as over. Guarded on the loop still
   * holding this id, paused — a stale call finds nothing to do.
   */
  commitPaused(id: string): void {
    if (this.state !== 'paused' || this.currentUtteranceId !== id) return
    this.fireHandoff(false)
  }

  // ── Per-chunk pipeline ─────────────────────────────────────────────────

  private async processChunk(chunk: Float32Array): Promise<void> {
    if (!this.running) return

    // Before every other early return. VAD may skip a frame while it is busy
    // and miss one verdict out of many; frame delivery may not, because a
    // streaming encoder carries cache state across frames and a gap is a
    // hole in the audio the server decodes. HumanVoice's own mute gate
    // decides whether a frame is actually sent onward.
    this.cb.onFrame(chunk)

    if (this.vadBusy || this.micMuted) return

    // Drop chunks until VAD is ready (model load takes ~100ms after start)
    if (!this.vad.isReady()) {
      if (!this.warnedNotReady) {
        console.warn('[mic-loop] dropping chunk — VAD not ready yet')
        this.warnedNotReady = true
      }
      return
    }

    this.vadBusy = true
    let results: VadResult[] = []
    try {
      results = await this.vad.process(chunk)
    } finally {
      this.vadBusy = false
    }
    // Re-read after the await, per the standing rule: a mute landing during
    // inference must not let this chunk's verdicts begin an utterance
    // (onSpeechBegan firing after the mic is already muted) or buffer
    // audio captured while muted — both `running` and `micMuted` can have
    // changed while this awaited.
    if (!this.running || this.micMuted) return

    // A chunk may span several model windows; each carries its own verdict,
    // and every one is acted on in order — collapsing them to the chunk's
    // last verdict would drop onset or silence that fell in an earlier
    // window of the same chunk.
    for (const result of results) {
      const prob = result.speechProbability
      if (prob > this.maxSpeechProb) this.maxSpeechProb = prob

      if (result.isSpeech) {
        this.handleSpeechFrame()
      } else if (this.mic?.isInUtterance) {
        await this.handleSilenceFrame(result.samples)
      }
      // else: silence, no utterance in progress → ignore
    }
  }

  /**
   * The confidence gate: whether accumulated speech since the raw onset is
   * enough to call this a confirmed utterance rather than noise. A cough
   * never crosses both, so it is never confirmed and never reported to
   * anything — nothing downstream ever names it a candidate. Detection
   * tuning is this file's own; no number here is contract.
   */
  private confident(): boolean {
    const mic = this.mic
    if (!mic) return false
    const vad = this.voiceConfig?.stt?.vad
    const minDuration = vad?.minSpeechDurationS ?? 0.75
    const minProb = vad?.minSpeechProb ?? 0.7
    return mic.getUtteranceDuration() >= minDuration && this.maxSpeechProb >= minProb
  }

  private handleSpeechFrame(): void {
    const mic = this.mic
    if (!mic) return

    if (!mic.isInUtterance) {
      // First raw speech of a new utterance — capture switches to
      // append-only. The trigger chunk and the rolling preroll are already
      // in the buffer.
      mic.beginUtterance()
      if (this.currentUtteranceId === null) {
        this.setState('listening')
        this.cb.onSpeechBegan()
      }
    }

    this.silenceSamples = 0
    this.awaitingResumedSpeech = false

    if (this.state === 'listening' && this.currentUtteranceId === null && this.confident()) {
      // The gate just passed: this raw utterance is now a confirmed one.
      this.currentUtteranceId = mintUtteranceId()
      this.setState('hearing')
      this.scheduleSafetyFlush()
      this.cb.onSpeechConfirmed(this.currentUtteranceId)
      return
    }

    if (this.state === 'hearing') {
      // False alarm at the silence boundary — still the same confirmed
      // utterance, nothing to tell HumanVoice that it doesn't already know.
      this.cancelCommitTimer()
    }
  }

  private async handleSilenceFrame(verdictSamples: number): Promise<void> {
    const mic = this.mic
    if (!mic) return

    // Silence is already in the buffer (the frame source pushed it). We just
    // count it, in samples, for pause detection.
    const tt = this.voiceConfig?.stt?.turnTaking
    const pauseSamples = Math.ceil((tt?.pauseThresholdMs ?? 250) * MIC_SAMPLE_RATE / 1000)

    if (this.state === 'listening') {
      // Raw speech that went quiet without ever crossing the confidence
      // gate: a cough, or speech too short to be confirmed. The same pause
      // threshold that ends a confirmed utterance's turn also gives up on
      // an unconfirmed one, rather than leaving capture open in append-only
      // mode until the safety flush. Nothing was ever reported as an
      // utterance — no id was minted — but HumanVoice is told what was
      // seen, so it can clear the transport's context for it.
      this.silenceSamples += verdictSamples
      if (this.silenceSamples >= pauseSamples) {
        const durationS = mic.getUtteranceDuration()
        const peakProb = this.maxSpeechProb
        mic.endUtterance()
        this.silenceSamples = 0
        this.maxSpeechProb = 0
        this.setState('idle')
        this.cb.onUnconfirmed(durationS, peakProb)
      }
      return
    }

    // Only meaningful once confirmed and still live, and not before a
    // resumed utterance has been heard again.
    if (this.state !== 'hearing' || this.awaitingResumedSpeech) return
    const silenceBefore = this.silenceSamples
    this.silenceSamples += verdictSamples

    // Judged once per stretch of silence, as the counter crosses the
    // threshold. Judging it again on every further threshold's worth would
    // restart the commit timer before a delay longer than the threshold
    // could ever fire. A speech frame resets the counter and cancels the
    // timer, so the next pause is judged afresh.
    if (silenceBefore < pauseSamples && this.silenceSamples >= pauseSamples) {
      const audio = mic.getUtteranceAudio()
      if (audio.length > 0 && this.smartTurn && this.smartTurnOk) {
        try {
          // SmartTurn only inspects the last ~8s; slicing avoids re-feeding
          // the entire (unbounded) utterance buffer on each silence-to-pause.
          const window = audio.length > SMART_TURN_WINDOW_SAMPLES
            ? audio.subarray(audio.length - SMART_TURN_WINDOW_SAMPLES)
            : audio
          const stProb = await this.smartTurn.predict(window)
          // Frames kept arriving during the prediction; speech in them has
          // already reset the counter, and a timer started now would fire
          // mid-speech.
          if (this.state !== 'hearing' || this.silenceSamples < pauseSamples) return
          this.startCommitTimer(stProb)
        } catch (err) {
          console.error('[mic-loop] smartTurn failed, disabling:', err)
          this.smartTurnOk = false
          this.startCommitTimer(0)
        }
      } else {
        this.startCommitTimer(0)
      }
    }
  }

  // ── Commit timer ──────────────────────────────────────────────────────

  private startCommitTimer(smartTurnProb: number): void {
    this.cancelCommitTimer()
    this.lastSmartTurnProb = smartTurnProb
    const tt = this.voiceConfig?.stt?.turnTaking
    if (!tt) return

    const {
      commitMinDelayMs = 250,
      commitMaxDelayMs = 2000,
      smartTurnThreshold = 0.7,
      smartTurnLowCutoff = 0.15,
    } = tt
    const curve = tt.curve ?? { type: 'power' as const, exponent: 2 }

    let delay: number
    if (smartTurnProb < smartTurnLowCutoff) {
      delay = commitMaxDelayMs
    } else if (smartTurnProb >= smartTurnThreshold) {
      delay = commitMinDelayMs
    } else {
      const t = (smartTurnProb - smartTurnLowCutoff) / (smartTurnThreshold - smartTurnLowCutoff)
      let shaped: number
      if (curve.type === 'power') {
        shaped = Math.pow(t, curve.exponent)
      } else {
        const s = 1 / (1 + Math.exp(-curve.steepness * (t - curve.center)))
        const s0 = 1 / (1 + Math.exp(-curve.steepness * (0 - curve.center)))
        const s1 = 1 / (1 + Math.exp(-curve.steepness * (1 - curve.center)))
        shaped = (s - s0) / (s1 - s0)
      }
      delay = Math.round(commitMaxDelayMs + shaped * (commitMinDelayMs - commitMaxDelayMs))
    }

    this.commitTimer = setTimeout(() => {
      if (this.state === 'hearing') this.fireHandoff(false)
    }, delay)
  }

  private cancelCommitTimer(): void {
    if (this.commitTimer) {
      clearTimeout(this.commitTimer)
      this.commitTimer = null
    }
  }

  // ── Hand-off ──────────────────────────────────────────────────────────

  /**
   * Speech has been judged over (or the safety flush forced it): the
   * utterance ends here, terminally. Hands the untrimmed buffer to
   * `HumanVoice`, then immediately trims the buffer to preroll and returns
   * to idle — before this call returns, so a speech frame arriving right
   * after is captured as a new utterance, never a resume.
   */
  private fireHandoff(forceFromFlush: boolean): void {
    const mic = this.mic
    if (!mic || !this.running || this.currentUtteranceId === null) return
    this.cancelCommitTimer()
    this.cancelSafetyFlush()

    const utteranceId = this.currentUtteranceId
    const postPause = mic.getUtteranceAudio()
    const audio = this.pausedAudio !== null ? concatFloat32(this.pausedAudio, postPause) : postPause
    console.log(
      forceFromFlush
        ? '[mic-loop] safety-flush hand-off'
        : '[mic-loop] hand-off (smartTurn=%.3f)',
      forceFromFlush ? undefined : this.lastSmartTurnProb,
    )
    mic.endUtterance()
    this.resetUtteranceState()
    this.setState('idle')
    this.cb.onUtteranceEnded(utteranceId, audio)
  }

  // ── Safety flush ──────────────────────────────────────────────────────

  /**
   * Armed at confirmation, timing
   * `maxRecordingMs` from there — not a fixed interval from `start()`.
   * Disarmed at every arc that ends the utterance: a hand-off, an
   * abandonment, or `stop()`. A run-away recording forces the ordinary
   * hand-off arc when it fires; there is no separate "forced" code path,
   * since a hand-off is unconditionally terminal either way.
   */
  private scheduleSafetyFlush(): void {
    this.cancelSafetyFlush()
    this.safetyTimer = setTimeout(() => {
      if (!this.running || this.currentUtteranceId === null) return
      this.fireHandoff(true)
    }, this.voiceConfig?.stt?.maxRecordingMs ?? DEFAULT_MAX_RECORDING_MS)
  }

  private cancelSafetyFlush(): void {
    if (this.safetyTimer) {
      clearTimeout(this.safetyTimer)
      this.safetyTimer = null
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private setState(s: MicState): void {
    if (this.state !== s) {
      console.log('[mic-loop] state %s → %s', this.state, s)
      this.state = s
    }
  }

  private resetUtteranceState(): void {
    this.silenceSamples = 0
    this.awaitingResumedSpeech = false
    this.maxSpeechProb = 0
    this.currentUtteranceId = null
    this.pausedAudio = null
  }
}
