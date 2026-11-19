/**
 * Whisper log-mel features for smart-turn: 80 mel bands × 800 frames over the
 * last 8 s of 16 kHz audio, preprocessed as smart-turn's reference inference
 * does (pipecat-ai/smart-turn inference.py): zero-padded at the start to 8 s,
 * then normalized to zero mean and unit variance. The spectrogram itself
 * matches transformers.js WhisperFeatureExtractor with max_length = 8 s.
 *
 * The FFT, window and reflect padding are adapted from transformers.js 4.0.1
 * (Apache-2.0; src/utils/maths.js and src/utils/audio.js), whose FFT is in turn
 * adapted from fft.js (MIT). Changes: only the transforms this extractor uses
 * are kept, the mel projection is a plain loop instead of an ONNX MatMul, and
 * every working buffer is allocated once per instance.
 */

const SAMPLE_RATE = 16000
const N_FFT = 400
const HOP = 160
const PAD = N_FFT / 2
const N_BINS = N_FFT / 2 + 1 // 201
export const N_MELS = 80
export const WINDOW_SAMPLES = 8 * SAMPLE_RATE // 128000
export const N_FRAMES = WINDOW_SAMPLES / HOP // 800
const MEL_FLOOR = Math.fround(1e-10)

/** Radix-4 FFT for power-of-two sizes, complex input. */
class P2FFT {
  private readonly size: number
  private readonly csize: number
  private readonly table: Float64Array
  private readonly width: number
  private readonly bitrev: Int32Array

  constructor(size: number) {
    this.size = size | 0
    if (this.size <= 1 || (this.size & (this.size - 1)) !== 0) {
      throw new Error('FFT size must be a power of two larger than 1')
    }
    this.csize = size << 1

    this.table = new Float64Array(this.size * 2)
    for (let i = 0; i < this.table.length; i += 2) {
      const angle = (Math.PI * i) / this.size
      this.table[i] = Math.cos(angle)
      this.table[i + 1] = -Math.sin(angle)
    }

    let power = 0
    for (let t = 1; this.size > t; t <<= 1) ++power
    // Full radix-4 starts at len 8, otherwise at len 4.
    this.width = power % 2 === 0 ? power - 1 : power

    this.bitrev = new Int32Array(1 << this.width)
    for (let j = 0; j < this.bitrev.length; ++j) {
      this.bitrev[j] = 0
      for (let shift = 0; shift < this.width; shift += 2) {
        const revShift = this.width - shift - 2
        this.bitrev[j] |= ((j >>> shift) & 3) << revShift
      }
    }
  }

  transform(out: Float64Array, data: Float64Array): void {
    this.transform4(out, data, 1)
  }

  inverseTransform(out: Float64Array, data: Float64Array): void {
    this.transform4(out, data, -1)
    for (let i = 0; i < out.length; ++i) out[i] /= this.size
  }

  private transform4(out: Float64Array, data: Float64Array, inv: number): void {
    const size = this.csize
    const width = this.width
    let step = 1 << width
    let len = (size / step) << 1

    let outOff: number
    let t: number
    const bitrev = this.bitrev
    if (len === 4) {
      for (outOff = 0, t = 0; outOff < size; outOff += len, ++t) {
        this.singleTransform2(data, out, outOff, bitrev[t], step)
      }
    } else {
      for (outOff = 0, t = 0; outOff < size; outOff += len, ++t) {
        this.singleTransform4(data, out, outOff, bitrev[t], step, inv)
      }
    }

    const table = this.table
    for (step >>= 2; step >= 2; step >>= 2) {
      len = (size / step) << 1
      const quarterLen = len >>> 2

      for (outOff = 0; outOff < size; outOff += len) {
        const limit = outOff + quarterLen - 1
        for (let i = outOff, k = 0; i < limit; i += 2, k += step) {
          const A = i
          const B = A + quarterLen
          const C = B + quarterLen
          const D = C + quarterLen

          const Ar = out[A]
          const Ai = out[A + 1]
          const Br = out[B]
          const Bi = out[B + 1]
          const Cr = out[C]
          const Ci = out[C + 1]
          const Dr = out[D]
          const Di = out[D + 1]

          const tableBr = table[k]
          const tableBi = inv * table[k + 1]
          const MBr = Br * tableBr - Bi * tableBi
          const MBi = Br * tableBi + Bi * tableBr

          const tableCr = table[2 * k]
          const tableCi = inv * table[2 * k + 1]
          const MCr = Cr * tableCr - Ci * tableCi
          const MCi = Cr * tableCi + Ci * tableCr

          const tableDr = table[3 * k]
          const tableDi = inv * table[3 * k + 1]
          const MDr = Dr * tableDr - Di * tableDi
          const MDi = Dr * tableDi + Di * tableDr

          const T0r = Ar + MCr
          const T0i = Ai + MCi
          const T1r = Ar - MCr
          const T1i = Ai - MCi
          const T2r = MBr + MDr
          const T2i = MBi + MDi
          const T3r = inv * (MBr - MDr)
          const T3i = inv * (MBi - MDi)

          out[A] = T0r + T2r
          out[A + 1] = T0i + T2i
          out[B] = T1r + T3i
          out[B + 1] = T1i - T3r
          out[C] = T0r - T2r
          out[C + 1] = T0i - T2i
          out[D] = T1r - T3i
          out[D + 1] = T1i + T3r
        }
      }
    }
  }

