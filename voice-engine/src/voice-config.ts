export type { ChunkStrategy } from '@platform/shared'
import type { ChunkStrategy } from '@platform/shared'
import type { AudioFormat as SpeechFormat, ModelLoading, Provision, Resolution } from '@platform/shared/apis/types'
import type { ModelPref, ModelPrefs, SettingsScope } from './model-settings'

export type VoiceSelectionPatch = {
  serviceId?: string
  model?: string
  voice?: string
  speed?: number
  chunkStrategy?: string | null
  minChunkWords?: number | null
  maxChunkWords?: number | null
  modelPrefs?: Record<string, Record<string, ModelPref | null>>
  settingsScope?: SettingsScope
  sttServiceId?: string
  preferStreaming?: boolean
  saveMicSamples?: boolean
  takeover?: 'ask' | 'always'
  /** null removes a field, so the engine's default applies. */
  vad?: Partial<Record<'minSpeechDurationS' | 'minSpeechProb', number | null>>
  /** null removes a field, so the engine's default applies. */
  turnTaking?: Partial<Record<'pauseThresholdMs' | 'commitMinDelayMs' | 'commitMaxDelayMs' | 'smartTurnThreshold' | 'smartTurnLowCutoff', number | null>>
}

/** What `PATCH /api/voice/selection` returns — `config.voice` verbatim, so
 * every part is optional and it lacks the enrichment `GET /api/voice` adds
 * (provider service names, the STT options list). Callers must merge this
 * onto their existing config rather than replace it wholesale. */
export type VoiceUpdateResult = {
  enabled?: boolean
  takeover?: VoiceConfig['takeover']
  tts?: Partial<VoiceConfig['tts']>
  stt?: VoiceConfig['stt']
  debug?: VoiceConfig['debug']
}

export interface TtsModelChunking {
  mode?: ChunkStrategy | null
  minWords?: number | null
  maxWords?: number | null
}

/** A synthesis model. `id` is its roster id, which selections and modelPrefs store. */
export interface TtsModel {
  id: string
  name: string
  canClone: boolean
  chunking?: TtsModelChunking | null
}

/** A voice, and the models that produce her. Offered on a model when she has a rendering on it. */
export interface TtsVoice {
  id: string
  name: string
  renderings: { model: string; method: 'preset' | 'clone' }[]
}

/** One model a runtime serves. */
export interface TtsServing {
  model: string
  /** What the runtime calls the model. */
  key?: string
  /** The runtime streams this model's audio as it synthesises. */
  streaming?: boolean
  /** Eligible for the realtime voice loop. Other models stay available to async consumers and agents. */
  realtime?: boolean
  /** Max concurrent TTS fetches for this model on this runtime. Unset = unlimited. */
  concurrency?: number
  requestParams?: Record<string, unknown>
}

/** An audio format the playback engine decodes. */
export type AudioFormat = SpeechFormat

export interface TtsProvider {
  serviceId: string
  name?: string
  /** Which node declares this provider. */
  hostId?: string
  /** An unreachable node's provider is still listed, with its last known
   *  roster. */
  reachable?: boolean
  resolvesVoices?: boolean
  serves: TtsServing[]
  /** The APIs the runtime's service serves, and how it departs from each. */
  provides?: Provision[]
  /** How the service's models load. */
  models?: ModelLoading
}

export interface SttOption {
  serviceId: string
  name: string
  provides?: Provision[]
  models?: ModelLoading
  /** What the service serves, by roster id and by the name it knows each by. */
  serves?: { model: string; key: string }[]
}

/** A speech-to-text model, as the roster declares it. */
export interface SttModelEntry {
  id: string
  name?: string
  kind: 'batch' | 'streaming' | 'both'
  /** The parameters of the model, such as the `chunkMs` tiers it offers. */
  params?: { name: string; values: number[] }[]
  variants?: { id: string; params: { name: string; value: number }[] }[]
}

/** What config.json stores (roster ids), as `GET /api/voice` serves it. */
export interface StoredVoiceSelection {
  serviceId: string
  model: string
  voice: string
  speed: number
  /** The shard's resolution of the selection, which the speech adapter encodes as it came. */
  resolution?: Resolution
  /** Why `resolution` is absent. */
  resolutionError?: string
  /** Why the stored selection fails the selection check: its service declares no API that can synthesize. Absent while it passes. */
  selectionError?: string
}

/** The selection as the engine speaks it: the served selection, carried as served. */
export type VoiceSelection = StoredVoiceSelection

export interface VoiceConfig {
  enabled?: boolean
  /** Bring a model up when voice starts, where the service offers that choice. Absent means on. */
  preload?: boolean
  /**
   * What a voice session does when a voice server it wants — TTS or STT — is
   * held by another session. `ask` (default) shows a dialog offering to take
   * it over. `always` takes over without asking, on every connection the
   * session makes.
   */
  takeover?: 'ask' | 'always'
  tts: {
    /** The assembled roster, as declared: empty when it cannot be read. */
    models: TtsModel[]
    providers: TtsProvider[]
    voices: TtsVoice[]
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
    /** Why the stored STT selection fails the selection check: its service declares no API for what the selected model needs. Absent while it passes. */
    selectionError?: string
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
    /** The audio formats the browser may send, most preferred first. Absent means Opus then 16-bit PCM. */
    encodings?: ('opus' | 'pcm16')[]
    /** The roster's speech-to-text models, with their kind, parameters and variants. */
    models?: SttModelEntry[]
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
    /** Max duration (ms) to buffer mic audio before force-flushing to transcription. Default: 300000 (5 min). */
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

/** The served selection. Its `resolution` is the shard's, carried as served; nothing is looked up here. */
export function loadVoiceSelection(config: VoiceConfig): VoiceSelection | null {
  const sel = config.tts.selection
  if (!sel) return null
  return { ...sel, speed: sel.speed ?? 1.0 }
}

