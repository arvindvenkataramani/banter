import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useVoiceSystemStore } from '@platform/voice-engine/system/voice-system'
import { editTranscript, useTranscriptStore } from '@platform/voice-engine/store/transcript-store'
import type { DshClientContext, DshConfigForm, DshObservable } from './dsh-types'
import type { DraftMirror } from './draft-mirror'
import type { ShownSession } from './shown-session'
import type { VoiceSessionDeps } from './session-adapter'

// The runtime is real. Its edges are stand-ins: the session adapter records the
// deps the runtime hands it, the voice system is inert, and dsh's context is a
// few observables.

const adapterDeps = new Map<string, VoiceSessionDeps>()
vi.mock('./session-adapter.ts', () => ({
  createVoiceSession: (session: { sessionId: string }, deps: VoiceSessionDeps) => {
    adapterDeps.set(session.sessionId, deps)
    return { dispose: vi.fn() }
  },
}))
vi.mock('./system.ts', () => ({
  createVoiceSystem: () => ({ voiceOn: vi.fn(), voiceOff: vi.fn(), reconfigure: vi.fn() }),
}))
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

function setup() {
  const shown = observable<ShownSession>({ sessionId: 'one', panelOpen: false })
  const ctx = {
    sessions: {
      retain: (sessionId: string) => ({
        binding: { session: { sessionId, prompt: vi.fn(), cancel: vi.fn() }, eventSource: {} },
        release: vi.fn(),
      }),
    },
  } as unknown as DshClientContext
  const form = observable({ status: 'loading', value: undefined, revision: undefined, writable: false }) as unknown as DshConfigForm<never>
  const runtime = createVoiceRuntime({ ctx, shown, form, origin: 'http://host' })
  return { runtime, shown }
}

const fakeBox = () => ({ restore: vi.fn(), snapshot: vi.fn() }) as unknown as DraftMirror & { restore: ReturnType<typeof vi.fn> }
const transcript = () => useTranscriptStore.getState().settled

beforeEach(() => {
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal('fetch', vi.fn(async () => ({})))
  adapterDeps.clear()
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
