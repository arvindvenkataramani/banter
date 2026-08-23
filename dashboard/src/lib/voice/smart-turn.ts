import * as ort from 'onnxruntime-web/experimental'
import { AutoFeatureExtractor, env } from '@huggingface/transformers'
import './ort-init'

const DEFAULT_MODEL_URL = '/models/smart-turn-v3.2-cpu.onnx'
const SAMPLE_RATE = 16000
const MAX_AUDIO_SECONDS = 8
const MAX_SAMPLES = MAX_AUDIO_SECONDS * SAMPLE_RATE // 128000

/** The extractor is callable at runtime, but its typings don't say so. */
type ExtractFeatures = (
  audio: Float32Array,
  opts: { max_length: number },
) => Promise<{ input_features: { data: Float32Array; dims: number[] } }>

export class SmartTurn {
  private session: ort.InferenceSession | null = null
  private featureExtractor: Awaited<ReturnType<typeof AutoFeatureExtractor.from_pretrained>> | null = null

  async load(modelUrl?: string): Promise<void> {
    env.allowLocalModels = true
    const url = modelUrl ?? DEFAULT_MODEL_URL

    this.session = await ort.InferenceSession.create(url, { executionProviders: ['wasm'] })
    this.featureExtractor = await AutoFeatureExtractor.from_pretrained('/models/whisper-tiny')
  }

  async predict(audio: Float32Array): Promise<number> {
    if (!this.session || !this.featureExtractor) return 0

    // Take last MAX_SAMPLES (8 seconds) if longer
    const window = audio.length > MAX_SAMPLES
      ? audio.slice(audio.length - MAX_SAMPLES)
      : audio

    // Extract Whisper mel spectrogram — pass max_length to pad/truncate to exactly 8s
    const extract = this.featureExtractor as unknown as ExtractFeatures
    const inputs = await extract(window, { max_length: MAX_SAMPLES })

    // input_features is a transformers.js Tensor with shape [1, 80, 800]
    const features = inputs.input_features
    const tensor = new ort.Tensor('float32', features.data as Float32Array, features.dims as number[])

    const outputs = await this.session.run({ input_features: tensor })
    return (outputs.logits.data as Float32Array)[0]
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
    this.featureExtractor = null
  }
}