  private singleTransform2(data: Float64Array, out: Float64Array, outOff: number, off: number, step: number): void {
    const evenR = data[off]
    const evenI = data[off + 1]
    const oddR = data[off + step]
    const oddI = data[off + step + 1]

    out[outOff] = evenR + oddR
    out[outOff + 1] = evenI + oddI
    out[outOff + 2] = evenR - oddR
    out[outOff + 3] = evenI - oddI
  }

  private singleTransform4(
    data: Float64Array, out: Float64Array, outOff: number, off: number, step: number, inv: number,
  ): void {
    const step2 = step * 2
    const step3 = step * 3

    const Ar = data[off]
    const Ai = data[off + 1]
    const Br = data[off + step]
    const Bi = data[off + step + 1]
    const Cr = data[off + step2]
    const Ci = data[off + step2 + 1]
    const Dr = data[off + step3]
    const Di = data[off + step3 + 1]

    const T0r = Ar + Cr
    const T0i = Ai + Ci
    const T1r = Ar - Cr
    const T1i = Ai - Ci
    const T2r = Br + Dr
    const T2i = Bi + Di
    const T3r = inv * (Br - Dr)
    const T3i = inv * (Bi - Di)

    out[outOff] = T0r + T2r
    out[outOff + 1] = T0i + T2i
    out[outOff + 2] = T1r + T3i
    out[outOff + 3] = T1i - T3r
    out[outOff + 4] = T0r - T2r
    out[outOff + 5] = T0i - T2i
    out[outOff + 6] = T1r - T3i
    out[outOff + 7] = T1i + T3r
  }
}

/**
 * Real-input FFT for a length that is not a power of two (400 here), by the
 * chirp-z transform over a power-of-two FFT. Writes interleaved re/im for
 * the first `bins` frequency bins.
 */
class ChirpZRealFFT {
  private readonly a: number
  private readonly f: P2FFT
  private readonly chirpBuffer: Float64Array
  private readonly slicedChirp: Float64Array
  private readonly buffer1: Float64Array
  private readonly buffer2: Float64Array
  private readonly outBuffer1: Float64Array
  private readonly outBuffer2: Float64Array

  constructor(fftLength: number) {
    const a = 2 * (fftLength - 1)
    const b = 2 * (2 * fftLength - 1)
    const nextP2 = 2 ** Math.ceil(Math.log2(b))
    this.a = a

    const chirp = new Float64Array(b)
    const ichirp = new Float64Array(nextP2)
    this.chirpBuffer = new Float64Array(nextP2)
    this.buffer1 = new Float64Array(nextP2)
    this.buffer2 = new Float64Array(nextP2)
    this.outBuffer1 = new Float64Array(nextP2)
    this.outBuffer2 = new Float64Array(nextP2)

    const theta = (-2 * Math.PI) / fftLength
    const baseR = Math.cos(theta)
    const baseI = Math.sin(theta)

    for (let i = 0; i < b >> 1; ++i) {
      const e = (i + 1 - fftLength) ** 2 / 2.0
      const resultMod = Math.sqrt(baseR ** 2 + baseI ** 2) ** e
      const resultArg = e * Math.atan2(baseI, baseR)

      const i2 = 2 * i
      chirp[i2] = resultMod * Math.cos(resultArg)
      chirp[i2 + 1] = resultMod * Math.sin(resultArg)
      ichirp[i2] = chirp[i2]
      ichirp[i2 + 1] = -chirp[i2 + 1]
    }
    this.slicedChirp = chirp.subarray(a, b)

    this.f = new P2FFT(nextP2 >> 1)
    this.f.transform(this.chirpBuffer, ichirp)
  }

  realTransform(output: Float64Array, input: Float64Array, bins: number): void {
    const ib1 = this.buffer1
    const ib2 = this.buffer2
    const ob2 = this.outBuffer1
    const ob3 = this.outBuffer2
    const cb = this.chirpBuffer
    const sb = this.slicedChirp
    const a = this.a

    for (let j = 0; j < sb.length; j += 2) {
      const aReal = input[j >> 1]
      ib1[j] = aReal * sb[j]
      ib1[j + 1] = aReal * sb[j + 1]
    }
    this.f.transform(ob2, ib1)

    for (let j = 0; j < cb.length; j += 2) {
      const j2 = j + 1
      ib2[j] = ob2[j] * cb[j] - ob2[j2] * cb[j2]
      ib2[j2] = ob2[j] * cb[j2] + ob2[j2] * cb[j]
    }
    this.f.inverseTransform(ob3, ib2)

    for (let j = 0; j < 2 * bins; j += 2) {
      const aReal = ob3[j + a]
      const aImag = ob3[j + a + 1]
      const bReal = sb[j]
      const bImag = sb[j + 1]
      output[j] = aReal * bReal - aImag * bImag
      output[j + 1] = aReal * bImag + aImag * bReal
    }
  }
}

