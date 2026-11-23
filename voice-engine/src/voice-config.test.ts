import { describe, it, expect } from 'vitest'
import { loadVoiceSelection, type VoiceConfig } from './voice-config'

// The engine takes the selection as GET /api/voice serves it. `selection.request`
// is the shard's resolution, which goes into the speech request unchanged; the
// engine looks up no key, recording or voice (docs/reference/design/model-roster.md,
// "Reaching a resolution"). Assumed: `tts.providers[].serves`, `selection.serviceId`,
// `selection.request`, `selection.requestError`, and `loadVoiceSelection(config)`
// returning a selection whose `request` is the served one, or null with no request.

const SERVED_REQUEST = {
  model: 'mlx-community/pocket-tts',
  ref_audio: '/refs/priya.wav',
  streaming_interval: 4,
}

// The lists carry nothing that could produce SERVED_REQUEST, so anything the
// engine put in it beyond what was served would have to have been looked up.
const config = (selection: Record<string, unknown>): VoiceConfig => ({
  tts: {
    models: [],
    voices: [],
    providers: [
      { serviceId: 'tts-mlx-audio', responseFormat: 'mp3', serves: [] },
      { serviceId: 'fluid-tts', responseFormat: 'aac', serves: [] },
    ],
    selection: selection as unknown as VoiceConfig['tts']['selection'],
  },
})

describe('loadVoiceSelection: the served selection in, a speech request out', () => {
  it('carries the served request exactly, and looks nothing up', () => {
    const sel = loadVoiceSelection(config({ voice: 'priya', model: 'pocket-tts', serviceId: 'tts-mlx-audio', speed: 1, request: SERVED_REQUEST }))
    expect(sel?.request).toEqual(SERVED_REQUEST)
    expect(sel?.voice).toBe('priya')
    expect(sel?.model).toBe('pocket-tts')
    expect(sel?.serviceId).toBe('tts-mlx-audio')
  })

  it("takes the selected runtime's audio format", () => {
    const base = { voice: 'priya', model: 'pocket-tts', speed: 1, request: SERVED_REQUEST }
    expect(loadVoiceSelection(config({ ...base, serviceId: 'tts-mlx-audio' }))?.responseFormat).toBe('mp3')
    expect(loadVoiceSelection(config({ ...base, serviceId: 'fluid-tts' }))?.responseFormat).toBe('aac')
  })

  it('has no request to send when the control plane served none, so there is nothing to speak with', () => {
    const sel = loadVoiceSelection(config({ voice: 'priya', model: 'pocket-tts', serviceId: 'fluid-tts', speed: 1, requestError: 'shard unreachable' }))
    expect(sel?.request).toBeUndefined()
  })
})
