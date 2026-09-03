import { describe, it, expect } from 'vitest'
import { loadVoiceSelection } from './voice-config'
import type { VoiceConfig } from './voice-config'

// ── Helpers ─────────────────────────────────────────────────────────────────

/** A config with one provider, one model, two voices, and no `selection`. */
function catalogueOnly(): VoiceConfig {
  return {
    tts: {
      providers: [
        {
          serviceId: 'tts-mine',
          name: 'My TTS',
          models: [
            {
              id: 'model-a',
              name: 'Model A',
              voices: [{ id: 'voice-1', name: 'One' }, { id: 'voice-2', name: 'Two' }],
            },
          ],
        },
      ],
    },
  } as VoiceConfig
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('loadVoiceSelection — falling back to the catalogue', () => {
  it('uses the first provider, model and voice when selection is absent', () => {
    const sel = loadVoiceSelection(catalogueOnly())
    expect(sel).toMatchObject({ serviceId: 'tts-mine', model: 'model-a', voice: 'voice-1' })
    expect(sel?.speed).toBe(1.0)
  })

  it('prefers an explicit selection over the fallback', () => {
    const config = catalogueOnly()
    config.tts.selection = { serviceId: 'tts-mine', model: 'model-a', voice: 'voice-2', speed: 1.5 }
    const sel = loadVoiceSelection(config)
    expect(sel?.voice).toBe('voice-2')
    expect(sel?.speed).toBe(1.5)
  })

  it('picks the first provider when several are declared', () => {
    const config = catalogueOnly()
    config.tts.providers.unshift({
      serviceId: 'tts-other',
      name: 'Other',
      models: [{ id: 'model-z', name: 'Z', voices: [{ id: 'voice-z', name: 'Z' }] }],
    })
    expect(loadVoiceSelection(config)).toMatchObject({
      serviceId: 'tts-other',
      model: 'model-z',
      voice: 'voice-z',
    })
  })

  it('returns null when there is nothing to fall back to', () => {
    expect(loadVoiceSelection({ tts: { providers: [] } } as unknown as VoiceConfig)).toBeNull()
  })

  it('returns null when a provider declares no usable model or voice', () => {
    const noModels = { tts: { providers: [{ serviceId: 'x', models: [] }] } } as unknown as VoiceConfig
    expect(loadVoiceSelection(noModels)).toBeNull()

    const noVoices = {
      tts: { providers: [{ serviceId: 'x', models: [{ id: 'm', voices: [] }] }] },
    } as unknown as VoiceConfig
    expect(loadVoiceSelection(noVoices)).toBeNull()
  })

  it('still merges model and voice params into a fallback selection', () => {
    const config = catalogueOnly()
    config.tts.providers[0].models[0].voices[0] = { id: 'voice-1', name: 'One', pitch: 3 } as never
    expect(loadVoiceSelection(config)?.params).toMatchObject({ pitch: 3 })
  })
})
