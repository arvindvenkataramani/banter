// The plugin's settings (what the bundle card edits, plus the rest of the
// control plane's voice config kept as seeded) and their mapping to and from
// the engine's VoiceConfig.

import type { VoiceConfig } from '@platform/voice-engine/voice-config'

/** The values dsh's bundle config card edits, and the rest of the voice config as one JSON string. */
export interface PluginSettings {
  controlPlaneUrl: string
  sttServiceId: string
  sttModel: string
  ttsServiceId: string
  ttsModel: string
  ttsVoice: string
  ttsSpeed: number
  inputDevice: string
  keepVoiceOutside: boolean
  /** JSON of every VoiceConfig field the card does not edit: rosters, turn-taking, reveal, chunking. */
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
  inputDevice: '',
  keepVoiceOutside: false,
  rest: '{}',
}

/** Splits a control-plane voice config into the card's fields and the stored remainder. */
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
 * Rebuilds the engine's VoiceConfig from the stored remainder and the card's current fields.
 * `_relayBase` is part of the spec's signature; VoiceConfig has no endpoint field for it to set.
 */
export function voiceConfigFromSettings(settings: PluginSettings, _relayBase?: string): VoiceConfig {
  const rest = parseRest(settings.rest)
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
