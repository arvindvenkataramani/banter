export type { ChunkStrategy } from '@platform/shared'
import type { ChunkStrategy } from '@platform/shared'
import type { ModelPrefs, SettingsScope } from './model-settings'

/** A voice as voice mode offers it. `id` is what a selection stores; `key` is
 *  what the TTS runtime is sent. Other fields go into the request verbatim. */
export interface TtsVoice {
  id: string
  name: string
  key: string
  /** The recording a cloning model renders her from. */
  ref_audio?: string
  [field: string]: unknown
}

export interface TtsModelChunking {
  mode?: ChunkStrategy | null
  minWords?: number | null
  maxWords?: number | null
}

/** A model from the shard roster. `id` is its roster id, which selections and
 *  modelPrefs store; `key` is what its runtime calls it. */
export interface TtsModel {
  id: string
  name?: string
  key: string
  voices: TtsVoice[]
  chunking?: TtsModelChunking | null
  /** Max concurrent TTS fetches for this model. Unset = unlimited. */
  concurrency?: number
  /** If true, model is eligible for the realtime voice loop. Non-realtime models remain available to async consumers and agents. */
  realtime?: boolean
  /** The provider streams this model's audio as it synthesises. */
  streaming?: boolean
  /** Extra fields passed verbatim into the TTS request body. Use for backend-specific tuning that's per-model rather than per-voice (e.g. streaming_interval for MLX-Audio Chatterbox to flush smaller frames). Voice-level params take precedence on key conflicts. */
  requestParams?: Record<string, unknown>
}

/** What a TTS runtime returns from /v1/audio/speech. */
export type AudioFormat = 'mp3' | 'aac' | 'wav'

export interface TtsProvider {
  serviceId: string
  name?: string
  /** Which node declares this provider. */
  hostId?: string
  /** An unreachable node's provider is still listed, with its last known
   *  roster. */
  reachable?: boolean
  /** The runtime's own format: speech is requested and decoded as this. */
  responseFormat: AudioFormat
  models: TtsModel[]
  /** Whether this runtime's streaming socket understands session ids and
   *  take-over, the way it carries responseFormat. Absent means no. */
  sessions?: boolean
}

export interface SttOption {
  serviceId: string
  name: string
  /** Whether this service's streaming socket understands session ids and
   *  take-over. False when the roster provider does not declare it. */
  sessions?: boolean
}

/** What config.json stores: roster ids. */
export interface StoredVoiceSelection {
  serviceId: string
  model: string
  voice: string
  speed: number
  params?: Record<string, unknown>
}

/** A stored selection resolved against the roster: what the TTS runtime is
 *  sent for the model and voice, and the request params they carry. */
export interface VoiceSelection extends StoredVoiceSelection {
  modelKey: string
  voiceKey: string
  /** The selected runtime's format. */
  responseFormat: AudioFormat
}

export interface VoiceConfig {
  enabled?: boolean
  /**
   * What a voice session does when a voice server it wants — TTS or STT — is
   * held by another session. `ask` (default) shows a dialog offering to take
   * it over. `always` takes over without asking, on every connection the
   * session makes.
   */
  takeover?: 'ask' | 'always'
  tts: {
    /** Built from the shard roster; empty when it cannot be read. */
    providers: TtsProvider[]
    selection?: StoredVoiceSelection
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
    /** Which model the STT service loads for a voice session. The server starts
     * holding nothing, so this is what a session loads before its first
     * utterance. A batch model: the streaming ones transcribe less accurately
     * and are opted into, not defaulted to. */
    model?: string
    /**
     * Take the streaming side of a model that offers both.
     *
     * Only models reporting `kind: both` consult this — one that does a single
     * thing is not a choice. Stated once rather than per model, because it is
     * a standing preference about how this loop should feel: streaming makes
     * the wait legible at some cost in accuracy, and that trade does not vary
     * from model to model.
     */
    preferStreaming?: boolean
    /**
     * Which streaming latency tier to load, for a model that offers a choice.
     *
     * A tier is a parameter over one set of weights, not a separate model, so
     * it is named here rather than folded into the id. Absent, the server
     * picks its own default.
     */
    chunkMs?: number
    /**
     * What a voice session does when its streaming socket drops. The first
     * attempt goes at once; each one after waits `delayMs` longer than the
     * last. A socket that stays up for `stableMs` resets the count; one that
     * drops sooner counts as a failure, so a fault that recurs after the
     * server accepts the session still ends voice. Voice ends once
     * `attempts` connections in a row have failed.
     */
    reconnect?: {
      attempts?: number
      delayMs?: number
      stableMs?: number
    }
    options?: SttOption[]
    /** Max duration (ms) to buffer mic audio before force-flushing to transcription. Default: 120000 (2 min). */
    maxRecordingMs?: number
    /** How long voice-off waits for an outstanding transcription to settle before closing the transport regardless. Default: 1500. */
    settleOnStopMs?: number
    /** How long a paused utterance keeps streaming silence in the microphone's place, so the model transcribes the words it already holds. Default: 1500. */
    pauseFlushMs?: number
    /** Pacing bounds for the streaming partial's word-by-word reveal. */
    reveal?: {
      /** Fastest interval between revealed words, in ms. Default: 55. */
      minIntervalMs?: number
      /** Slowest interval between revealed words, in ms. Default: 200. */
      maxIntervalMs?: number
    }
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

export async function fetchVoiceConfig(): Promise<VoiceConfig | null> {
  try {
    const res = await fetch('/api/voice')
    if (!res.ok) return null
    return res.json() as Promise<VoiceConfig>
  } catch {
    return null
  }
}

/** Resolve roster ids to what the TTS runtime is sent. An id the roster no
 *  longer offers is sent as itself, so the server names what it refused. */
export function resolveVoiceSelection(config: VoiceConfig, sel: StoredVoiceSelection): VoiceSelection {
  const provider = config.tts.providers.find(p => p.serviceId === sel.serviceId)
  const modelObj = provider?.models.find(m => m.id === sel.model)
  const voiceObj = modelObj?.voices.find(v => v.id === sel.voice)
  // Merge order: persisted sel.params → model.requestParams → voice fields.
  // Later writes win, so voice-level fields override model-level tuning.
  const params: Record<string, unknown> = { ...sel.params, ...(modelObj?.requestParams ?? {}) }
  if (voiceObj) {
    for (const [k, v] of Object.entries(voiceObj)) {
      if (k !== 'id' && k !== 'name' && k !== 'key') params[k] = v
    }
  }
  return {
    ...sel,
    speed: sel.speed ?? 1.0,
    params: Object.keys(params).length ? params : undefined,
    modelKey: modelObj?.key ?? sel.model,
    voiceKey: voiceObj?.key ?? sel.voice,
    responseFormat: provider?.responseFormat ?? 'mp3',
  }
}

export function loadVoiceSelection(config: VoiceConfig): VoiceSelection | null {
  const sel = config.tts.selection
  return sel ? resolveVoiceSelection(config, sel) : null
}

