/**
 * Mic capture: a thin wrapper over the browser audio API.
 *
 * Single-writer design. One buffer (`chunks`), one writer (`onaudioprocess`).
 * MicLoop never writes to the buffer — it only toggles `inUtterance` and
 * reads at commit. This makes duplication impossible: each chunk delivered
 * by the audio API lands in the buffer exactly once.
 *
 * Three behaviours of the same buffer:
 *   - Idle (inUtterance=false): rolling preroll. Push, then shift if length
 *     exceeds PREROLL_FRAMES. Used to preserve leading phonemes when speech
 *     onset is detected.
 *   - Accumulating (inUtterance=true): append-only, unbounded. Every chunk
 *     stays. No artificial limit on utterance length.
 *   - End of utterance: getUtteranceAudio() concatenates the whole buffer;
 *     endUtterance() trims back to the last PREROLL_FRAMES and returns to idle.
 */

export interface MicCaptureCallbacks {
  onChunk: (chunk16k: Float32Array) => void
}

export interface MicCaptureStartOpts {
  /**
   * Pre-acquired MediaStream. Required on iOS Safari, where getUserMedia must
   * be invoked synchronously inside the user-gesture frame (the tap handler)
   * to surface the permission prompt. Callers that have a stream in hand pass
   * it here; everyone else falls back to the in-line gUM call below.
   */
  stream?: MediaStream
}

/** Mic constraints — shared with the tap handler so they can't drift. */
export const MIC_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  sampleRate: 16000,
}

const PREROLL_FRAMES = 5 // ~160ms at 32ms/frame

export class MicCapture {
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private processor: ScriptProcessorNode | null = null
  private source: MediaStreamAudioSourceNode | null = null

  // Single buffer. In idle mode it's a rolling preroll; in utterance mode
  // it's the full utterance accumulator (which already includes the preroll
  // that was rolling at the moment beginUtterance was called).
  private chunks: Float32Array[] = []
  private chunkSamples = 0
  private inUtterance = false

  async start(callbacks: MicCaptureCallbacks, opts?: MicCaptureStartOpts): Promise<void> {
    this.stream = opts?.stream ?? await navigator.mediaDevices.getUserMedia({
      audio: MIC_AUDIO_CONSTRAINTS,
    })

    this.context = new AudioContext({ sampleRate: 16000 })
    this.source = this.context.createMediaStreamSource(this.stream)
    this.processor = this.context.createScriptProcessor(4096, 1, 1)

    this.processor.onaudioprocess = (event) => {
      if (!this.context) return
      const chunk = event.inputBuffer.getChannelData(0).slice()

      this.chunks.push(chunk)
      this.chunkSamples += chunk.length

      if (!this.inUtterance) {
        // Rolling preroll: drop oldest until length <= PREROLL_FRAMES
        while (this.chunks.length > PREROLL_FRAMES) {
          const dropped = this.chunks.shift()!
          this.chunkSamples -= dropped.length
        }
      }

      callbacks.onChunk(chunk)
    }

    this.source.connect(this.processor)
    this.processor.connect(this.context.destination)
  }

  stop(): void {
    this.processor?.disconnect()
    this.source?.disconnect()
    this.stream?.getTracks().forEach((t) => t.stop())
    this.context?.close()
    this.processor = null
    this.source = null
    this.stream = null
    this.context = null
    this.chunks = []
    this.chunkSamples = 0
    this.inUtterance = false
  }

  /**
   * Begin an utterance. Switches the buffer from rolling-preroll mode to
   * append-only mode. The preroll already in the buffer is what survives
   * as leading-phoneme protection. Idempotent within an utterance.
   */
  beginUtterance(): void {
    if (this.inUtterance) return
    this.inUtterance = true
  }

  /** Returns the accumulated audio for the current utterance. */
  getUtteranceAudio(): Float32Array {
    const out = new Float32Array(this.chunkSamples)
    let offset = 0
    for (const chunk of this.chunks) {
      out.set(chunk, offset)
      offset += chunk.length
    }
    return out
  }

  /** Duration of the accumulated audio in seconds. */
  getUtteranceDuration(): number {
    return this.chunkSamples / 16000
  }

  /** Whether an utterance is currently being captured. */
  get isInUtterance(): boolean {
    return this.inUtterance
  }

  /**
   * End the current utterance. Trims the buffer back to the last PREROLL_FRAMES
   * and returns to idle (rolling-preroll) mode. The next utterance gets fresh
   * leading-phoneme protection.
   */
  endUtterance(): void {
    this.inUtterance = false
    while (this.chunks.length > PREROLL_FRAMES) {
      const dropped = this.chunks.shift()!
      this.chunkSamples -= dropped.length
    }
  }

  /**
   * Drop everything captured so far — the whole buffer, not just trimmed
   * back to preroll. Used when the buffer's contents must not survive into
   * whatever comes next (a mic mute mid-utterance, or the rolling preroll
   * that accumulated while muted).
   */
  clearBuffer(): void {
    this.chunks = []
    this.chunkSamples = 0
    this.inUtterance = false
  }

  // ── Legacy aliases ────────────────────────────────────────────────────
  // Predate the begin/end-utterance API. Kept as pass-throughs for callers
  // still using the older method names.

  /** @deprecated use getUtteranceAudio() */
  getAudio(): Float32Array { return this.getUtteranceAudio() }

  /** @deprecated use getUtteranceDuration() */
  getDuration(): number { return this.getUtteranceDuration() }

  /** @deprecated use endUtterance() */
  reset(): void { this.endUtterance() }
}