/**
 * Writes smart-turn's model waveform for `audio` into `out` (WINDOW_SAMPLES
 * long): the last 8 s, zero-padded at the start so speech ends where the
 * window ends, then (x − mean) / sqrt(var + 1e-7) over the whole window,
 * padding included, as Hugging Face's zero_mean_unit_var_norm does.
 */
export function smartTurnWaveform(audio: Float32Array, out: Float32Array): void {
  const src = audio.length > WINDOW_SAMPLES ? audio.subarray(audio.length - WINDOW_SAMPLES) : audio
  const lead = WINDOW_SAMPLES - src.length
  out.fill(0, 0, lead)
  out.set(src, lead)

  let sum = 0
  for (let i = 0; i < WINDOW_SAMPLES; ++i) sum += out[i]
  const mean = sum / WINDOW_SAMPLES
  let sq = 0
  for (let i = 0; i < WINDOW_SAMPLES; ++i) sq += (out[i] - mean) ** 2
  const scale = 1 / Math.sqrt(sq / WINDOW_SAMPLES + 1e-7)
  for (let i = 0; i < WINDOW_SAMPLES; ++i) out[i] = (out[i] - mean) * scale
}

export class WhisperFeatures {
  private readonly melFilters: Float32Array // [N_MELS × N_BINS]
  private readonly window = new Float64Array(N_FFT)
  private readonly fft = new ChirpZRealFFT(N_FFT)
  private readonly padded = new Float32Array(WINDOW_SAMPLES + 2 * PAD)
  private readonly frame = new Float64Array(N_FFT)
  private readonly spectrum = new Float64Array(2 * N_BINS)
  private readonly power = new Float32Array(N_BINS * N_FRAMES) // [N_BINS × N_FRAMES]
  private readonly melRow = new Float64Array(N_FRAMES)

  /** `melFilters` is `mel_filters` from whisper's preprocessor_config.json: 80 rows of 201. */
  constructor(melFilters: number[][]) {
    if (melFilters.length !== N_MELS || melFilters.some((row) => row.length !== N_BINS)) {
      throw new Error(`mel filters must be ${N_MELS}×${N_BINS}`)
    }
    this.melFilters = new Float32Array(N_MELS * N_BINS)
    for (let m = 0; m < N_MELS; ++m) this.melFilters.set(melFilters[m], m * N_BINS)

    // Periodic Hann: the first N_FFT points of a symmetric window of N_FFT + 1.
    const factor = (2 * Math.PI) / N_FFT
    for (let i = 0; i < N_FFT; ++i) this.window[i] = 0.5 - 0.5 * Math.cos(i * factor)
  }

  /**
   * Features for the last 8 s of `audio`, prepared by smartTurnWaveform, as a
   * new [N_MELS × N_FRAMES] array. Only the returned array is allocated per
   * call; it is new each time so a caller may hand it to an inference still
   * running while the next call begins.
   */
  extract(audio: Float32Array): Float32Array {
    // Centre padding by reflection around the prepared 8 s waveform.
    const padded = this.padded
    const w = WINDOW_SAMPLES - 1
    smartTurnWaveform(audio, padded.subarray(PAD, PAD + WINDOW_SAMPLES))
    for (let i = 1; i <= PAD; ++i) {
      padded[PAD - i] = padded[PAD + i]
      padded[PAD + w + i] = padded[PAD + w - i]
    }

    const frame = this.frame
    const spectrum = this.spectrum
    const power = this.power
    for (let i = 0; i < N_FRAMES; ++i) {
      const offset = i * HOP
      for (let j = 0; j < N_FFT; ++j) frame[j] = padded[offset + j]
      for (let j = 0; j < N_FFT; ++j) frame[j] *= this.window[j]
      this.fft.realTransform(spectrum, frame, N_BINS)
      for (let j = 0; j < N_BINS; ++j) {
        const j2 = j << 1
        power[j * N_FRAMES + i] = spectrum[j2] ** 2 + spectrum[j2 + 1] ** 2
      }
    }

    // mel = melFilters @ power; the filters are mostly zeros.
    const out = new Float32Array(N_MELS * N_FRAMES)
    const row = this.melRow
    for (let m = 0; m < N_MELS; ++m) {
      row.fill(0)
      for (let j = 0; j < N_BINS; ++j) {
        const f = this.melFilters[m * N_BINS + j]
        if (f === 0) continue
        const base = j * N_FRAMES
        for (let i = 0; i < N_FRAMES; ++i) row[i] += f * power[base + i]
      }
      out.set(row, m * N_FRAMES)
    }

    let logMax = -Infinity
    for (let i = 0; i < out.length; ++i) {
      out[i] = Math.log10(Math.max(MEL_FLOOR, out[i]))
      if (out[i] > logMax) logMax = out[i]
    }
    const threshold = logMax - 8.0
    for (let i = 0; i < out.length; ++i) out[i] = (Math.max(out[i], threshold) + 4.0) / 4.0

    return out
  }
}
