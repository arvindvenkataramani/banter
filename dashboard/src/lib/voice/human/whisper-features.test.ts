// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { WhisperFeatureExtractor } from '@huggingface/transformers'
import { N_FRAMES, N_MELS, WINDOW_SAMPLES, WhisperFeatures, smartTurnWaveform } from './whisper-features'

// The spectrogram's reference is transformers.js's own extractor, given the
// waveform smartTurnWaveform prepares, with max_length = 8 s. Differences come
// only from float32 accumulation order in the mel projection.
const TOLERANCE = 1e-4
const SR = 16000

const config = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../public/models/whisper-tiny/preprocessor_config.json'), 'utf8'),
)

type Extract = (audio: Float32Array, opts: { max_length: number }) => Promise<{ input_features: { data: Float32Array; dims: number[] } }>

let reference: Extract
let ours: WhisperFeatures

beforeAll(() => {
  reference = new WhisperFeatureExtractor(config) as unknown as Extract
  ours = new WhisperFeatures(config.mel_filters)
})

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function noise(samples: number, amplitude: number, seed: number): Float32Array {
  const r = rng(seed)
  const out = new Float32Array(samples)
  for (let i = 0; i < samples; ++i) out[i] = amplitude * (2 * r() - 1)
  return out
}

/** Voiced-speech-like: harmonics of a wandering pitch, syllable-rate envelope, a little noise. */
function speechLike(samples: number, seed: number): Float32Array {
  const r = rng(seed)
  const out = new Float32Array(samples)
  let phase = 0
  for (let i = 0; i < samples; ++i) {
    const t = i / SR
    const f0 = 120 + 30 * Math.sin(2 * Math.PI * 0.7 * t)
    phase += (2 * Math.PI * f0) / SR
    const envelope = Math.max(0, Math.sin(2 * Math.PI * 4 * t)) ** 2
    let v = 0
    for (let h = 1; h <= 12; ++h) v += Math.sin(h * phase) / h
    out[i] = 0.3 * envelope * v + 0.005 * (2 * r() - 1)
  }
  return out
}

function chirp(samples: number): Float32Array {
  const out = new Float32Array(samples)
  for (let i = 0; i < samples; ++i) {
    const t = i / SR
    out[i] = 0.5 * Math.sin(2 * Math.PI * (50 * t + 400 * t * t))
  }
  return out
}

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

async function expectMatches(audio: Float32Array): Promise<void> {
  const prepared = new Float32Array(WINDOW_SAMPLES)
  smartTurnWaveform(audio, prepared)
  const { input_features } = await reference(prepared, { max_length: WINDOW_SAMPLES })
  expect(input_features.dims).toEqual([1, N_MELS, N_FRAMES])

  const got = ours.extract(audio)
  expect(got.length).toBe(N_MELS * N_FRAMES)

  let maxDiff = 0
  for (let i = 0; i < got.length; ++i) {
    maxDiff = Math.max(maxDiff, Math.abs(got[i] - input_features.data[i]))
  }
  expect(maxDiff).toBeLessThan(TOLERANCE)
}

function meanVar(x: Float32Array): { mean: number; variance: number } {
  let sum = 0
  for (const v of x) sum += v
  const mean = sum / x.length
  let sq = 0
  for (const v of x) sq += (v - mean) ** 2
  return { mean, variance: sq / x.length }
}

// smart-turn's reference inference (pipecat-ai/smart-turn inference.py and
// audio_utils.py) keeps the last 8 s, zero-pads at the start, and calls the
// extractor with do_normalize=True.
describe('smartTurnWaveform', () => {
  it('puts short audio at the end of the window, after silence', () => {
    const audio = speechLike(2 * SR, 9)
    const out = new Float32Array(WINDOW_SAMPLES)
    smartTurnWaveform(audio, out)
    const lead = WINDOW_SAMPLES - audio.length
    // Padding normalizes to one constant, and the audio keeps its shape after it.
    expect(new Set(out.subarray(0, lead)).size).toBe(1)
    const scale = (out[lead + 1000] - out[0]) / audio[1000]
    for (const i of [0, 500, 12345, audio.length - 1]) {
      expect(out[lead + i] - out[0]).toBeCloseTo(audio[i] * scale, 4)
    }
  })

  it('keeps only the last 8 s of longer audio', () => {
    const tail = speechLike(WINDOW_SAMPLES, 10)
    const out = new Float32Array(WINDOW_SAMPLES)
    smartTurnWaveform(concat(noise(3 * SR, 1, 11), tail), out)
    const expected = new Float32Array(WINDOW_SAMPLES)
    smartTurnWaveform(tail, expected)
    expect(out).toEqual(expected)
  })

  it('normalizes the whole window, padding included, to zero mean and unit variance', () => {
    const out = new Float32Array(WINDOW_SAMPLES)
    smartTurnWaveform(speechLike(3 * SR, 12), out)
    const { mean, variance } = meanVar(out)
    expect(Math.abs(mean)).toBeLessThan(1e-6)
    expect(variance).toBeCloseTo(1, 4)
  })

  it('leaves digital silence at zero', () => {
    const out = new Float32Array(WINDOW_SAMPLES).fill(7)
    smartTurnWaveform(new Float32Array(SR), out)
    expect(out.every((v) => v === 0)).toBe(true)
  })
})

describe('WhisperFeatures matches transformers.js WhisperFeatureExtractor', () => {
  it('on speech-like audio shorter than 8 s, zero-padded', async () => {
    await expectMatches(speechLike(2.3 * SR, 1))
  })

  it('on exactly 8 s of speech-like audio', async () => {
    await expectMatches(speechLike(WINDOW_SAMPLES, 2))
  })

  it('on audio longer than 8 s, judging only the last 8 s', async () => {
    await expectMatches(concat(chirp(3 * SR), speechLike(7 * SR, 3)))
  })

  it('on broadband noise', async () => {
    await expectMatches(noise(5 * SR, 0.8, 4))
  })

  it('on a frequency sweep', async () => {
    await expectMatches(chirp(6 * SR))
  })

  it('on quiet noise after speech', async () => {
    await expectMatches(concat(speechLike(3 * SR, 5), noise(2 * SR, 1e-4, 6)))
  })

  it('on digital silence', async () => {
    await expectMatches(new Float32Array(SR))
  })

  it('on a single sample', async () => {
    await expectMatches(new Float32Array([0.25]))
  })

  it('gives the same result when called again, so no state leaks between calls', async () => {
    const a = speechLike(4 * SR, 7)
    const first = ours.extract(a)
    ours.extract(noise(8 * SR, 1, 8))
    expect(ours.extract(a)).toEqual(first)
  })
})
