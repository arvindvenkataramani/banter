import { describe, it, expect, beforeEach, vi } from 'vitest'
import { PlaybackEngine } from './playback-engine'
import type { PlayerState } from './playback-engine'

/**
 * These tests exercise the engine's logic-only paths: held-chunk lifecycle,
 * shouldHold predicate, callback wiring. The streaming pipeline (MediaSource,
 * SourceBuffer, fetch drain) requires a browser environment and is verified
 * manually via the dashboard.
 */

interface Captured {
  states: PlayerState[]
  heldCounts: number[]
}

function makeEngine(): { engine: PlaybackEngine; captured: Captured } {
  const captured: Captured = { states: [], heldCounts: [] }
  const engine = new PlaybackEngine({
    onState: (s) => captured.states.push(s),
    onRemainingSeconds: () => { /* ignore */ },
    onHeldChunkCount: (n) => captured.heldCounts.push(n),
  })
  return { engine, captured }
}

describe('PlaybackEngine — held chunks', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('holds a chunk when shouldHold() returns true', async () => {
    const { engine, captured } = makeEngine()
    engine.setShouldHold(() => true)

    const promise = engine.enqueueChat({
      endpoint: 'http://localhost:1234',
      text: 'hello',
      modelId: 'm1',
      voiceId: 'v1',
      speed: 1.0,
    })

    expect(engine.heldChunkCount).toBe(1)
    expect(captured.heldCounts).toEqual([1])

    // Drop and verify promise resolves cleanly
    engine.dropHeldChunks()
    await promise
    expect(engine.heldChunkCount).toBe(0)
    expect(captured.heldCounts).toEqual([1, 0])
  })

  it('releaseHeldChunks dispatches via shouldHold=false replay', async () => {
    const { engine } = makeEngine()
    let hold = true
    engine.setShouldHold(() => hold)

    // Mock fetch so the dispatch path doesn't try real network
    const fetchMock = vi.fn().mockRejectedValue(new Error('test-no-network'))
    vi.stubGlobal('fetch', fetchMock)
    // We need init() to attach <audio> for dispatchSpeak's null check
    // but jsdom doesn't fully support MediaSource. Calling init() will
    // succeed enough to clear the audio guard.
    // jsdom does provide HTMLAudioElement; ManagedMediaSource is undefined,
    // MediaSource is undefined → backend = 'blob'. Skip init() entirely;
    // we exercise the held-chunks paths directly.

    const p = engine.enqueueChat({
      endpoint: 'http://localhost:1234',
      text: 'hello',
      modelId: 'm1',
      voiceId: 'v1',
      speed: 1.0,
    })
    expect(engine.heldChunkCount).toBe(1)

    hold = false
    engine.releaseHeldChunks()
    expect(engine.heldChunkCount).toBe(0)

    // The replayed dispatch will throw because audio isn't init'd; the
    // promise rejects. We just verify the held queue cleared.
    await p.catch(() => { /* expected */ })
  })

  it('cancel() drops held chunks', async () => {
    const { engine } = makeEngine()
    engine.setShouldHold(() => true)

    const p1 = engine.enqueueChat({ endpoint: '', text: 'a', modelId: 'm', voiceId: 'v', speed: 1 })
    const p2 = engine.enqueueChat({ endpoint: '', text: 'b', modelId: 'm', voiceId: 'v', speed: 1 })
    expect(engine.heldChunkCount).toBe(2)

    engine.cancel()
    await Promise.all([p1, p2])
    expect(engine.heldChunkCount).toBe(0)
  })

  it('discards a chunk when speech is muted instead of holding it', async () => {
    const { engine, captured } = makeEngine()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    engine.setShouldHold(() => false)
    engine.setShouldDiscard(() => true)

    await engine.enqueueChat({ endpoint: '', text: 'a', modelId: 'm', voiceId: 'v', speed: 1 })

    expect(engine.heldChunkCount).toBe(0)
    expect(captured.heldCounts).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('discards rather than holds when muted and the user is speaking', async () => {
    const { engine } = makeEngine()
    engine.setShouldHold(() => true)
    engine.setShouldDiscard(() => true)

    await engine.enqueueChat({ endpoint: '', text: 'a', modelId: 'm', voiceId: 'v', speed: 1 })

    expect(engine.heldChunkCount).toBe(0)
  })

  it('plays nothing retroactively after unmuting', async () => {
    // The started-muted path: a full turn arrives while muted, the user
    // unmutes, then a later utterance is rejected as noise and releases.
    const { engine } = makeEngine()
    const fetchMock = vi.fn().mockRejectedValue(new Error('test-no-network'))
    vi.stubGlobal('fetch', fetchMock)
    let muted = true
    engine.setShouldHold(() => false)
    engine.setShouldDiscard(() => muted)

    for (const text of ['one', 'two', 'three']) {
      await engine.enqueueChat({ endpoint: '', text, modelId: 'm', voiceId: 'v', speed: 1 })
    }
    expect(engine.heldChunkCount).toBe(0)

    muted = false
    engine.releaseHeldChunks()

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('setConcurrency stores the cap', () => {
    const { engine } = makeEngine()
    engine.setConcurrency(3)
    // No assertion target other than no-throw; the cap is exercised via
    // dispatchSpeak which needs init() + fetch mocks.
    expect(() => engine.setConcurrency(undefined)).not.toThrow()
  })
})

describe('PlaybackEngine — beginRun cancels prior state', () => {
  it('beginRun() bumps generation', () => {
    const { engine } = makeEngine()
    // Capture private generation via a second held chunk
    engine.setShouldHold(() => true)
    const p1 = engine.enqueueChat({ endpoint: '', text: 'a', modelId: 'm', voiceId: 'v', speed: 1 })
    expect(engine.heldChunkCount).toBe(1)
    engine.beginRun()
    // beginRun calls cancel() which drops held chunks
    expect(engine.heldChunkCount).toBe(0)
    return p1.catch(() => {})
  })
})
