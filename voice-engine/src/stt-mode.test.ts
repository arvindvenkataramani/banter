import { afterEach, describe, it, expect, vi } from 'vitest'
import { fetchSttModelFacts, resolveSttMode, resolveChunkMs } from './voice-session-store'

/**
 * Which way a model is brought up, given what its server said about it.
 *
 * The server is the authority wherever it answers. Config answers only for
 * what the server left open — a model that genuinely offers both, or a server
 * old enough to report neither field.
 */
describe('resolving how to bring a model up', () => {
  it('follows the server for a model that does one thing', () => {
    expect(resolveSttMode({ kind: 'streaming' })).toBe('streaming')
    expect(resolveSttMode({ kind: 'batch' })).toBe('batch')
  })

  it('ignores a preference where the model offers no choice', () => {
    // Preferring streaming cannot make a batch model stream. Config states an
    // inclination, not a capability.
    expect(resolveSttMode({ kind: 'batch' }, true)).toBe('batch')
    expect(resolveSttMode({ kind: 'streaming' }, false)).toBe('streaming')
  })

  it('lets the preference decide a model that offers both', () => {
    expect(resolveSttMode({ kind: 'both' }, true)).toBe('streaming')
    expect(resolveSttMode({ kind: 'both' }, false)).toBe('batch')
  })

  it('takes batch for a both model with no preference stated', () => {
    // The more accurate of the two, and what this loop did before streaming
    // existed. Streaming is opted into.
    expect(resolveSttMode({ kind: 'both' })).toBe('batch')
  })

  it('falls back to transport for a server that reports no kind', () => {
    expect(resolveSttMode({ transport: ['websocket'] })).toBe('streaming')
    expect(resolveSttMode({ transport: ['http'] })).toBe('batch')
  })

  it('lets the preference decide a model reachable both ways', () => {
    // Two routes and no kind is the same choice a `both` kind presents.
    expect(resolveSttMode({ transport: ['http', 'websocket'] }, true)).toBe('streaming')
    expect(resolveSttMode({ transport: ['http', 'websocket'] }, false)).toBe('batch')
  })

  it('prefers kind over transport when both are reported', () => {
    // Kind describes the model and transport the route to it. Where they
    // disagree the model wins, because that is what is being loaded.
    expect(resolveSttMode({ kind: 'batch', transport: ['websocket'] })).toBe('batch')
  })

  it('takes batch when nothing is known at all', () => {
    // A server that answered neither field, or one that could not be reached.
    // The preference does not rescue this: it says which half of a model that
    // offers both to take, and nothing here says the model offers both.
    expect(resolveSttMode({})).toBe('batch')
    expect(resolveSttMode({}, true)).toBe('batch')
  })
})

describe('choosing a latency tier', () => {
  // The real Nemotron entry.
  const tiered = { kind: 'streaming' as const, chunkSizesMs: [560, 1120, 2240] }

  it('names nothing for a model that offers no choice', () => {
    expect(resolveChunkMs({ kind: 'streaming' })).toBeUndefined()
    expect(resolveChunkMs({ kind: 'batch' }, 560)).toBeUndefined()
  })

  it('takes the configured tier when the model offers it', () => {
    expect(resolveChunkMs(tiered, 1120)).toBe(1120)
  })

  it('always names one for a model that offers tiers', () => {
    // Such a model refuses a load naming none, so answering nothing here
    // would be a load that cannot succeed.
    expect(resolveChunkMs(tiered)).toBe(560)
  })

  it('ignores a tier the model does not offer rather than approximating it', () => {
    // 800 is between two real tiers. Rounding to a neighbour would give a
    // latency nobody asked for and nobody could account for.
    expect(resolveChunkMs(tiered, 800)).toBe(560)
  })
})

/**
 * The tiers a model offers are the values of the `chunkMs` parameter its
 * roster entry declares, as the server's listing reports it.
 */
describe('reading what a model offers from its listing', () => {
  const listing = {
    data: [
      {
        id: 'nemotron-streaming-en-0.6b',
        kind: 'streaming',
        transport: ['websocket'],
        present: true,
        params: [{ name: 'chunkMs', values: [560, 1120, 2240] }],
        variants: [
          { id: '560ms', params: [{ name: 'chunkMs', value: 560 }] },
          { id: '1120ms', params: [{ name: 'chunkMs', value: 1120 }] },
          { id: '2240ms', params: [{ name: 'chunkMs', value: 2240 }] },
        ],
      },
      { id: 'parakeet-unified-0.6b', kind: 'both', transport: ['http', 'websocket'], present: true },
    ],
  }

  afterEach(() => vi.unstubAllGlobals())

  function serve(body: unknown) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })))
  }

  it('takes the offered tiers from the declared chunkMs parameter', async () => {
    serve(listing)
    const facts = await fetchSttModelFacts('https://stt.test', 'nemotron-streaming-en-0.6b')
    expect(facts.chunkSizesMs).toEqual([560, 1120, 2240])
    expect(facts.kind).toBe('streaming')
  })

  it('reports no tiers for a model that declares no chunkMs parameter', async () => {
    serve(listing)
    const facts = await fetchSttModelFacts('https://stt.test', 'parakeet-unified-0.6b')
    expect(facts.chunkSizesMs).toBeUndefined()
  })
})
