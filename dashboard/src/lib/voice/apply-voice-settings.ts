import type { VoiceUpdateResult } from '@/lib/api'
import type { VoiceSelection } from './voice-config'
import { useVoiceSessionStore, setVoiceConfig, setVoiceSelection } from './voice-session-store'
import { voiceSystem } from './system'

/**
 * Brings the running session in line with voice settings just saved: merges
 * the PATCH result into the store and readies the services it now names.
 *
 * Without the merge, Save writes to disk but nothing in the running store
 * changes until a reload — the PATCH response is the only place the merged
 * chunking state (modelPrefs, global options) comes back. providers and
 * stt.options are kept from the local copy: the PATCH response is raw
 * config.voice, which lacks the enrichment GET /api/voice adds (service
 * names, STT option list).
 */
export function applySavedVoiceSettings(
  sel: VoiceSelection,
  newSttServiceId: string | undefined,
  updatedVoice: VoiceUpdateResult,
): void {
  const prev = useVoiceSessionStore.getState().voiceConfig
  setVoiceSelection(sel)
  setVoiceConfig(prev ? {
    ...prev,
    ...(updatedVoice.enabled !== undefined && { enabled: updatedVoice.enabled }),
    ...(updatedVoice.takeover && { takeover: updatedVoice.takeover }),
    tts: {
      ...prev.tts,
      ...(updatedVoice.tts?.selection && { selection: updatedVoice.tts.selection }),
      options: updatedVoice.tts?.options ?? prev.tts.options,
      modelPrefs: updatedVoice.tts?.modelPrefs ?? prev.tts.modelPrefs,
      settingsScope: updatedVoice.tts?.settingsScope ?? prev.tts.settingsScope,
    },
    stt: {
      ...prev.stt,
      ...(updatedVoice.stt?.serviceId && { serviceId: updatedVoice.stt.serviceId }),
      ...(updatedVoice.stt?.vad && { vad: updatedVoice.stt.vad }),
      ...(updatedVoice.stt?.turnTaking && { turnTaking: updatedVoice.stt.turnTaking }),
    },
    debug: updatedVoice.debug ?? prev.debug,
  } : prev)

  voiceSystem.reconfigure(sel, newSttServiceId ?? prev?.stt?.serviceId)
}
