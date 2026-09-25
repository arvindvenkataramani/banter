// Design: docs/components/voice-turn-taking.md

import type { Frame } from '../../system/devices'
import { MIC_SAMPLE_RATE } from '../../system/devices'

/**
 * The recorder built on top of a frame source it does not open. Constructed
 * over `lib/system/devices.ts`'s frame source, which owns the microphone
 * stream and its AudioContext — this only attaches to the frames that
 * source delivers.
 *
 * Single-writer design. One buffer (`chunks`), one writer (the frame
 * source's callback). MicLoop never writes to the buffer — it only toggles
 * `inUtterance` and reads at a hand-off. This makes duplication impossible:
 * each frame delivered lands in the buffer exactly once.
 *
 * Three behaviours of the same buffer:
 *   - Idle (inUtterance=false): rolling preroll, bounded in samples rather
 *     than in chunks — the frame source's chunk size is its own to choose,
 *     and may be larger than the preroll depth. Trimming cuts into the
 *     oldest chunk rather than only ever dropping whole ones, so the depth
 *     kept is accurate regardless of chunk size. Used to preserve leading
 *     phonemes when speech onset is detected.
 *   - Accumulating (inUtterance=true): append-only, unbounded. Every chunk
 *     stays. No artificial limit on utterance length.
 *   - End of utterance: getUtteranceAudio() concatenates the whole buffer;
 *     endUtterance() trims back to the preroll depth and returns to idle.
 */

export interface UtteranceBufferCallbacks {
  onChunk: (chunk16k: Float32Array) => void
}

interface FrameSource {
  attach(onFrame: (frame: Frame) => void): void
  detach(): void
}

const PREROLL_MS = 160
const PREROLL_SAMPLES = Math.round((PREROLL_MS * MIC_SAMPLE_RATE) / 1000)

export class UtteranceBuffer {
  private source: FrameSource

  // Single buffer. In idle mode it's a rolling preroll; in utterance mode
  // it's the full utterance accumulator (which already includes the preroll
  // that was rolling at the moment beginUtterance was called).
  private chunks: Float32Array[] = []
  private chunkSamples = 0
  private inUtterance = false

  constructor(source: FrameSource) {
    this.source = source
  }

  start(callbacks: UtteranceBufferCallbacks): void {
    this.source.attach((chunk) => {
      this.chunks.push(chunk)
      this.chunkSamples += chunk.length

      if (!this.inUtterance) this.trimToPreroll()

      callbacks.onChunk(chunk)
    })
  }

  /**
   * Trim the buffer down to the last PREROLL_SAMPLES, cutting into the
   * oldest chunk rather than only ever dropping whole ones — a chunk can be
   * larger than the preroll depth, and dropping it whole would either keep
   * nothing or keep the whole chunk, neither of which is 160ms.
   */
  private trimToPreroll(): void {
    while (this.chunkSamples > PREROLL_SAMPLES) {
      const excess = this.chunkSamples - PREROLL_SAMPLES
      const oldest = this.chunks[0]
      if (oldest.length <= excess) {
        this.chunks.shift()
        this.chunkSamples -= oldest.length
      } else {
        this.chunks[0] = oldest.subarray(excess)
        this.chunkSamples -= excess
      }
    }
  }

  stop(): void {
    this.source.detach()
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
    return this.chunkSamples / MIC_SAMPLE_RATE
  }

  /** Whether an utterance is currently being captured. */
  get isInUtterance(): boolean {
    return this.inUtterance
  }

  /**
   * End the current utterance. Trims the buffer back to the preroll depth
   * and returns to idle (rolling-preroll) mode. The next utterance gets
   * fresh leading-phoneme protection.
   */
  endUtterance(): void {
    this.inUtterance = false
    this.trimToPreroll()
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
  // The voice-input-test page predates the begin/end-utterance API. It calls
  // these older method names. Kept as pass-throughs so the build doesn't
  // break.

  /** @deprecated use getUtteranceAudio() */
  getAudio(): Float32Array { return this.getUtteranceAudio() }

  /** @deprecated use getUtteranceDuration() */
  getDuration(): number { return this.getUtteranceDuration() }

  /** @deprecated use endUtterance() */
  reset(): void { this.endUtterance() }
}
