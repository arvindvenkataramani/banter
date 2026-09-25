import { describe, it, expect, beforeEach, vi } from 'vitest'
import { PlaybackEngine } from './playback-engine'
import { resetDevicesForTest, element as deviceElement } from '../../system/devices'
import { useTurnManagerStore, resetTurnManager, report } from '../store/turn-manager-store'
import { initialTurnManagerState, snapshot as buildSnapshot } from '../turn-manager'
import type { Snapshot } from '../turn-manager'

/**
 * These tests exercise the engine's logic-only paths: held-chunk lifecycle,
 * reconcile()'s reaction to a snapshot, and the report() the engine sends
 * back. The streaming pipeline on a real backend (MediaSource, SourceBuffer,
 * fetch drain) is covered separately in playback-engine.mse.test.ts; jsdom
 * gives this file no MediaSource/ManagedMediaSource, so STREAMING_BACKEND
 * resolves to 'blob' throughout.
 */

/** A snapshot equal to the store's own idle state, with the given fields
 * overridden — the same shape reconcile() reads from the store. */
function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return { ...buildSnapshot(initialTurnManagerState()), ...overrides }
}

/** The element reaching the end of its media — what the engine listens for. */
function endSound(audio: HTMLAudioElement): void {
  audio.dispatchEvent(new Event('ended'))
}

/** The utterance the engine last reported, straight from its own report()
 * call — not the turn manager's derived Turn, which folds outcome and
 * phase through its own reducer and does not restate the engine's report
 * verbatim. */
function lastAgentReport() {
  const r = useTurnManagerStore.getState().state.last.agent
  return r && r.actor === 'agent' ? r : null
}

function currentAgentUtterance() {
  return lastAgentReport()?.utterance ?? null
}

beforeEach(() => {
  vi.restoreAllMocks()
  resetTurnManager()
})

/** Sets the store's snapshot directly to whatever newAudio value the test
 * needs — enqueueChat reads only useTurnManagerStore.getState().snapshot,
 * so this drives it exactly, without reconstructing the reducer path that
 * produces each value. */
function setNewAudio(newAudio: Snapshot['newAudio']): void {
  useTurnManagerStore.setState((s) => ({ snapshot: { ...s.snapshot, newAudio } }))
}

