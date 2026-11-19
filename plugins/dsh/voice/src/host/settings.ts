// The plugin's settings (the typed fields the settings page edits, plus the
// rest of the control plane's voice config as one JSON string) and their
// mapping to and from the engine's VoiceConfig.

import type { VoiceConfig } from '@platform/voice-engine/voice-config'

/** The typed values of the plugin's config entry, and the rest of the voice config as one JSON string. */
export interface PluginSettings {
  controlPlaneUrl: string
  sttServiceId: string
  sttModel: string
  ttsServiceId: string
  ttsModel: string
  ttsVoice: string
  ttsSpeed: number
  keepVoiceOutside: boolean
  /** JSON of every VoiceConfig field with no typed field: rosters, chunking options and preferences, scope, take-over, vad and turn-taking tuning, reveal, debug. */
  rest: string
}

export const DEFAULT_SETTINGS: PluginSettings = {
  controlPlaneUrl: '',
  sttServiceId: '',
  sttModel: '',
  ttsServiceId: '',
  ttsModel: '',
  ttsVoice: '',
  ttsSpeed: 1,
  keepVoiceOutside: false,
  rest: '{}',
}

/** Splits a control-plane voice config into the typed fields and the stored remainder. */
export function settingsFromVoiceConfig(cfg: VoiceConfig, controlPlaneUrl: string): PluginSettings {
  const selection = cfg.tts.selection
  const rest: VoiceConfig = {
    ...cfg,
    tts: { ...cfg.tts, selection: undefined },
    stt: { ...cfg.stt, serviceId: undefined, model: undefined },
  }
  return {
    ...DEFAULT_SETTINGS,
    controlPlaneUrl,
    sttServiceId: cfg.stt?.serviceId ?? '',
    sttModel: cfg.stt?.model ?? '',
    ttsServiceId: selection?.serviceId ?? '',
    ttsModel: selection?.model ?? '',
    ttsVoice: selection?.voice ?? '',
    ttsSpeed: selection?.speed ?? 1,
    rest: JSON.stringify(rest),
  }
}

/**
 * Rebuilds the engine's VoiceConfig from the stored remainder and the typed fields.
 * VoiceConfig has no endpoint field: the engine reaches a service through the endpoint `ensureServiceReady` returns.
 */
export function voiceConfigFromSettings(settings: PluginSettings): VoiceConfig {
  const rest = parseRest(settings.rest)
  // The engine posts microphone samples to dsh's own origin when this is set, and nothing there accepts them.
  delete rest.debug
  return {
    ...rest,
    tts: {
      ...rest.tts,
      providers: rest.tts?.providers ?? [],
      selection: {
        serviceId: settings.ttsServiceId,
        model: settings.ttsModel,
        voice: settings.ttsVoice,
        speed: settings.ttsSpeed,
      },
    },
    stt: { ...rest.stt, serviceId: settings.sttServiceId, model: settings.sttModel },
  }
}

function parseRest(json: string): Partial<VoiceConfig> {
  try {
    const parsed: unknown = JSON.parse(json)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Partial<VoiceConfig>) : {}
  } catch {
    return {}
  }
}
