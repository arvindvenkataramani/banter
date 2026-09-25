import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type { PlaybackEngine as PlaybackEngineType } from './playback-engine'
import type { useTurnManagerStore as useTurnManagerStoreType, resetTurnManager as resetTurnManagerType } from '../store/turn-manager-store'
import type { snapshot as buildSnapshotType, initialTurnManagerState as initialTurnManagerStateType, Snapshot } from '../turn-manager'

/**
 * The engine on a streaming backend. Every real browser runs `mms` or `mse`;
 * jsdom defines neither MediaSource nor ManagedMediaSource, so the rest of
 * the suite (playback-engine.test.ts) exercises the `blob` fallback alone
 * and the production path goes unwatched. The backend is read once at
 * module load from localStorage, so setting the key and importing the
 * module dynamically puts the engine, and the store it reports into, on the
 * branch users actually get.
 */

class FakeSourceBuffer extends EventTarget {
  updating = false
  appended: Uint8Array[] = []
  types: string[]

  constructor(type: string) {
    super()
    this.types = [type]
  }

  changeType(type: string): void {
    this.types.push(type)
  }

  appendBuffer(chunk: Uint8Array): void {
    this.appended.push(chunk)
    this.updating = true
    queueMicrotask(() => {
      this.updating = false
      this.dispatchEvent(new Event('updateend'))
    })
  }

  abort(): void { /* nothing to unwind in the fake */ }
}

class FakeMediaSource extends EventTarget {
  readyState = 'closed'
  buffers: FakeSourceBuffer[] = []
  endOfStreamCalls = 0

  addSourceBuffer(type: string): FakeSourceBuffer {
    // Real MSE throws InvalidStateError on a source that is not open.
    if (this.readyState !== 'open') {
      throw new DOMException('source is not open', 'InvalidStateError')
    }
    const sb = new FakeSourceBuffer(type)
    this.buffers.push(sb)
    return sb
  }

  endOfStream(): void {
    this.endOfStreamCalls++
    this.readyState = 'ended'
  }

  /** The handshake the browser completes asynchronously after attachment. */
  open(): void {
    this.readyState = 'open'
    this.dispatchEvent(new Event('sourceopen'))
  }

  static isTypeSupported(): boolean {
    return true
  }
}

let PlaybackEngine: typeof PlaybackEngineType
let resetDevicesForTest: () => void
let useTurnManagerStore: typeof useTurnManagerStoreType
let resetTurnManager: typeof resetTurnManagerType
let buildSnapshot: typeof buildSnapshotType
let initialTurnManagerState: typeof initialTurnManagerStateType
let sources: FakeMediaSource[]
let elements: HTMLAudioElement[]

beforeAll(async () => {
  localStorage.setItem('tts-streaming-backend', 'mse')
  vi.stubGlobal('MediaSource', FakeMediaSource)
  vi.resetModules()
  // Dynamic: a static import is hoisted above the globals the module reads
  // at load time. The device module and the turn manager store are
  // imported from the same fresh registry as the engine, so this file's
  // own report()/resetTurnManager() act on the same store instance the
  // engine subscribes to.
  ;({ PlaybackEngine } = await import('./playback-engine'))
  ;({ resetDevicesForTest } = await import('../../system/devices'))
  ;({ useTurnManagerStore, resetTurnManager } = await import('../store/turn-manager-store'))
  ;({ snapshot: buildSnapshot, initialTurnManagerState } = await import('../turn-manager'))
})

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return { ...buildSnapshot(initialTurnManagerState()), ...overrides }
}

function setNewAudio(newAudio: Snapshot['newAudio']): void {
  useTurnManagerStore.setState((s) => ({ snapshot: { ...s.snapshot, newAudio } }))
}

function lastAgentReport() {
  const r = useTurnManagerStore.getState().state.last.agent
  return r && r.actor === 'agent' ? r : null
}

function currentAgentUtterance() {
  return lastAgentReport()?.utterance ?? null
}

function makeEngine(): PlaybackEngineType {
  return new PlaybackEngine()
}

