import { loadOrt, type Ort } from './ort-init'
import { N_FRAMES, N_MELS, WhisperFeatures } from './whisper-features'

const DEFAULT_MODEL_URL = '/models/smart-turn-v3.2-cpu.onnx'
const PREPROCESSOR_CONFIG_URL = '/models/whisper-tiny/preprocessor_config.json'

export class SmartTurn {
  private ort: typeof Ort | null = null
  private session: Ort.InferenceSession | null = null
  private features: WhisperFeatures | null = null

  async load(modelUrl?: string): Promise<void> {
    const url = modelUrl ?? DEFAULT_MODEL_URL

    const ort = await loadOrt()
    this.ort = ort
    this.session = await ort.InferenceSession.create(url, { executionProviders: ['wasm'] })
    const res = await fetch(PREPROCESSOR_CONFIG_URL)
    if (!res.ok) throw new Error(`${PREPROCESSOR_CONFIG_URL}: ${res.status}`)
    const config = (await res.json()) as { mel_filters: number[][] }
    this.features = new WhisperFeatures(config.mel_filters)
  }

  /** Judges the last 8 s of `audio`. */
  async predict(audio: Float32Array): Promise<number> {
    if (!this.ort || !this.session || !this.features) return 0

    const input = new this.ort.Tensor('float32', this.features.extract(audio), [1, N_MELS, N_FRAMES])
    const outputs = await this.session.run({ input_features: input })
    return (outputs.logits.data as Float32Array)[0]
  }

  destroy(): void {
    if (this.session) {
      // release() exists at runtime but isn't in the InferenceSession typings.
      const session = this.session as Ort.InferenceSession & { release?: () => void }
      if (typeof session.release === 'function') {
        session.release()
      }
      this.session = null
    }
    this.features = null
  }
}
