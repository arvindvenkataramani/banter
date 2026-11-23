import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useVoiceSystemStore } from '@platform/voice-engine/system/voice-system'
import { editTranscript, useTranscriptStore } from '@platform/voice-engine/store/transcript-store'
import type { VoiceConfig } from '@platform/voice-engine/voice-config'
import { useVoiceSessionStore } from '@platform/voice-engine/voice-session-store'
import type { DshClientContext, DshConfigForm, DshObservable } from './dsh-types'
import type { DraftMirror } from './draft-mirror'
import type { ConfigFeed, FeedState } from './config-feed'
import type { ShownSession } from './shown-session'
import type { VoiceSessionDeps } from './session-adapter'

// The runtime is real. Its edges are stand-ins: the session adapter records the
// deps the runtime hands it, the voice system records its calls, the config feed
// is driven by the test, and dsh's context is a few observables.

const adapterDeps = new Map<string, VoiceSessionDeps>()
vi.mock('./session-adapter.ts', () => ({
  createVoiceSession: (session: { sessionId: string }, deps: VoiceSessionDeps) => {
    adapterDeps.set(session.sessionId, deps)
    return { dispose: vi.fn() }
  },
}))
const system = { voiceOn: vi.fn(), voiceOff: vi.fn(), reconfigure: vi.fn() }
vi.mock('./system.ts', () => ({ createVoiceSystem: () => system }))
vi.mock('./services.ts', () => ({ createPluginServices: () => ({}) }))

const { createVoiceRuntime } = await import('./runtime')

function observable<T>(initial: T): DshObservable<T> & { set(next: T): void } {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(next) { current = next; for (const listener of [...listeners]) listener() },
  }
}

const config = (ttsModel: string, sttServiceId = 'stt-a'): VoiceConfig => ({
  tts: {
    models: [
      { id: 'model-1', name: 'Model 1', canClone: false },
      { id: 'model-2', name: 'Model 2', canClone: false },
    ],
    providers: [{
      serviceId: 'tts-b',
      responseFormat: 'mp3',
      serves: [
        { model: 'model-1', key: 'model-1', realtime: true },
        { model: 'model-2', key: 'model-2', realtime: true },
      ],
    }],
    voices: [{ id: 'voice-1', name: 'One', renderings: [{ model: 'model-1', method: 'preset' }, { model: 'model-2', method: 'preset' }] }],
    selection: { serviceId: 'tts-b', model: ttsModel, voice: 'voice-1', speed: 1, request: { model: ttsModel, voice: 'voice-1' } },
  },
  stt: { serviceId: sttServiceId },
})

/** A feed whose state the test sets; `reload` never answers unless the test says so. */
function fakeFeed(initial: VoiceConfig | null) {
  let state: FeedState = { config: initial, loadedAt: initial === null ? null : 1, error: null }
  const listeners = new Set<() => void>()
  const feed = {
    reload: vi.fn(() => new Promise<void>(() => {})),
    check: vi.fn(),
    state: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  return {
    feed: feed as unknown as ConfigFeed & { reload: typeof feed.reload },
    land(next: VoiceConfig) {
      state = { config: next, loadedAt: 2, error: null }
      for (const listener of [...listeners]) listener()
    },
  }
}

function setup(initial: VoiceConfig | null = config('model-1')) {
  const shown = observable<ShownSession>({ sessionId: 'one', panelOpen: false })
  const ctx = {
    sessions: {
      retain: (sessionId: string) => ({
        binding: { session: { sessionId, prompt: vi.fn(), cancel: vi.fn() }, eventSource: {} },
        release: vi.fn(),
      }),
    },
  } as unknown as DshClientContext
  const form = observable({
    status: 'ready',
    value: { controlPlaneUrl: 'http://control.invalid:7000', keepVoiceOutside: false },
    revision: 1,
    writable: true,
  }) as unknown as DshConfigForm<never>
  const { feed, land } = fakeFeed(initial)
  const runtime = createVoiceRuntime({ ctx, shown, form, feed, origin: 'http://host' })
  return { runtime, shown, feed, land }
}

const fakeBox = () => ({ restore: vi.fn(), snapshot: vi.fn() }) as unknown as DraftMirror & { restore: ReturnType<typeof vi.fn> }
const transcript = () => useTranscriptStore.getState().settled

beforeEach(() => {
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn(), visibilityState: 'visible' })
  vi.stubGlobal('fetch', vi.fn(async () => ({})))
  adapterDeps.clear()
  system.voiceOn.mockClear()
  system.reconfigure.mockClear()
  useTranscriptStore.setState({ settled: '', pending: [], sent: {} })
})
afterEach(() => {
  useVoiceSystemStore.setState({ phase: 'off' })
  vi.unstubAllGlobals()
})

