export type { ChunkStrategy } from '@platform/shared'
import type { ChunkStrategy } from '@platform/shared'
import type { ModelPrefs, SettingsScope } from './model-settings'

export interface TtsVoice {
  id: string
  name: string
  [key: string]: unknown
}

export interface TtsModelChunking {
  mode?: ChunkStrategy | null
  minWords?: number | null
  maxWords?: number | null
}

export interface TtsModel {
  id: string
  name?: string
  voices: TtsVoice[]
  chunking?: TtsModelChunking | null
  /** Max concurrent TTS fetches for this model. Unset = unlimited. */
  concurrency?: number
  /** If true, model is eligible for the realtime voice loop. Non-realtime models remain available to async consumers and agents. */
  realtime?: boolean
  /** Extra fields passed verbatim into the TTS request body. Use for backend-specific tuning that's per-model rather than per-voice (e.g. streaming_interval for MLX-Audio Chatterbox to flush smaller frames). Voice-level params take precedence on key conflicts. */
  requestParams?: Record<string, unknown>
}

export interface TtsProvider {
  serviceId: string
  name?: string
  models: TtsModel[]
}

export interface SttOption {
  serviceId: string
  name: string
}

export interface VoiceSelection {
  serviceId: string
  model: string
  voice: string
  speed: number
  params?: Record<string, unknown>
}

export interface VoiceConfig {
  enabled?: boolean
  tts: {
    providers: TtsProvider[]
    selection?: VoiceSelection
    options?: {
      chunkStrategy?: ChunkStrategy | null
      minChunkWords?: number | null
      maxChunkWords?: number | null
    }
    modelPrefs?: ModelPrefs
    /** App-wide: whether per-model overrides are consulted at all. Absent = 'per-model'. */
    settingsScope?: SettingsScope
  }
  stt?: {
    serviceId?: string
    options?: SttOption[]
    /** Max duration (ms) to buffer mic audio before force-flushing to transcription. Default: 120000 (2 min). */
    maxRecordingMs?: number
    vad?: {
      /** Minimum duration (seconds) below which audio with low speech probability is discarded. Default: 0.75 */
      minSpeechDurationS?: number
      /** Minimum peak speech probability for short audio to pass noise rejection. Default: 0.7 */
      minSpeechProb?: number
    }
    turnTaking?: {
      pauseThresholdMs?: number
      commitMinDelayMs?: number
      commitMaxDelayMs?: number
      smartTurnThreshold?: number
      smartTurnLowCutoff?: number
      curve?:
        | { type: 'power'; exponent: number }
        | { type: 'sigmoid'; center: number; steepness: number }
      /** Minimum seconds of audio remaining to classify a barge-in as a playback interruption. Default: 0.3 */
      interruptionMinRemainingS?: number
    }
  }
  debug?: {
    saveMicSamples?: boolean
  }
}

const ENABLED_KEY = 'voice:enabled'

export async function fetchVoiceConfig(): Promise<VoiceConfig | null> {
  try {
    const res = await fetch('/api/voice')
    if (!res.ok) return null
    return res.json() as Promise<VoiceConfig>
  } catch {
    return null
  }
}

export function loadVoiceSelection(config: VoiceConfig): VoiceSelection | null {
  const sel = config.tts.selection
  if (!sel) return null
  const modelObj = config.tts.providers
    .find(p => p.serviceId === sel.serviceId)
    ?.models.find(m => m.id === sel.model)
  const voiceObj = modelObj?.voices.find(v => v.id === sel.voice)
  // Merge order: persisted sel.params → model.requestParams → voice fields.
  // Later writes win, so voice-level fields override model-level tuning.
  const params: Record<string, unknown> = { ...sel.params, ...(modelObj?.requestParams ?? {}) }
  if (voiceObj) {
    for (const [k, v] of Object.entries(voiceObj)) {
      if (k !== 'id' && k !== 'name') params[k] = v
    }
  }
  return { ...sel, speed: sel.speed ?? 1.0, params: Object.keys(params).length ? params : undefined }
}

export function loadSpeechEnabled(config?: VoiceConfig | null): boolean {
  const stored = localStorage.getItem(ENABLED_KEY)
  if (stored !== null) return stored === 'true'
  return config?.enabled ?? false
}

export function saveSpeechEnabled(enabled: boolean): void {
  localStorage.setItem(ENABLED_KEY, String(enabled))
}

