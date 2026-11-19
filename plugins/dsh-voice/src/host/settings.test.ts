import { describe, expect, it } from 'vitest'
import type { VoiceConfig } from '@platform/voice-engine/voice-config'
import { settingsFromVoiceConfig, voiceConfigFromSettings } from './settings'

// A control-plane /api/voice response, generic values only.
const controlPlaneConfig: VoiceConfig = {
  enabled: true,
  takeover: 'ask',
  tts: {
    providers: [
      {
        serviceId: 'tts-b',
        responseFormat: 'mp3',
        models: [{ id: 'model-1', key: 'model-1-key', voices: [{ id: 'voice-1', name: 'One', key: 'voice-1-key' }] }],
      },
    ],
    selection: { serviceId: 'tts-b', model: 'model-1', voice: 'voice-1', speed: 1.1 },
    options: { chunkStrategy: null, minChunkWords: 3, maxChunkWords: 40 },
  },
  stt: {
    serviceId: 'stt-a',
    model: 'stt-model-1',
    reveal: { minIntervalMs: 60, maxIntervalMs: 180 },
    turnTaking: { pauseThresholdMs: 700, commitMinDelayMs: 200 },
  },
}

// INVENTED: the PluginSettings field names asserted below (controlPlaneUrl, sttServiceId, sttModel, ttsServiceId, ttsModel, ttsVoice, ttsSpeed, keepVoiceOutside) are the host Config's (decisions.md 9); spec section 8 names the fields in prose only.
describe('install seeding', () => {
  it('a /api/voice response becomes the plugin settings: service ids, models, voice, speed, control-plane URL, keep-voice-outside off', () => {
    const settings = settingsFromVoiceConfig(controlPlaneConfig, 'http://control.invalid:7000')
    expect(settings).toMatchObject({
      controlPlaneUrl: 'http://control.invalid:7000',
      sttServiceId: 'stt-a',
      sttModel: 'stt-model-1',
      ttsServiceId: 'tts-b',
      ttsModel: 'model-1',
      ttsVoice: 'voice-1',
      ttsSpeed: 1.1,
      keepVoiceOutside: false,
    })
  })

  it('the seeded settings give back the control plane config, including the fields the card does not edit', () => {
    const settings = settingsFromVoiceConfig(controlPlaneConfig, 'http://control.invalid:7000')
    expect(voiceConfigFromSettings(settings)).toEqual(controlPlaneConfig)
  })

  it('a card edit changes the engine config it feeds and leaves the seeded remainder as it was', () => {
    const seeded = settingsFromVoiceConfig(controlPlaneConfig, 'http://control.invalid:7000')
    const edited = voiceConfigFromSettings({ ...seeded, ttsVoice: 'voice-2', ttsSpeed: 1.25, sttModel: 'stt-model-2' })
    expect(edited.tts.selection).toMatchObject({ serviceId: 'tts-b', model: 'model-1', voice: 'voice-2', speed: 1.25 })
    expect(edited.stt?.model).toBe('stt-model-2')
    expect(edited.stt?.turnTaking).toEqual(controlPlaneConfig.stt?.turnTaking)
    expect(edited.stt?.reveal).toEqual(controlPlaneConfig.stt?.reveal)
    expect(edited.tts.providers).toEqual(controlPlaneConfig.tts.providers)
    expect(edited.takeover).toBe('ask')
  })
})
