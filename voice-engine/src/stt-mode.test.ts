import { describe, it, expect } from 'vitest'
import { resolveSttMode, resolveChunkMs, sttModeSource } from './voice-session-store'

// Which way a model is brought up, from what the roster declares about the model
// (`stt.models[].kind`, as GET /api/voice serves it) and what the selected service's
// provisions offer (dev/specs/service-apis.md, sections 6 and 11). Nothing is read
// from the server.
//
// INVENTED: the functions keep their names and module. `resolveSttMode(option, model,
// preferStreaming?)` and `sttModeSource(option, model)` take the selected `stt.options[]`
// entry (`{ serviceId, name, provides, models, serves }`) and the `stt.models[]` entry.
// `resolveChunkMs(model, configured?)` takes the model entry alone.

const asFn = <T>(fn: unknown): T => fn as T
const mode = asFn<(option: unknown, model: unknown, prefer?: boolean) => 'batch' | 'streaming'>(resolveSttMode)
const source = asFn<(option: unknown, model: unknown) => 'choice' | 'model' | 'unknown'>(sttModeSource)
const chunkMs = asFn<(model: unknown, configured?: number) => number | undefined>(resolveChunkMs)

const stream = { api: 'fluid.stt.stream' }
const batch = { api: 'openai.audio.transcriptions' }
const option = (...provides: unknown[]) => ({ serviceId: 'stt-a', name: 'STT A', provides, models: { loading: 'none' }, serves: [] })

const both = option(stream, batch)
const model = (kind: 'batch' | 'streaming' | 'both') => ({ id: 'stt-model', kind })

describe('resolving how to bring a model up', () => {
  it('[T2] follows the model for one that does a single thing, whatever the preference says', () => {
    expect(mode(both, model('streaming'))).toBe('streaming')
    expect(mode(both, model('batch'))).toBe('batch')
    // Preferring streaming cannot make a batch model stream. Config states an
    // inclination, not a capability.
    expect(mode(both, model('batch'), true)).toBe('batch')
    expect(mode(both, model('streaming'), false)).toBe('streaming')
  })

  it('[T2] lets the preference decide a model that offers both, and takes batch with none stated', () => {
    expect(mode(both, model('both'), true)).toBe('streaming')
    expect(mode(both, model('both'), false)).toBe('batch')
    // The more accurate of the two; streaming is opted into.
    expect(mode(both, model('both'))).toBe('batch')
  })

  it('[T2] takes the only route the service offers for a model that offers both', () => {
    expect(mode(option(stream), model('both'), false)).toBe('streaming')
    expect(mode(option(batch), model('both'), true)).toBe('batch')
  })
})

describe('what decided the mode', () => {
  it('[T2] is the choice where the model and the service both allow either, and the declarations where they leave one', () => {
    expect(source(both, model('both'))).toBe('choice')
    expect(source(both, model('batch'))).toBe('model')
    expect(source(both, model('streaming'))).toBe('model')
    expect(source(option(stream), model('both'))).toBe('model')
  })
})

describe('choosing a latency tier', () => {
  // The real Nemotron entry: the tiers are the values of its declared chunkMs parameter.
  const tiered = { id: 'tiered', kind: 'streaming', params: [{ name: 'chunkMs', values: [560, 1120, 2240] }] }

  it('[T2] names nothing for a model that offers no choice', () => {
    expect(chunkMs({ id: 'plain', kind: 'streaming' })).toBeUndefined()
    expect(chunkMs({ id: 'plain', kind: 'batch', params: [] }, 560)).toBeUndefined()
  })

  it('[T2] takes the configured tier when the model offers it', () => {
    expect(chunkMs(tiered, 1120)).toBe(1120)
  })

  it('[T2] always names one for a model that offers tiers', () => {
    // Such a model refuses a load naming none, so answering nothing here
    // would be a load that cannot succeed.
    expect(chunkMs(tiered)).toBe(560)
  })

  it('[T2] ignores a tier the model does not offer rather than approximating it', () => {
    // 800 is between two real tiers. Rounding to a neighbour would give a
    // latency nobody asked for and nobody could account for.
    expect(chunkMs(tiered, 800)).toBe(560)
  })
})
