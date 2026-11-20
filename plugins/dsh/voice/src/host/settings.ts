// The plugin's own settings (what belongs to dsh, not to Banter), and the two
// readings of the control plane's voice config the plugin makes.

import type { VoiceConfig } from '@platform/voice-engine/voice-config'

/** The plugin's config entry. The voice settings themselves are Banter's, read from the control plane. */
export interface PluginSettings {
  controlPlaneUrl: string
  keepVoiceOutside: boolean
}

export const DEFAULT_SETTINGS: PluginSettings = {
  controlPlaneUrl: '',
  keepVoiceOutside: false,
}

/** The control plane's voice config as the engine receives it here: without `debug`, because the engine would post microphone samples to dsh's origin, and nothing there accepts them. */
export function engineConfig(cfg: VoiceConfig): VoiceConfig {
  const { debug: _debug, ...rest } = cfg
  return rest
}

/** The STT and TTS services the config selects, `''` where none is set. */
export function selectedServices(cfg: VoiceConfig): { sttServiceId: string; ttsServiceId: string } {
  return { sttServiceId: cfg.stt?.serviceId ?? '', ttsServiceId: cfg.tts?.selection?.serviceId ?? '' }
}