describe('PlaybackEngine on a streaming backend', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    resetDevicesForTest()
    resetTurnManager()
    sources = []
    elements = []
    vi.stubGlobal('MediaSource', class extends FakeMediaSource {
      constructor() {
        super()
        sources.push(this)
      }
    })
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:mse', revokeObjectURL: () => {} })
    const OriginalAudio = globalThis.Audio
    vi.spyOn(globalThis, 'Audio').mockImplementation(
      class extends OriginalAudio {
        constructor() {
          super()
          elements.push(this)
        }
      } as unknown as typeof Audio,
    )
    vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  })

  it('runs on the backend real browsers use', () => {
    const engine = makeEngine()
    expect(engine.streamingTier).toBe('mse')
    expect(engine.useMSE).toBe(true)
  })

  // On MSE/MMS play() clears `paused` before it looks at readyState, so the
  // gesture play in unlock() leaves an element with an empty media source
  // and nothing audible reading un-paused. Treating that as audio worth
  // pausing would have reconcile() pause an element with nothing mounted.
  it('the gesture play on an empty element after unlock does not report an utterance', () => {
    const engine = makeEngine()
    engine.unlock()
    Object.defineProperty(elements.at(-1)!, 'paused', { value: false, configurable: true })

    elements.at(-1)!.dispatchEvent(new Event('playing'))

    expect(currentAgentUtterance()).toBeNull()
  })

  // completed derives from the drained `waiting` condition, not the
  // element's `ended` event — MediaSource.endOfStream() is never called in
  // this pipeline, so `ended` never fires for a real response.
  it('a run drains and settles completed via the waiting condition, not the ended event', async () => {
    const engine = makeEngine()
    engine.init()
    setNewAudio('play')
    engine.beginRun('run-a')
    sources.at(-1)!.open()
    const chunk = { bytes: new Uint8Array([1, 2, 3]), mime: 'audio/mpeg' }
    ;(engine as unknown as { pendingChunks: typeof chunk[] }).pendingChunks.push(chunk)
    ;(engine as unknown as { processNextChunk: () => void }).processNextChunk()
    await Promise.resolve()
    await Promise.resolve()

    const audio = elements.at(-1)!
    engine.endRun()
    Object.defineProperty(audio, 'currentTime', { value: 0, configurable: true, writable: true })
    audio.dispatchEvent(new Event('waiting'))

    expect(currentAgentUtterance()).toMatchObject({ id: 'run-a', phase: 'ended', outcome: 'completed' })
    // Every engine ever constructed keeps reacting to the shared store for
    // the rest of the file (the constructor's own subscription outlives
    // the test) — cancel before the next test's report()/setState calls
    // reach this one.
    engine.cancel()
  })

  // Tones are mp3 on the one SourceBuffer the session holds, and a runtime
  // may speak another format; each change of type switches the buffer
  // before the bytes go in.
  it('switches the source buffer to each chunk type before appending it', async () => {
    const engine = makeEngine()
    engine.init()
    sources.at(-1)!.open()
    const queue = (engine as unknown as { pendingChunks: { bytes: Uint8Array; mime: string }[] }).pendingChunks
    const drain = () => (engine as unknown as { processNextChunk: () => void }).processNextChunk()
    const settle = () => new Promise((r) => setTimeout(r, 0))

    queue.push({ bytes: new Uint8Array([1]), mime: 'audio/mpeg' })
    drain()
    await settle()
    queue.push({ bytes: new Uint8Array([2]), mime: 'audio/aac' }, { bytes: new Uint8Array([3]), mime: 'audio/aac' })
    drain()
    await settle()
    queue.push({ bytes: new Uint8Array([4]), mime: 'audio/mpeg' })
    drain()
    await settle()

    const sb = sources.at(-1)!.buffers[0]
    expect(sb.types).toEqual(['audio/mpeg', 'audio/aac', 'audio/mpeg'])
    expect(sb.appended.map((c) => c[0])).toEqual([1, 2, 3, 4])
    engine.cancel()
  })

  // A tone is bytes on the speech timeline. Its end is where the timeline
  // stood at enqueue plus its length, and the engine reports it heard when
  // playback passes that point.
  it('a tone settles when playback passes its end on the timeline', async () => {
    const engine = makeEngine()
    const p = engine.enqueueTone(new Uint8Array([1, 2, 3]), 1.2)
    const audio = elements.at(-1)!
    sources.at(-1)!.open()
    await new Promise((r) => setTimeout(r, 0))

    Object.defineProperty(audio, 'currentTime', { value: 0.5, configurable: true, writable: true })
    audio.dispatchEvent(new Event('timeupdate'))
    let settled = false
    void p.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    audio.currentTime = 1.2
    audio.dispatchEvent(new Event('timeupdate'))
    await expect(p).resolves.toBeUndefined()
  })

  // mayBeAudible false pauses a run genuinely mounted and playing — the
  // snapshot's own instruction to stop, distinct from the tone branch above.
  it('reconcile pauses a mounted run when mayBeAudible turns false', async () => {
    const engine = makeEngine()
    engine.init()
    setNewAudio('play')
    engine.beginRun('run-a')
    sources.at(-1)!.open()
    ;(engine as unknown as { pendingChunks: Uint8Array[] }).pendingChunks.push(new Uint8Array([1, 2, 3]))
    ;(engine as unknown as { processNextChunk: () => void }).processNextChunk()
    await Promise.resolve()
    await Promise.resolve()
    const audio = elements.at(-1)!
    const pauseSpy = vi.spyOn(audio, 'pause').mockImplementation(() => {})
    Object.defineProperty(audio, 'paused', { value: false, configurable: true })

    engine.reconcile(makeSnapshot({ mayBeAudible: false }))

    expect(pauseSpy).toHaveBeenCalled()
    engine.cancel()
  })

  // The tail of a response is still audio: a resume that finds mayBeAudible
  // true again, with nothing further in flight, still has buffered speech
  // to play — remainingSeconds, not "is a stream still active," is what
  // makes it resumable.
  it('reconcile resumes a paused run that still has buffered audio ahead', async () => {
    const engine = makeEngine()
    engine.init()
    setNewAudio('play')
    engine.beginRun('run-a')
    sources.at(-1)!.open()
    ;(engine as unknown as { pendingChunks: Uint8Array[] }).pendingChunks.push(new Uint8Array([1, 2, 3]))
    ;(engine as unknown as { processNextChunk: () => void }).processNextChunk()
    await Promise.resolve()
    await Promise.resolve()
    const audio = elements.at(-1)!
    const playSpy = window.HTMLMediaElement.prototype.play as unknown as ReturnType<typeof vi.fn>
    playSpy.mockClear()
    Object.defineProperty(audio, 'paused', { value: true, configurable: true })
    Object.defineProperty(audio, 'buffered', {
      value: { length: 1, end: () => 5 },
      configurable: true,
    })

    engine.reconcile(makeSnapshot({ mayBeAudible: true }))

    expect(playSpy).toHaveBeenCalled()
    engine.cancel()
  })

  it('reconcile leaves a tone alone and does not report it as the agent\'s utterance', async () => {
    const engine = makeEngine()
    const p = engine.enqueueTone(new Uint8Array([1, 2, 3]), 1.2)
    const audio = elements.at(-1)!
    sources.at(-1)!.open()
    await new Promise((r) => setTimeout(r, 0))
    Object.defineProperty(audio, 'paused', { value: false, configurable: true })

    engine.reconcile(makeSnapshot({ mayBeAudible: false }))

    expect(currentAgentUtterance()).toBeNull()
    audio.currentTime = 1.2
    audio.dispatchEvent(new Event('timeupdate'))
    await expect(p).resolves.toBeUndefined()
  })

  it('refuses a tone while a run is active', async () => {
    const engine = makeEngine()
    engine.init()
    engine.beginRun('run-a')

    await expect(engine.enqueueTone(new Uint8Array([1]), 1.2)).resolves.toBeUndefined()
    expect(sources.at(-1)!.buffers.flatMap((b) => b.appended)).toHaveLength(0)
    engine.cancel()
  })

  it('a run beginning cuts a tone and releases its waiter', async () => {
    const engine = makeEngine()
    const p = engine.enqueueTone(new Uint8Array([1, 2, 3]), 1.2)
    sources.at(-1)!.open()
    await Promise.resolve()

    engine.beginRun('run-a')

    await expect(p).resolves.toBeUndefined()
  })

  // Reconcile's cancel does not repeat: a superseded snapshot cancels once,
  // and a second notification against the same (or an equivalent)
  // superseded state finds nothing left to cancel.
  it('reconcile cancels a superseded run once, not on every repeated notification', async () => {
    const engine = makeEngine()
    engine.init()
    setNewAudio('play')
    engine.beginRun('run-a')
    sources.at(-1)!.open()
    ;(engine as unknown as { pendingChunks: Uint8Array[] }).pendingChunks.push(new Uint8Array([1, 2, 3]))
    ;(engine as unknown as { processNextChunk: () => void }).processNextChunk()
    await Promise.resolve()
    await Promise.resolve()

    const sourceCountBefore = sources.length
    const supersededSnapshot = makeSnapshot({
      agent: { speaker: 'agent', id: 'run-a', phase: 'ended', utterances: [], outcome: 'superseded' },
    })
    engine.reconcile(supersededSnapshot)
    expect(currentAgentUtterance()).toMatchObject({ id: 'run-a', phase: 'ended', outcome: 'cut' })
    expect(sources.length).toBe(sourceCountBefore + 1) // rebuilt once

    engine.reconcile(supersededSnapshot)

    expect(sources.length).toBe(sourceCountBefore + 1) // not rebuilt again
  })
})
