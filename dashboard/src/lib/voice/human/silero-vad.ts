import * as ort from 'onnxruntime-web'
import './ort-init'

export interface VadResult {
  speechProbability: number
  isSpeech: boolean
  /** Samples this verdict covers — the model's fixed input width, not the
   * caller's chunk size. A duration computed from a verdict count multiplies
   * by this, never by an assumed size. */
  samples: number
}

const DEFAULT_MODEL_URL = '/models/silero_vad_legacy.onnx'
// The ONNX model's fixed input width. Unrelated to the capture worklet's
// frame size — process() below buffers whatever it is handed into windows
// of this width, however large or small the caller's chunks are.
const MODEL_WINDOW_SAMPLES = 512
const DEFAULT_SPEECH_THRESHOLD = 0.5

function zeroState(): { h: ort.Tensor; c: ort.Tensor } {
  return {
    h: new ort.Tensor('float32', new Float32Array(2 * 1 * 64), [2, 1, 64]),
    c: new ort.Tensor('float32', new Float32Array(2 * 1 * 64), [2, 1, 64]),
  }
}

export class SileroVad {
  private session: ort.InferenceSession | null = null
  private h: ort.Tensor
  private c: ort.Tensor
  private sr: ort.Tensor = new ort.Tensor('int64', [16000n])
  // One model window, filled across calls and handed to every run through the
  // same tensor. Safe to reuse because runs are sequential: the caller awaits
  // each process() before the next.
  private window = new Float32Array(MODEL_WINDOW_SAMPLES)
  private windowFill = 0
  private input = new ort.Tensor('float32', this.window, [1, MODEL_WINDOW_SAMPLES])
  // Bumped by reset(), so a run in flight across a reset keeps neither its
  // verdict nor its state.
  private generation = 0
  private speechThreshold = DEFAULT_SPEECH_THRESHOLD

  constructor() {
    const s = zeroState()
    this.h = s.h
    this.c = s.c
  }

  async load(modelUrl?: string): Promise<void> {
    const url = modelUrl ?? DEFAULT_MODEL_URL
    this.session = await ort.InferenceSession.create(url, {
      executionProviders: ['wasm'],
    })
    const s = zeroState()
    this.h = s.h
    this.c = s.c
  }

  /** True once the ONNX session is loaded — chunks before this should be dropped. */
  isReady(): boolean {
    return this.session !== null
  }

  setSpeechThreshold(threshold: number): void {
    this.speechThreshold = threshold
  }

  /**
   * Buffers the given samples onto whatever is left from the last call and
   * runs the model once per full model-window it can fill, returning every
   * window's verdict in order. A caller whose chunk spans several windows
   * gets several verdicts back rather than only the last — discarding all
   * but the latest would throw away onset and silence that fell in an
   * earlier window of the same chunk.
   */
  async process(chunk16k: Float32Array): Promise<VadResult[]> {
    if (!this.session) return []

    const generation = this.generation
    try {
      const results: VadResult[] = []
      let offset = 0

      while (offset < chunk16k.length) {
        const take = Math.min(MODEL_WINDOW_SAMPLES - this.windowFill, chunk16k.length - offset)
        this.window.set(chunk16k.subarray(offset, offset + take), this.windowFill)
        this.windowFill += take
        offset += take
        if (this.windowFill < MODEL_WINDOW_SAMPLES) break
        this.windowFill = 0

        const feeds = { input: this.input, h: this.h, c: this.c, sr: this.sr }
        const output = await this.session.run(feeds)
        if (generation !== this.generation) return results

        const prob = (output.output.data as Float32Array)[0]
        this.h = output.hn
        this.c = output.cn

        results.push({
          speechProbability: prob,
          isSpeech: prob >= this.speechThreshold,
          samples: MODEL_WINDOW_SAMPLES,
        })
      }

      return results
    } catch (err) {
      console.error('VAD process error:', err)
      return []
    }
  }

  reset(): void {
    const s = zeroState()
    this.h = s.h
    this.c = s.c
    this.windowFill = 0
    this.generation++
  }

  destroy(): void {
    if (this.session) {
      // release() exists at runtime but isn't in the InferenceSession typings.
      const session = this.session as ort.InferenceSession & { release?: () => void }
      if (typeof session.release === 'function') {
        session.release()
      }
      this.session = null
    }
  }
}
