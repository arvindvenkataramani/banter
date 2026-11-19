import { describe, it, expect } from 'vitest'
import { resolveVoiceSelection, type VoiceConfig } from './voice-config'

const CONFIG: VoiceConfig = {
  tts: {
    providers: [
      {
        serviceId: 'tts-mlx-audio',
        responseFormat: 'mp3',
        models: [
          {
            id: 'kokoro-82m',
            key: 'prince-canuma/Kokoro-82M',
            voices: [{ id: 'priya', name: 'Priya', key: 'bf_priya' }],
          },
          {
            id: 'pocket-tts-mlx',
            key: 'mlx-community/pocket-tts',
            requestParams: { streaming_interval: 0.5 },
            voices: [{ id: 'priya', name: 'Priya', key: 'priya', ref_audio: '/refs/priya.wav' }],
          },
        ],
      },
      {
        serviceId: 'fluid-tts',
        responseFormat: 'aac',
        models: [{ id: 'pocket-tts', key: 'pocket-tts', voices: [] }],
      },
    ],
  },
}

describe('resolveVoiceSelection: roster ids in, runtime keys out', () => {
  it('sends the model and voice by their runtime keys', () => {
    const sel = resolveVoiceSelection(CONFIG, { serviceId: 'tts-mlx-audio', model: 'kokoro-82m', voice: 'priya', speed: 1 })
    expect(sel.modelKey).toBe('prince-canuma/Kokoro-82M')
    expect(sel.voiceKey).toBe('bf_priya')
    expect(sel.model).toBe('kokoro-82m')
    expect(sel.params).toBeUndefined()
  })

  it("carries the model's request params and a cloned voice's recording, never her key", () => {
    const sel = resolveVoiceSelection(CONFIG, { serviceId: 'tts-mlx-audio', model: 'pocket-tts-mlx', voice: 'priya', speed: 1 })
    expect(sel.params).toEqual({ streaming_interval: 0.5, ref_audio: '/refs/priya.wav' })
  })

  it("takes the selected runtime's audio format", () => {
    expect(resolveVoiceSelection(CONFIG, { serviceId: 'tts-mlx-audio', model: 'kokoro-82m', voice: 'priya', speed: 1 }).responseFormat).toBe('mp3')
    expect(resolveVoiceSelection(CONFIG, { serviceId: 'fluid-tts', model: 'pocket-tts', voice: 'priya', speed: 1 }).responseFormat).toBe('aac')
  })

  it('sends an id the roster no longer offers as itself', () => {
    const sel = resolveVoiceSelection(CONFIG, { serviceId: 'tts-mlx-audio', model: 'gone', voice: 'nobody', speed: 1 })
    expect(sel.modelKey).toBe('gone')
    expect(sel.voiceKey).toBe('nobody')
  })
})
