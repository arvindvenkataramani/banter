import * as ort from 'onnxruntime-web'
import './ort-init'

export interface VadResult {
  speechProbability: number
  isSpeech: boolean
}

const DEFAULT_MODEL_URL = '/models/silero_vad_legacy.onnx'
const FRAME_SIZE = 512
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
  private sampleBuffer: Float32Array = new Float32Array(0)
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

  async process(chunk16k: Float32Array): Promise<VadResult | null> {
    if (!this.session) return null

    try {
      const merged = new Float32Array(this.sampleBuffer.length + chunk16k.length)
      merged.set(this.sampleBuffer, 0)
      merged.set(chunk16k, this.sampleBuffer.length)
      this.sampleBuffer = merged

      let latestResult: VadResult | null = null

      while (this.sampleBuffer.length >= FRAME_SIZE) {
        const window512 = this.sampleBuffer.slice(0, FRAME_SIZE)
        this.sampleBuffer = this.sampleBuffer.slice(FRAME_SIZE)

        const input = new ort.Tensor('float32', window512, [1, FRAME_SIZE])
        const feeds = { input, h: this.h, c: this.c, sr: this.sr }
        const results = await this.session.run(feeds)

        const prob = (results.output.data as Float32Array)[0]
        this.h = results.hn
        this.c = results.cn

        latestResult = {
          speechProbability: prob,
          isSpeech: prob >= this.speechThreshold,
        }
      }

      return latestResult
    } catch (err) {
      console.error('VAD process error:', err)
      return null
    }
  }

  reset(): void {
    const s = zeroState()
    this.h = s.h
    this.c = s.c
    this.sampleBuffer = new Float32Array(0)
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
