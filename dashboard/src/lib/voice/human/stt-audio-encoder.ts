/**
 * Encodes captured Float32 frames for the transcription socket.
 *
 * Opus through WebCodecs, which emits raw packets — `MediaRecorder` would wrap
 * them in WebM and the server has no container parser. Measured from a phone
 * on cellular, raw Opus sustained 21.8 kbit/s against pcm16's 257.8, which is
 * pcm16's fixed rate with no headroom left.
 *
 * pcm16 stays as a fallback for browsers without `AudioEncoder`, and as
 * something to switch to when a transcript looks wrong and the codec is a
 * suspect.
 */

import type { AudioFormat } from './stt-socket'

const SAMPLE_RATE = 16000
/** 64 kbit/s is where bandwidth stops constraining the choice. */
const OPUS_BITRATE = 64000

export interface FrameEncoder {
  format: AudioFormat
  encode: (samples: Float32Array) => void
  close: () => void
}

/** True when this browser can encode Opus through WebCodecs. */
export function canEncodeOpus(): boolean {
  return typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined'
}

function toPcm16(samples: Float32Array): ArrayBuffer {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    // Clamp before scaling: a sample past unity would wrap to the opposite
    // rail as a loud click rather than clipping.
    const s = Math.max(-1, Math.min(1, samples[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out.buffer
}

function createPcmEncoder(onFrame: (frame: ArrayBuffer) => void): FrameEncoder {
  return {
    format: 'pcm16',
    encode: (samples) => onFrame(toPcm16(samples)),
    close: () => {},
  }
}

function createOpusEncoder(
  onFrame: (frame: ArrayBuffer) => void,
  onError: (err: Error) => void,
): FrameEncoder {
  let timestamp = 0

  const encoder = new AudioEncoder({
    output: (chunk) => {
      const buf = new ArrayBuffer(chunk.byteLength)
      chunk.copyTo(new Uint8Array(buf))
      onFrame(buf)
    },
    error: (err) => onError(err instanceof Error ? err : new Error(String(err))),
  })

  encoder.configure({
    codec: 'opus',
    sampleRate: SAMPLE_RATE,
    numberOfChannels: 1,
    bitrate: OPUS_BITRATE,
  })

  return {
    format: 'opus',
    encode: (samples) => {
      if (encoder.state !== 'configured') return
      const data = new AudioData({
        format: 'f32',
        sampleRate: SAMPLE_RATE,
        numberOfFrames: samples.length,
        numberOfChannels: 1,
        timestamp,
        // AudioData takes ownership of the buffer it is given, and the caller's
        // Float32Array is the live capture frame.
        data: new Float32Array(samples),
      })
      timestamp += Math.round((samples.length / SAMPLE_RATE) * 1_000_000)
      encoder.encode(data)
      data.close()
    },
    close: () => {
      if (encoder.state !== 'closed') encoder.close()
    },
  }
}

/**
 * Build an encoder for the requested format, falling back to pcm16 when Opus
 * is asked for and unavailable.
 */
export function createEncoder(
  format: AudioFormat,
  onFrame: (frame: ArrayBuffer) => void,
  onError: (err: Error) => void,
): FrameEncoder {
  if (format === 'pcm16' || !canEncodeOpus()) return createPcmEncoder(onFrame)
  return createOpusEncoder(onFrame, onError)
}