describe('PlaybackEngine — held chunks', () => {
  it('parks a chunk when the snapshot says park, and does not fetch', () => {
    const engine = new PlaybackEngine()
    setNewAudio('park')

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    engine.enqueueChat({
      endpoint: 'http://localhost:1234',
      text: 'hello',
      modelId: 'm1',
      voiceId: 'v1',
      format: 'mp3',
      speed: 1.0,
    })

    expect(lastAgentReport()?.supply.pending).toBe(1)
    expect(fetchMock).not.toHaveBeenCalled()

    // Every engine ever constructed keeps reacting to the shared store for
    // the rest of the file (see the constructor's own note on this); a
    // chunk left held here would be released by a later test's snapshot
    // change, against an engine with no element. Clean up before the next
    // test's setState.
    engine.cancel()
  })

  it('discards a chunk outright when the snapshot says discard, and never fetches', async () => {
    const engine = new PlaybackEngine()
    setNewAudio('discard')

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await engine.enqueueChat({ endpoint: '', text: 'a', modelId: 'm', voiceId: 'v', format: 'mp3' as const, speed: 1 })

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('releases what was parked once a later enqueue finds play, in the order they were held', async () => {
    const engine = new PlaybackEngine()
    setNewAudio('park')
    const p1 = engine.enqueueChat({ endpoint: '', text: 'a', modelId: 'm', voiceId: 'v', format: 'mp3' as const, speed: 1 })
    expect(lastAgentReport()?.supply.pending).toBe(1)

    setNewAudio('play')
    // The snapshot can say play before reconcile() has released what was
    // parked — enqueueChat's own release-before-dispatch on the next call
    // is what this exercises, not reconcile(). Neither chunk was ever given
    // an initialised element, so both dispatches reject the same way — the
    // held chunk first, in the order it was parked, ahead of the chunk
    // that arrives already finding play.
    const p2 = engine.enqueueChat({ endpoint: '', text: 'b', modelId: 'm', voiceId: 'v', format: 'mp3' as const, speed: 1 })

    await expect(p1).rejects.toThrow('init()')
    await expect(p2).rejects.toThrow('init()')
  })

  it('cancel() drops held chunks and resolves their promises', async () => {
    const engine = new PlaybackEngine()
    setNewAudio('park')

    const p1 = engine.enqueueChat({ endpoint: '', text: 'a', modelId: 'm', voiceId: 'v', format: 'mp3' as const, speed: 1 })
    const p2 = engine.enqueueChat({ endpoint: '', text: 'b', modelId: 'm', voiceId: 'v', format: 'mp3' as const, speed: 1 })
    expect(lastAgentReport()?.supply.pending).toBe(2)

    engine.cancel()

    await expect(Promise.all([p1, p2])).resolves.toEqual([undefined, undefined])
  })
})

// ─────────────────────────────────────────────────────────────────────────
// The element outlives a reset
//
// The audio element is unlocked once, inside a user gesture, and every later
// play depends on that unlock. Destroying the element at voice-off would
// throw the unlock away and leave voice starts that have no tap of their own
// silent, so reset keeps the element and rebuilds everything around it.
// ─────────────────────────────────────────────────────────────────────────
describe('PlaybackEngine — the element survives a reset', () => {
  const OriginalAudio = globalThis.Audio
  let made: HTMLAudioElement[]

  beforeEach(() => {
    resetDevicesForTest()
    made = []
    // A class, not an arrow: the engine calls `new Audio()`, which an arrow
    // function cannot serve as a constructor.
    vi.spyOn(globalThis, 'Audio').mockImplementation(
      class extends OriginalAudio {
        constructor() {
          super()
          made.push(this)
        }
      } as unknown as typeof Audio,
    )
    vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  })

  it('init after reset reuses the same element', () => {
    const engine = new PlaybackEngine()
    engine.init()
    engine.reset()
    engine.init()

    expect(made).toHaveLength(1)
  })

  it('reset leaves the engine ready to play again', () => {
    const engine = new PlaybackEngine()
    engine.init()
    engine.reset()
    engine.init()

    // The engine takes work on the rebuilt pipeline rather than throwing on
    // a detached element.
    expect(() => engine.beginRun('r1')).not.toThrow()
    expect(made).toHaveLength(1)
  })

  it('a command issued right after reset() does not start audio silently', () => {
    const engine = new PlaybackEngine()
    engine.init()
    engine.reset()

    const playSpy = window.HTMLMediaElement.prototype.play as unknown as ReturnType<typeof vi.fn>
    playSpy.mockClear()

    // Nothing mounted, mayBeAudible false by construction on an idle
    // snapshot — reconcile() against the current snapshot must not resume.
    engine.reconcile(useTurnManagerStore.getState().snapshot)

    expect(playSpy).not.toHaveBeenCalled()
  })

  it('unlock plays the element so later plays need no gesture', () => {
    const engine = new PlaybackEngine()
    engine.unlock()

    expect(made).toHaveLength(1)
    expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalled()
  })

  it('unlock survives a play the browser refuses', () => {
    ;(window.HTMLMediaElement.prototype.play as unknown as ReturnType<typeof vi.fn>)
      .mockImplementation(() => Promise.reject(new Error('NotAllowedError')))
    const engine = new PlaybackEngine()

    expect(() => engine.unlock()).not.toThrow()
  })

  // reset() detaches everything the session built, and a voice start that
  // finds the mic loop still alive returns before init(). Playback that
  // follows still has to advance past its first chunk, so the end-of-media
  // handler cannot be something a session arms.
  it('queued playback advances after a reset that no init follows', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob([new Uint8Array([1])])),
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:queued', revokeObjectURL: () => {} })

    const engine = new PlaybackEngine()
    engine.init()
    engine.reset()
    engine.beginRun('r1')

    // Every report the engine sends recomputes the store's snapshot from
    // the real reducer, which reads newAudio back to park with no agent
    // turn open on the floor — reasserted before each enqueue, the way a
    // real conversation report holding the floor open would keep it stable
    // for the run's whole duration.
    const req = { endpoint: 'http://localhost:1234', modelId: 'm1', voiceId: 'v1', format: 'mp3' as const, speed: 1.0 }
    setNewAudio('play')
    await engine.enqueueChat({ ...req, text: 'first' })
    setNewAudio('play')
    await engine.enqueueChat({ ...req, text: 'second' })
    await Promise.resolve()

    const audio = made.at(-1)!
    const playCount = (window.HTMLMediaElement.prototype.play as unknown as ReturnType<typeof vi.fn>).mock.calls.length
    endSound(audio)
    await Promise.resolve()
    await Promise.resolve()

    expect(
      (window.HTMLMediaElement.prototype.play as unknown as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThan(playCount)
  })

  // The bytes are decoded as the runtime's format, so the request asks for
  // that format whatever a model's params say.
  it("requests the runtime's audio format, over any params naming another", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob([new Uint8Array([1])])),
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:aac', revokeObjectURL: () => {} })

    const engine = new PlaybackEngine()
    engine.init()
    engine.beginRun('r-aac')
    setNewAudio('play')
    await engine.enqueueChat({
      endpoint: 'http://localhost:1234', text: 'hi', modelId: 'm', voiceId: 'v',
      format: 'aac', speed: 1, params: { response_format: 'mp3', streaming_interval: 0.5 },
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.response_format).toBe('aac')
    expect(body.streaming_interval).toBe(0.5)
    engine.cancel()
  })
})

// Tones play through the speech element, one file at a time on this backend.
describe('PlaybackEngine — tones', () => {
  const OriginalAudio = globalThis.Audio
  let made: HTMLAudioElement[]

  beforeEach(() => {
    resetDevicesForTest()
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:tone', revokeObjectURL: () => {} })
    made = []
    vi.spyOn(globalThis, 'Audio').mockImplementation(
      class extends OriginalAudio {
        constructor() {
          super()
          made.push(this)
        }
      } as unknown as typeof Audio,
    )
    vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  })

  it('settles when the tone has been heard', async () => {
    const engine = new PlaybackEngine()
    engine.init()

    const p = engine.enqueueTone(new Uint8Array([1, 2, 3]), 1.2)
    await Promise.resolve()
    endSound(made.at(-1)!)

    await expect(p).resolves.toBeUndefined()
  })

  it('settles when a reset cuts it', async () => {
    const engine = new PlaybackEngine()
    engine.init()

    const p = engine.enqueueTone(new Uint8Array([1, 2, 3]), 1.2)
    engine.reset()

    await expect(p).resolves.toBeUndefined()
  })

  it('reconcile leaves a tone alone while mayBeAudible is false', async () => {
    const engine = new PlaybackEngine()
    engine.init()

    const p = engine.enqueueTone(new Uint8Array([1, 2, 3]), 1.2)
    await Promise.resolve()
    const audio = made.at(-1)!
    const pauseSpy = vi.spyOn(audio, 'pause').mockImplementation(() => {})
    Object.defineProperty(audio, 'paused', { value: false, configurable: true })

    // Tones play with mayBeAudible false by construction — reconcile must
    // not pause an element playing only tone bytes.
    engine.reconcile(makeSnapshot({ mayBeAudible: false }))

    expect(pauseSpy).not.toHaveBeenCalled()
    engine.reset()
    await p
  })
})

describe('PlaybackEngine — reconcile and the agent report', () => {
  it('reports null before anything is mounted for a run', () => {
    const engine = new PlaybackEngine()
    engine.init()

    expect(currentAgentUtterance()).toBeNull()
  })

  // "ended" is a level: once a run's utterance has been reported ended, a
  // later, unrelated publish() (a report with nothing new) must keep
  // reporting the same outcome until the next run's first chunk replaces it
  // — appendedToSource alone cannot tell "nothing mounted yet" from "this
  // run's mounted audio already finished."
  it('ended is a level across an unrelated report, until the next run mounts', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob([new Uint8Array([1])])),
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:a', revokeObjectURL: () => {} })
    resetDevicesForTest()
    vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())

    const engine = new PlaybackEngine()
    engine.init()
    engine.beginRun('run-a')
    setNewAudio('play')
    await engine.enqueueChat({ endpoint: '', text: 'hi', modelId: 'm', voiceId: 'v', format: 'mp3' as const, speed: 1 })
    await Promise.resolve()
    // Blob's own "played out": the queued slot has to actually reach the
    // element (playNext() sets audio.src) before the element reports it
    // finished — this pipeline's real drain signal on this backend.
    endSound(deviceElement())
    engine.endRun()

    expect(currentAgentUtterance()).toMatchObject({ id: 'run-a', phase: 'ended', outcome: 'completed' })

    // An unrelated publish — nothing new appended.
    report({ actor: 'controls', controls: { micMuted: false, speechMuted: false, autoMuted: false } })
    expect(currentAgentUtterance()).toMatchObject({ id: 'run-a', phase: 'ended', outcome: 'completed' })

    // beginRun() alone does not clear the level — only the next run's own
    // first mounted chunk replaces it (see the field's own doc comment).
    engine.beginRun('run-b')
    expect(currentAgentUtterance()).toMatchObject({ id: 'run-a', phase: 'ended', outcome: 'completed' })

    setNewAudio('play')
    await engine.enqueueChat({ endpoint: '', text: 'hi again', modelId: 'm', voiceId: 'v', format: 'mp3' as const, speed: 1 })
    expect(currentAgentUtterance()).toMatchObject({ id: 'run-b' })
  })

  it('reconcile does not repeat cancel() on a repeated superseded snapshot', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob([new Uint8Array([1])])),
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:a', revokeObjectURL: () => {} })
    resetDevicesForTest()
    vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())

    const engine = new PlaybackEngine()
    engine.init()
    engine.beginRun('run-a')
    setNewAudio('play')
    await engine.enqueueChat({ endpoint: '', text: 'hi', modelId: 'm', voiceId: 'v', format: 'mp3' as const, speed: 1 })
    await Promise.resolve()

    const supersededSnapshot = makeSnapshot({
      agent: { speaker: 'agent', id: 'run-a', phase: 'ended', utterances: [], outcome: 'superseded' },
    })
    engine.reconcile(supersededSnapshot)
    expect(currentAgentUtterance()).toMatchObject({ id: 'run-a', phase: 'ended', outcome: 'cut' })

    const outcomeAfterFirstCancel = currentAgentUtterance()
    engine.reconcile(supersededSnapshot)

    expect(currentAgentUtterance()).toEqual(outcomeAfterFirstCancel)
  })
})
