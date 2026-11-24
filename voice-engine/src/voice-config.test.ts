import { describe, it, expect } from 'vitest'
import { loadVoiceSelection, type VoiceConfig } from './voice-config'

// The engine takes the selection as GET /api/voice serves it (dev/specs/service-apis.md,
// section 11). `selection.resolution` is the shard's resolution, which the speech
// adapter encodes unchanged; the engine looks up no key, recording or voice
// (docs/reference/design/model-roster.md, "Reaching a resolution"). Assumed:
// `tts.selection.resolution`, `tts.selection.resolutionError` and
// `loadVoiceSelection(config)` returning a selection whose `resolution` is the served one.

const SERVED_RESOLUTION = {
  model: 'mlx-community/pocket-tts',
  voice: { recording: '/refs/priya.wav', transcript: 'spoken words' },
  params: { streaming_interval: 4 },
}

// The lists carry nothing that could produce SERVED_RESOLUTION, so anything the
// engine put in it beyond what was served would have to have been looked up.
const config = (selection: Record<string, unknown>): VoiceConfig => ({
  tts: {
    models: [],
    voices: [],
    providers: [
      { serviceId: 'tts-mlx-audio', provides: [{ api: 'openai.audio.speech' }], serves: [] },
      { serviceId: 'fluid-tts', provides: [{ api: 'openai.audio.speech' }], serves: [] },
    ],
    selection: selection as unknown as VoiceConfig['tts']['selection'],
  },
}) as unknown as VoiceConfig

describe('loadVoiceSelection: the served selection in, a resolution out', () => {
  it('[T2] carries the served resolution exactly, and looks nothing up', () => {
    const sel = loadVoiceSelection(config({ voice: 'priya', model: 'pocket-tts', serviceId: 'tts-mlx-audio', speed: 1, resolution: SERVED_RESOLUTION }))
    expect(sel?.resolution).toEqual(SERVED_RESOLUTION)
    expect(sel?.voice).toBe('priya')
    expect(sel?.model).toBe('pocket-tts')
    expect(sel?.serviceId).toBe('tts-mlx-audio')
  })

  it('[T2] carries no audio format of its own: the speech adapter chooses it from the provision', () => {
    const sel = loadVoiceSelection(config({ voice: 'priya', model: 'pocket-tts', serviceId: 'fluid-tts', speed: 1, resolution: SERVED_RESOLUTION }))
    expect(sel).not.toHaveProperty('responseFormat')
  })

  it('[T2] has no resolution when the control plane served none, so there is nothing to speak with', () => {
    const sel = loadVoiceSelection(config({ voice: 'priya', model: 'pocket-tts', serviceId: 'fluid-tts', speed: 1, resolutionError: 'shard unreachable' }))
    expect(sel?.resolution).toBeUndefined()
    expect(sel?.resolutionError).toBe('shard unreachable')
  })
})
