import { MicCapture } from './mic-capture'
import { SileroVad } from './silero-vad'
import { SmartTurn } from './smart-turn'
import { encodeWav } from './wav-encoder'
import { transcribeAudio } from './stt-client'
import { ensureServiceReady } from './voice-service'
import type { VoiceConfig } from './voice-config'
import type { MicState } from './store/mic-store'

/**
 * Turn a transcription failure into something a user can act on. The previous
 * message said only that the service was unavailable, which is the one thing
 * that is often not true: an unreachable-looking STT service is frequently up
 * and healthy but rejecting this page's origin, and the browser reports both
 * identically. stt-client attaches that detail; surface it rather than
 * flattening every cause into one sentence.
 */
function transcribeErrorMessage(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err)
  return `Voice transcription failed — your input was dropped. ${detail}`
}
import type { VoiceAnnotation } from '../controls'

const DEFAULT_MAX_RECORDING_MS = 300000 // 5 min safety flush
const FRAME_MS = 32 // VAD frame duration (16kHz, 512 samples)
const SMART_TURN_WINDOW_SAMPLES = 8 * 16000 // SmartTurn looks at the last 8s

/** Strip filler words and <unk> tokens from Parakeet transcripts. */
function cleanTranscript(text: string): string {
  return text
    .replace(/<unk>\s*/gi, '')
    .replace(/\b(uh|um|uhh|umm)\b[,.]?\s*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export interface MicLoopCallbacks {
  onState: (state: MicState) => void
  onReady: (ready: boolean) => void
  onError: (msg: string) => void
  onSttEndpointChange: (endpoint: string) => void
  // Cross-actor reads
  isPlayerPlaying: () => boolean
  isPlayerPaused: () => boolean
  getPlayerRemainingSeconds: () => number
  // Backed by session.conversation — replaces the old llm-store-derived
  // isLLMActive(). Ground truth, not a local guess: runActive is what the
  // gateway says, not what TTS happens to be doing locally.
  getConversationState: () => { known: boolean; runActive: boolean }
  sendMessage: (text: string, opts?: { annotation?: VoiceAnnotation }) => Promise<void>
  // Audio-disposition reports. MicLoop does not command the playback engine
  // directly — it reports what happened and the playback arbiter
  // decides pause / resume / cancel / hold / release / drop.
  reportSpeechOnset: (playing: boolean) => void
  reportCommitFalseAlarm: (facts: { hadPausedAudio: boolean; playerPaused: boolean }) => void
  reportCommitSend: (facts: { playerPlaying: boolean; playerPaused: boolean; clearAudio: boolean }) => void
  reportNothingToFlush: () => void
  // The mic was muted mid-utterance; nothing downstream will resolve it.
  reportUtteranceAbandoned: (facts: { hadPausedAudio: boolean; playerPaused: boolean }) => void
}

/**
 * Mic loop — runs VAD over each chunk delivered by MicCapture and decides
 * when to begin/end an utterance and when to commit (transcribe + send).
 *
 * Capture rules: MicCapture is a single-writer recorder. MicLoop only toggles
 *   - beginUtterance() on first speech-onset (switches rolling preroll to
 *     append-only mode; the preroll already in the buffer is preserved)
 *   - endUtterance() on commit or noise-rejection (trims back to preroll)
 *
 * VAD's per-frame verdict drives state transitions and the silence counter,
 * not what gets captured. Every audio chunk lands in the recorder exactly
 * once via MicCapture's onaudioprocess.
 */
export class MicLoop {
  private vad: SileroVad
  private smartTurn: SmartTurn
  private mic: MicCapture | null = null
  private cb: MicLoopCallbacks

  // Config
  private _voiceConfig: VoiceConfig | null = null
  get voiceConfig(): VoiceConfig | null { return this._voiceConfig }
  set voiceConfig(v: VoiceConfig | null) {
    this._voiceConfig = v
    const minProb = v?.stt?.vad?.minSpeechProb
    if (typeof minProb === 'number') this.vad.setSpeechThreshold(minProb)
  }
  sttEndpoint = ''

  // State
  private running = false
  private state: MicState = 'idle'
  private silenceFrameCount = 0
  private maxSpeechProb = 0
  private vadBusy = false
  private smartTurnOk = true
  private lastSmartTurnProb = 0
  private commitTimer: ReturnType<typeof setTimeout> | null = null
  private safetyTimer: ReturnType<typeof setTimeout> | null = null

  // Mute flags (config-store mirrored)
  micMuted = false

  // VAD readiness warn-once
  private warnedNotReady = false

  // Stream acquired synchronously inside the user-gesture frame (iOS Safari
  // requirement). Consumed by the next start(), then cleared. unmuteMic()
  // no longer acquires a stream — the capture stays open across a mic mute
  // — so this field exists only for the initial start.
  private pendingStream: MediaStream | null = null

  // Mic actor's own memory across speech-onset → commit. Records whether
  // the player had meaningful audio remaining when this utterance began,
  // which decides cancel-vs-resume and the interruption prefix at commit.
  private interruptionHadAudioLeft = false
  // Records whether the player was user-paused with audio still buffered at
  // speech-onset. Speaking after a manual pause is not an interruption — but
  // the buffered audio should be cleared rather than resumed underneath.
  private hadPausedAudio = false

  // Transcripts that committed while the user was still speaking (mid-thought
  // commit). Held until the next clean commit, then prepended so the user's
  // continuous thought goes to the LLM as one message. Bypassed by the safety
  // flush so a stuck-VAD scenario can't sit on audio indefinitely.
  private pendingTranscripts: string[] = []

  constructor(vad: SileroVad, smartTurn: SmartTurn, cb: MicLoopCallbacks) {
    this.vad = vad
    this.smartTurn = smartTurn
    this.cb = cb
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Hand off a MediaStream acquired up the call chain (typically inside the
   * tap handler so iOS Safari prompts for permission). Consumed by the next
   * start().
   */
  setMicStream(stream: MediaStream): void {
    this.pendingStream = stream
  }

  start(sttEndpoint: string): void {
    if (this.running) return
    this.running = true
    this.sttEndpoint = sttEndpoint

    this.vad.reset()
    this.warnedNotReady = false

    console.log('[mic-loop] starting')

    this.scheduleSafetyFlush()
    const mic = new MicCapture()
    this.mic = mic
    const stream = this.pendingStream
    this.pendingStream = null
    mic.start({ onChunk: (chunk) => this.processChunk(chunk) }, stream ? { stream } : undefined).catch((err) => {
      const msg = `Mic capture failed to start: ${err instanceof Error ? err.message : String(err)}`
      console.error('[mic-loop]', msg, err)
      this.cb.onError(msg)
    })

    this.publishReady(this.vad.isReady())
  }

  stop(): void {
    if (!this.running) return
    console.log('[mic-loop] stopping')
    this.running = false

    this.cancelCommitTimer()
    if (this.safetyTimer) { clearTimeout(this.safetyTimer); this.safetyTimer = null }
    this.mic?.stop()
    this.mic = null
    this.resetUtteranceState()
    this.vad.reset()
    this.setState('idle')
  }

  /**
   * Mute is a software gate only — the capture stays open (processChunk
   * bails on micMuted before anything is analysed), so there is no
   * getUserMedia round-trip on unmute. If an utterance was in progress
   * (hearing, or awaiting its commit timer), muting abandons it: nothing
   * downstream will ever resolve it, since cancelCommitTimer + the state
   * reset below mean handleCommit will never run for it. Report the
   * abandonment so the arbiter can dispose of whatever audio state it left
   * behind, same as it would a false alarm.
   */
  muteMic(): void {
    this.micMuted = true
    this.cancelCommitTimer()
    const abandoning = this.state === 'hearing' || this.state === 'paused'
    const hadPausedAudio = this.hadPausedAudio
    const playerPaused = this.cb.isPlayerPaused()
    this.resetUtteranceState()
    // The mic keeps writing into the buffer even though processChunk bails
    // (see the mic-capture.ts comment) — clear it so a long mute doesn't
    // grow it unbounded.
    this.mic?.clearBuffer()
    this.vad.reset()
    this.setState('idle')
    console.log('[mic-loop] mic muted — capture stays open')
    // Report last: releasing held chunks dispatches them, and anything
    // enqueued in that window must not be re-held by a mic that is already
    // muted.
    if (abandoning) this.cb.reportUtteranceAbandoned({ hadPausedAudio, playerPaused })
  }

  unmuteMic(): void {
    if (!this.running) return
    this.micMuted = false
    this.vad.reset()
    // Drop the rolling preroll captured while muted — otherwise it gets
    // prepended to the first post-unmute utterance and transcribed.
    this.mic?.clearBuffer()
    console.log('[mic-loop] mic unmuted')
  }

  // ── Per-chunk pipeline ─────────────────────────────────────────────────

  private async processChunk(chunk: Float32Array): Promise<void> {
    if (!this.running || this.vadBusy || this.micMuted) return

    // Drop chunks until VAD is ready (model load takes ~100ms after start)
    if (!this.vad.isReady()) {
      if (!this.warnedNotReady) {
        console.warn('[mic-loop] dropping chunk — VAD not ready yet')
        this.warnedNotReady = true
      }
      return
    }

    this.vadBusy = true
    let result = null
    try {
      result = await this.vad.process(chunk)
    } finally {
      this.vadBusy = false
    }
    if (!result || !this.running) return

    const prob = result.speechProbability
    if (prob > this.maxSpeechProb) this.maxSpeechProb = prob

    if (result.isSpeech) {
      this.handleSpeechFrame(prob)
    } else if (this.mic?.isInUtterance) {
      await this.handleSilenceFrame()
    }
    // else: silence, no utterance in progress → ignore
  }

  private handleSpeechFrame(prob: number): void {
    const mic = this.mic
    if (!mic) return

    if (!mic.isInUtterance) {
      // First speech-onset of a new utterance — switch buffer to append-only.
      // The trigger chunk and the rolling preroll are already in the buffer.
      mic.beginUtterance()
      this.handleSpeechOnset(prob)
    }
    // Continued speech: nothing to do — onaudioprocess already pushed it.

    this.silenceFrameCount = 0

    if (this.state === 'idle') this.setState('hearing')
    if (this.state === 'paused') {
      this.cancelCommitTimer()
      this.setState('hearing')
    }
  }

  private async handleSilenceFrame(): Promise<void> {
    const mic = this.mic
    if (!mic) return

    // Silence is already in the buffer (onaudioprocess pushed it). We just
    // count it for pause detection.
    this.silenceFrameCount++

    const tt = this.voiceConfig?.stt?.turnTaking
    const pauseFrames = tt ? Math.ceil((tt.pauseThresholdMs ?? 250) / FRAME_MS) : 8

    if (this.silenceFrameCount >= pauseFrames && this.state === 'hearing') {
      this.setState('paused')
      this.silenceFrameCount = 0

      const audio = mic.getUtteranceAudio()
      if (audio.length > 0 && this.smartTurn && this.smartTurnOk) {
        try {
          // SmartTurn only inspects the last ~8s; slicing avoids re-feeding
          // the entire (unbounded) utterance buffer on each silence-to-pause.
          const window = audio.length > SMART_TURN_WINDOW_SAMPLES
            ? audio.subarray(audio.length - SMART_TURN_WINDOW_SAMPLES)
            : audio
          const stProb = await this.smartTurn.predict(window)
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

  // ── Speech-onset side effects (playback gate) ──────────────────────────

  private handleSpeechOnset(prob: number): void {
    const playing = this.cb.isPlayerPlaying()
    const paused = this.cb.isPlayerPaused()
    const remaining = this.cb.getPlayerRemainingSeconds()
    const minRemaining = this.voiceConfig?.stt?.turnTaking?.interruptionMinRemainingS ?? 0.5

    this.interruptionHadAudioLeft = playing && remaining > minRemaining
    this.hadPausedAudio = paused && remaining > 0
    console.log('[mic-loop] speech-onset prob=%.3f playing=%s paused=%s remaining=%.2fs hadAudioLeft=%s hadPausedAudio=%s',
      prob, playing, paused, remaining, this.interruptionHadAudioLeft, this.hadPausedAudio)

    // Always pause playback on speech-onset so audio doesn't talk over the user.
    // The audio-left flag only governs commit-time decisions (cancel vs resume,
    // prefix vs no prefix), not whether to pause now.
    this.cb.reportSpeechOnset(playing)
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
      if (this.state === 'paused') this.handleCommit()
    }, delay)
  }

  private cancelCommitTimer(): void {
    if (this.commitTimer) {
      clearTimeout(this.commitTimer)
      this.commitTimer = null
    }
  }

  // ── Commit ────────────────────────────────────────────────────────────

  private async handleCommit(): Promise<void> {
    const mic = this.mic
    if (!mic || !this.running) return
    this.cancelCommitTimer()

    const audio = mic.getUtteranceAudio()
    const maxProb = this.maxSpeechProb
    const duration = audio.length / 16000

    // End the utterance buffer immediately; mic keeps capturing for the next one.
    // Reset VAD's LSTM hidden state too — otherwise stale activations from this
    // utterance bias the next one (we've seen this drive a false-alarm cycle
    // where VAD keeps firing on silence + TTS bleed for 4+s straight).
    mic.endUtterance()
    this.vad.reset()
    this.silenceFrameCount = 0
    this.maxSpeechProb = 0

    this.setState('committing')

    // Noise rejection
    const vad = this.voiceConfig?.stt?.vad
    const minDuration = vad?.minSpeechDurationS ?? 0.75
    const minProb = vad?.minSpeechProb ?? 0.7
    if (audio.length === 0 || duration < minDuration || maxProb < minProb) {
      console.log('[mic-loop] rejected as noise (dur=%.1fs, vadProb=%.2f)', duration, maxProb)
      this.cleanupWithoutSend()
      return
    }

    console.log('[mic-loop] commit (smartTurn=%.3f, dur=%.1fs, vadProb=%.2f)',
      this.lastSmartTurnProb, duration, maxProb)

    let transcript: string
    try {
      const wav = encodeWav(audio, 16000)
      const raw = await this.transcribeWithRestart(wav)
      console.log('[mic-loop] transcript: %s', JSON.stringify(raw.slice(0, 120)))
      transcript = cleanTranscript(raw)
    } catch (err) {
      console.error('[mic-loop] transcribe failed:', err)
      this.cb.onError(transcribeErrorMessage(err))
      this.cleanupWithoutSend()
      return
    }

    if (!transcript.trim()) {
      this.cleanupWithoutSend()
      return
    }

    await this.cleanupWithSend(transcript)
  }

  /**
   * False alarm or noise rejection — return to idle without sending.
   *
   * If we paused playback at speech-onset (active playback case), resume it.
   * If the user had already paused before speaking (`hadPausedAudio`), do not
   * touch the player — leave the buffer paused so they can resume manually.
   */
  private cleanupWithoutSend(): void {
    console.log('[mic-loop] cleanup-no-send (false alarm) hadAudioLeft=%s hadPausedAudio=%s',
      this.interruptionHadAudioLeft, this.hadPausedAudio)
    this.cb.reportCommitFalseAlarm({
      hadPausedAudio: this.hadPausedAudio,
      playerPaused: this.cb.isPlayerPaused(),
    })
    this.interruptionHadAudioLeft = false
    this.hadPausedAudio = false
    this.setState('idle')
  }

  /**
   * Real commit — re-read ground truth and act.
   *
   * If the user is currently mid-utterance (a new utterance has begun before
   * this transcript could be sent), hold the transcript and return without
   * side effects. The next clean commit will prepend it. Safety flush passes
   * force=true to bypass this gate so a stuck-VAD scenario can't sit on
   * audio indefinitely.
   *
   * Three branches, in priority order:
   *   - runActive (the gateway run is genuinely still going): abort-then-send
   *     happens *inside* controls.send's own policy — this only has to handle
   *     the local audio that ground truth doesn't own (cancel + drop), then
   *     send with the 'interrupted-working' annotation.
   *   - !runActive but interruptionHadAudioLeft (TTS was still playing an
   *     already-finished response): cancel + drop, 'interrupted-speaking'.
   *   - otherwise: plain send. hadPausedAudio's cancel-vs-release distinction
   *     is unchanged from before this rewrite.
   * A connection gap (known === false) can't be reasoned about at all —
   * plain send, letting a failure surface via the normal error path (a
   * failed delivery item with resend), same as any other send would.
   */
  private async cleanupWithSend(transcript: string, force = false): Promise<void> {
    if (!force && this.mic?.isInUtterance) {
      console.log('[mic-loop] holding transcript — user still speaking: %s',
        JSON.stringify(transcript.slice(0, 80)))
      this.pendingTranscripts.push(transcript)
      // No state side effects: playback was already paused at speech-onset
      // of the *next* utterance, which is what we want to keep paused.
      this.setState('hearing')
      return
    }

    const playerPlaying = this.cb.isPlayerPlaying()
    const playerPaused = this.cb.isPlayerPaused()
    const { known, runActive } = this.cb.getConversationState()
    const realInterrupt = this.interruptionHadAudioLeft
    const clearPaused = this.hadPausedAudio

    console.log('[mic-loop] commit-send playing=%s paused=%s known=%s runActive=%s realInterrupt=%s clearPaused=%s pending=%d',
      playerPlaying, playerPaused, known, runActive, realInterrupt, clearPaused, this.pendingTranscripts.length)

    const merged = [...this.pendingTranscripts, transcript].join(' ')
    this.pendingTranscripts = []

    this.interruptionHadAudioLeft = false
    this.hadPausedAudio = false
    this.setState('idle')

    if (!known) {
      await this.cb.sendMessage(merged).catch(() => {})
      return
    }

    if (runActive) {
      this.cb.reportCommitSend({ playerPlaying, playerPaused, clearAudio: true })
      await this.cb.sendMessage(merged, { annotation: 'interrupted-working' }).catch(() => {})
      return
    }

    if (realInterrupt) {
      this.cb.reportCommitSend({ playerPlaying, playerPaused, clearAudio: true })
      await this.cb.sendMessage(merged, { annotation: 'interrupted-speaking' }).catch(() => {})
      return
    }

    // clearPaused: user had paused earlier and is now speaking — clear the
    // paused buffer so it doesn't play underneath the new turn. Not an
    // interrupt: no annotation, nothing to abort. Otherwise the player was
    // idle at onset — nothing to clear, held chunks are released instead.
    this.cb.reportCommitSend({ playerPlaying, playerPaused, clearAudio: clearPaused })
    await this.cb.sendMessage(merged).catch(() => {})
  }

  // ── Transcription ─────────────────────────────────────────────────────

  private async transcribeWithRestart(wav: ArrayBuffer): Promise<string> {
    try {
      return await transcribeAudio(this.sttEndpoint, wav)
    } catch (first) {
      const previousEndpoint = this.sttEndpoint
      const serviceId = this.voiceConfig?.stt?.serviceId
      if (!serviceId) throw new Error('No STT service configured')
      const newEndpoint = await ensureServiceReady(serviceId)
      this.sttEndpoint = newEndpoint
      this.cb.onSttEndpointChange(newEndpoint)
      try {
        return await transcribeAudio(newEndpoint, wav)
      } catch (second) {
        // The retry usually fails for the same reason as the first attempt, and
        // reporting only the second hides that the endpoint changed in between.
        const a = first instanceof Error ? first.message : String(first)
        const b = second instanceof Error ? second.message : String(second)
        throw new Error(a === b ? a : `${b} (first attempt on ${previousEndpoint}: ${a})`)
      }
    }
  }

  // ── Safety flush ──────────────────────────────────────────────────────

  private scheduleSafetyFlush(): void {
    this.safetyTimer = setTimeout(async () => {
      const mic = this.mic
      if (!mic || !this.running) return

      const audio = mic.getUtteranceAudio()
      const hadUtterance = mic.isInUtterance
      mic.endUtterance()
      this.silenceFrameCount = 0
      this.maxSpeechProb = 0

      if (hadUtterance && audio.length > 0) {
        this.setState('committing')
        try {
          const wav = encodeWav(audio, 16000)
          const text = cleanTranscript(await this.transcribeWithRestart(wav))
          if (text.trim()) await this.cleanupWithSend(text, true) // force: safety flush bypasses speaking gate
          else this.cleanupWithoutSend()
        } catch (err) {
          console.error('[mic-loop] safety-flush transcribe failed:', err)
          this.cb.onError(transcribeErrorMessage(err))
          this.cleanupWithoutSend()
        }
      } else {
        this.cb.reportNothingToFlush()
      }

      if (this.running) this.scheduleSafetyFlush()
    }, this.voiceConfig?.stt?.maxRecordingMs ?? DEFAULT_MAX_RECORDING_MS)
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private setState(s: MicState): void {
    if (this.state !== s) {
      console.log('[mic-loop] state %s → %s', this.state, s)
      this.state = s
      this.cb.onState(s)
    }
  }

  private resetUtteranceState(): void {
    this.silenceFrameCount = 0
    this.maxSpeechProb = 0
    this.interruptionHadAudioLeft = false
    this.hadPausedAudio = false
    this.pendingTranscripts = []
  }

  private publishReady(ready: boolean): void {
    this.cb.onReady(ready)
  }
}