describe('runtime — a failed voice send', () => {
  it('goes back into the transcript when voice is still attached to the session and no box is mounted', () => {
    const { runtime } = setup()
    runtime.start('one')
    editTranscript('said since')

    adapterDeps.get('one')?.sendFailed?.('the lost words', 'offline')

    expect(transcript()).toBe('the lost words said since')
    expect(runtime.ui.get().notice).toBe('Not sent: offline')
    runtime.dispose()
  })

  it('goes into the box of the session when one is mounted', () => {
    const { runtime } = setup()
    runtime.start('one')
    const box = fakeBox()
    runtime.registerBox('one', box)

    adapterDeps.get('one')?.sendFailed?.('the lost words', 'offline')

    expect(box.restore).toHaveBeenCalledWith('the lost words')
    runtime.dispose()
  })

  it('is dropped when voice has moved to another session, leaving that session\'s draft alone', () => {
    const { runtime, shown } = setup()
    runtime.start('one')
    useVoiceSystemStore.setState({ phase: 'live' })
    shown.set({ sessionId: 'two', panelOpen: false })
    expect(runtime.ui.get().attachedSessionId).toBe('two')
    editTranscript('draft of two')

    adapterDeps.get('one')?.sendFailed?.('the lost words', 'offline')

    expect(transcript()).toBe('draft of two')
    expect(runtime.ui.get().notice).toBe('Not sent: offline')
    runtime.dispose()
  })

  it('is dropped when voice has ended', () => {
    const { runtime } = setup()
    runtime.start('one')
    useVoiceSystemStore.setState({ phase: 'off' })
    editTranscript('typed later')

    adapterDeps.get('one')?.sendFailed?.('the lost words', 'offline')

    expect(transcript()).toBe('typed later')
    runtime.dispose()
  })
})

describe('runtime — the voice settings from Banter', () => {
  it('a start turns voice on before the reload it starts has answered', () => {
    const { runtime, feed } = setup()
    feed.reload.mockClear()

    runtime.start('one')

    expect(system.voiceOn).toHaveBeenCalledTimes(1)
    expect(feed.reload).toHaveBeenCalledTimes(1)
    runtime.dispose()
  })

  it('a start with no config ever loaded does not turn voice on and says Banter can\'t be reached', () => {
    const { runtime, feed } = setup(null)
    feed.reload.mockClear()

    runtime.start('one')

    expect(system.voiceOn).not.toHaveBeenCalled()
    expect(runtime.ui.get().notice).toBe('Can\'t reach Banter at http://control.invalid:7000')
    expect(feed.reload).toHaveBeenCalledTimes(1)
    runtime.dispose()
  })

  it('a reload that changes the selection while voice is live reconfigures it, and one that does not change it leaves it alone', () => {
    const { runtime, land } = setup()
    useVoiceSystemStore.setState({ phase: 'live' })

    land(config('model-1'))
    expect(system.reconfigure).not.toHaveBeenCalled()

    land(config('model-2'))
    expect(system.reconfigure).toHaveBeenCalledTimes(1)
    expect(system.reconfigure.mock.calls[0]?.[0]).toMatchObject({ serviceId: 'tts-b', model: 'model-2' })

    land(config('model-2', 'stt-c'))
    expect(system.reconfigure).toHaveBeenCalledTimes(2)
    expect(system.reconfigure.mock.calls[1]?.[1]).toBe('stt-c')
    runtime.dispose()
  })

  it('a live reconfigure runs while the store still holds the config it replaces', () => {
    const { runtime, land } = setup()
    useVoiceSystemStore.setState({ phase: 'live' })
    let storedAtReconfigure: string | undefined
    system.reconfigure.mockImplementationOnce(() => {
      storedAtReconfigure = useVoiceSessionStore.getState().voiceConfig?.stt?.serviceId
    })

    land(config('model-1', 'stt-c'))

    expect(storedAtReconfigure).toBe('stt-a')
    expect(useVoiceSessionStore.getState().voiceConfig?.stt?.serviceId).toBe('stt-c')
    runtime.dispose()
  })

  it('a reload that lands while voice is starting reaches it by reconfiguring once voice is live', () => {
    const { runtime, land } = setup()
    useVoiceSystemStore.setState({ phase: 'starting' })

    land(config('model-2'))
    expect(system.reconfigure).not.toHaveBeenCalled()
    expect(useVoiceSessionStore.getState().voiceSelection).toMatchObject({ model: 'model-1' })

    useVoiceSystemStore.setState({ phase: 'live' })
    expect(system.reconfigure).toHaveBeenCalledTimes(1)
    expect(system.reconfigure.mock.calls[0]?.[0]).toMatchObject({ model: 'model-2' })
    expect(useVoiceSessionStore.getState().voiceSelection).toMatchObject({ model: 'model-2' })
    runtime.dispose()
  })

  it('a reload that changes the selection while voice is off does not reconfigure, and the next start uses it', () => {
    const { runtime, land } = setup()

    land(config('model-2'))

    expect(system.reconfigure).not.toHaveBeenCalled()
    expect(useVoiceSessionStore.getState().voiceSelection).toMatchObject({ serviceId: 'tts-b', model: 'model-2' })
    runtime.dispose()
  })
})
