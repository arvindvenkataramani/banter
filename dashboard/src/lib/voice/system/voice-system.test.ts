import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { VoiceSystem, useVoiceSystemStore } from './voice-system'
import type { VoiceSystemDeps, HumanSide, AgentSide } from './voice-system'
import { useTurnManagerStore, resetTurnManager, detachSession } from '../store/turn-manager-store'
import { useMuteStore, resetMutes } from '../human/mute-store'
import { useVoiceSessionStore, setVoiceConfig, setVoiceSelection, publishSession } from '../voice-session-store'
import type { VoiceConfig, VoiceSelection } from '../voice-config'
import type { SttTransport } from '../human/stt-transport'
import type { Session } from '../../session'

// Design record: docs/design/voice-system.md. The collaborators are fakes; the
// turn manager's mode, the mutes and the session store are the real stores.

// ── Fixtures ─────────────────────────────────────────────────────────────

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

const START_CLOCK = 10_000

function makeConfig(attempts = 3): VoiceConfig {
  return {
    tts: {
      providers: [
        { serviceId: 'tts-1', responseFormat: 'mp3', models: [{ id: 'model-a', key: 'model-a-key', voices: [{ id: 'v1', name: 'Voice One', key: 'v1-key' }] }] },
        { serviceId: 'tts-2', responseFormat: 'mp3', models: [{ id: 'model-b', key: 'model-b-key', voices: [{ id: 'v2', name: 'Voice Two', key: 'v2-key' }] }] },
      ],
    },
    stt: {
      serviceId: 'stt-1',
      model: 'stt-model',
      options: [{ serviceId: 'stt-1', name: 'STT One', sessions: true }],
      reconnect: { attempts, delayMs: 1000, stableMs: 10_000 },
    },
  }
}

const selection: VoiceSelection = {
  serviceId: 'tts-1', model: 'model-a', voice: 'v1', speed: 1,
  modelKey: 'model-a-key', voiceKey: 'v1-key', responseFormat: 'mp3',
}

const selection2: VoiceSelection = {
  serviceId: 'tts-2', model: 'model-b', voice: 'v2', speed: 1,
  modelKey: 'model-b-key', voiceKey: 'v2-key', responseFormat: 'mp3',
}

function makeSession(): Session {
  return {
    controls: { send: vi.fn().mockResolvedValue(undefined), abort: vi.fn().mockResolvedValue(undefined) },
  } as unknown as Session
}

function configure(session: Session | null = makeSession(), config: VoiceConfig = makeConfig()): void {
  setVoiceConfig(config)
  setVoiceSelection(selection)
  publishSession(session)
}

/** Covers an implementation that resumes on microtasks and one that defers
 * through a zero-delay timer. */
async function flush(): Promise<void> {
  for (let round = 0; round < 3; round++) {
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
}

interface TransportRecord {
  opts: Parameters<VoiceSystemDeps['createTransport']>[0]
  transport: SttTransport
}

function setup() {
  const log: string[] = []
  const held = new Set<string>()
  const pending: Record<string, Deferred<unknown>[]> = {}
  let clock = START_CLOCK
  let ids = 0
  const transports: TransportRecord[] = []

  /** Resolves at once unless the key is held; a held call waits for settle(). */
  function gated<T>(key: string, value: T): Promise<T> {
    if (!held.has(key)) return Promise.resolve(value)
    const d = deferred<T>()
    ;(pending[key] ??= []).push(d as Deferred<unknown>)
    return d.promise
  }

  const fakes = {
    devices: {
      acquire: vi.fn(() => { log.push('acquire'); return gated('acquire', true) }),
      release: vi.fn(() => { log.push('release') }),
    },
    tones: {
      play: vi.fn((name: 'attempted' | 'started' | 'ended') => {
        log.push(`tone:${name}`)
        return gated(`tone:${name}`, undefined)
      }),
    },
    player: { init: vi.fn(), reset: vi.fn(), release: vi.fn(), setConcurrency: vi.fn(), enqueueChat: vi.fn(), enqueueTone: vi.fn(), beginRun: vi.fn(), endRun: vi.fn(), cancel: vi.fn() },
    services: {
      ensureTtsReady: vi.fn((id: string) => gated('ensureTts', `https://${id}.test`)),
      ensureServiceReady: vi.fn((id: string) => gated('ensureStt', `https://${id}.test`)),
      loadTtsModel: vi.fn((_endpoint: string, _modelKey: string) => gated<void>('loadTts', undefined)),
      loadSttModel: vi.fn(() => Promise.resolve()),
      fetchSttModelFacts: vi.fn(() => Promise.resolve({ kind: 'batch' as const })),
      ping: vi.fn(() => Promise.resolve()),
    },
    loadModels: vi.fn(() => Promise.resolve({ vad: {} as never, smartTurn: {} as never })),
    createTransport: vi.fn(async (opts: TransportRecord['opts']) => {
      const transport: SttTransport = {
        onFrame: vi.fn(),
        commit: vi.fn(async () => ''),
        discard: vi.fn(async () => {}),
        setSending: vi.fn(),
        close: vi.fn(),
      }
      transports.push({ opts, transport })
      return transport
    }),
    createHuman: vi.fn((): HumanSide => {
      const human: HumanSide = {
        loop: { voiceConfig: null },
        transport: null,
        start: vi.fn(),
        stop: vi.fn(() => gated<void>('humanStop', undefined)),
        replaceTransport: vi.fn((t: SttTransport) => { human.transport = t; return true }),
        receivePartial: vi.fn(),
      }
      return human
    }),
    createAgent: vi.fn((_player: unknown): AgentSide => ({
      chunkConfig: { chunkStrategy: 'sentence', minChunkWords: undefined, maxChunkWords: undefined },
      ttsEndpoint: null,
      ttsSelection: null,
      attach: vi.fn(),
      detach: vi.fn(),
    })),
    notify: vi.fn((_message: string, _persistent?: boolean) => {}),
    now: vi.fn(() => clock),
    newSessionId: vi.fn(() => `s${++ids}`),
  }

  const sys = new VoiceSystem(fakes as unknown as VoiceSystemDeps)

  return {
    sys, fakes, log, transports,
    hold(...keys: string[]) { for (const k of keys) held.add(k) },
    settle(key: string, value?: unknown, index = 0) {
      const d = pending[key]?.[index]
      if (!d) throw new Error(`nothing pending for ${key}[${index}]`)
      d.resolve(value)
    },
    setClock(ms: number) { clock = ms },
    async tick(ms: number) {
      clock += ms
      await vi.advanceTimersByTimeAsync(ms)
      for (let i = 0; i < 20; i++) await Promise.resolve()
    },
  }
}

type Harness = ReturnType<typeof setup>

function state() { return useVoiceSystemStore.getState() }
function mode() { return useTurnManagerStore.getState().snapshot.mode }

async function goLive(h: Harness): Promise<void> {
  h.sys.voiceOn()
  await flush()
  expect(state().phase).toBe('live')
}

function resetStores(): void {
  detachSession()
  resetTurnManager()
  resetMutes()
  useVoiceSessionStore.setState({ session: null, voiceConfig: null, voiceSelection: null, ttsEndpoint: null, sttEndpoint: null })
}

let h: Harness

beforeEach(() => {
  vi.useFakeTimers()
  resetStores()
  useVoiceSystemStore.setState({ phase: 'off', sessionId: null, reconfiguring: false, lastEnd: null })
  h = setup()
})

afterEach(() => {
  h.sys.resetForTest()
  resetStores()
  vi.clearAllTimers()
  vi.useRealTimers()
})

// ── Tests ────────────────────────────────────────────────────────────────

describe('VoiceSystem', () => {
  it('voiceOn calls devices.acquire before it returns', () => {
    configure()
    h.sys.voiceOn()
    expect(h.fakes.devices.acquire).toHaveBeenCalledTimes(1)
  })

  it('voiceOff releases the microphone before the ended tone begins', async () => {
    configure()
    await goLive(h)
    h.sys.voiceOff()
    const release = h.log.indexOf('release')
    expect(release).toBeGreaterThanOrEqual(0)
    expect(h.log.indexOf('tone:ended')).toBeGreaterThan(release)
  })

  it('a start reaches phase live and reports mode live', async () => {
    configure()
    h.sys.voiceOn()
    await flush()
    expect(state().phase).toBe('live')
    expect(mode()).toBe('live')
  })

  it('a start stopped while its services are starting builds no sides, starts no heartbeat and opens no connection when it resumes', async () => {
    configure()
    h.hold('ensureTts', 'tone:ended')
    h.sys.voiceOn()
    await flush()

    // The start resumes while the stop is still ending.
    h.sys.voiceOff()
    h.settle('ensureTts', 'https://tts-1.test')
    await flush()
    await h.tick(120_000)
    h.settle('tone:ended')
    await flush()

    expect(h.fakes.createAgent).not.toHaveBeenCalled()
    expect(h.fakes.createHuman).not.toHaveBeenCalled()
    expect(h.fakes.services.ping).not.toHaveBeenCalled()
    expect(h.fakes.createTransport).not.toHaveBeenCalled()
    expect(state().phase).toBe('off')
  })

  it('a failed start tells the person, records start-failed, and ends with the microphone released, the ended tone played and phase off', async () => {
    configure(null)
    h.sys.voiceOn()
    await flush()
    expect(h.fakes.notify).toHaveBeenCalledWith(expect.stringContaining('Voice failed to start'))
    expect(state().lastEnd?.reason).toBe('start-failed')
    expect(h.fakes.devices.release).toHaveBeenCalledTimes(1)
    expect(h.fakes.tones.play).toHaveBeenCalledWith('ended')
    expect(state().phase).toBe('off')
  })

  it("voiceOn during the ended tone starts a new session that the old session's tone finishing cannot end", async () => {
    configure()
    await goLive(h)
    h.hold('tone:ended')
    h.sys.voiceOff()
    await flush()
    expect(state().phase).toBe('ending')

    h.sys.voiceOn()
    const newId = state().sessionId
    expect(newId).not.toBe('s1')
    expect(state().phase).toBe('starting')

    h.settle('tone:ended')
    await flush()
    expect(state().sessionId).toBe(newId)
    expect(state().phase).toBe('live')
    expect(mode()).toBe('live')
  })

  it('voiceOff reaches phase off and reports mode off only after both the human stop and the ended tone have settled', async () => {
    configure()
    await goLive(h)
    h.hold('humanStop', 'tone:ended')
    h.sys.voiceOff()

    h.settle('humanStop')
    await flush()
    expect(state().phase).toBe('ending')
    expect(mode()).toBe('ending')

    h.settle('tone:ended')
    await flush()
    expect(state().phase).toBe('off')
    expect(mode()).toBe('off')
  })

  it('voiceOff stays ending when the ended tone settles first, until the human stop settles too', async () => {
    configure()
    await goLive(h)
    h.hold('humanStop', 'tone:ended')
    h.sys.voiceOff()

    h.settle('tone:ended')
    await flush()
    expect(state().phase).toBe('ending')
    expect(mode()).toBe('ending')

    h.settle('humanStop')
    await flush()
    expect(state().phase).toBe('off')
    expect(mode()).toBe('off')
  })

  it('muting the mic while live reports muted, and unmuting reports live', async () => {
    configure()
    await goLive(h)
    useMuteStore.setState({ micMuted: true })
    expect(mode()).toBe('muted')
    useMuteStore.setState({ micMuted: false })
    expect(mode()).toBe('live')
  })

  it.each([
    { elapsed: 1999, plays: false },
    { elapsed: 2000, plays: true },
  ])('a start reaching readiness $elapsed ms after the tap plays the started tone: $plays', async ({ elapsed, plays }) => {
    configure()
    h.hold('tone:attempted')
    h.sys.voiceOn()
    await flush()
    h.setClock(START_CLOCK + elapsed)
    h.settle('tone:attempted')
    await flush()
    expect(h.fakes.tones.play.mock.calls.some(([name]) => name === 'started')).toBe(plays)
    expect(state().phase).toBe('live')
  })

  it('a dropped connection is replaced, and once failures exceed attempts voice ends with connection-lost and a persistent notice', async () => {
    configure(makeSession(), makeConfig(1))
    await goLive(h)
    const closed = { dropped: 0, code: null }

    h.transports[0].opts.onClosed('socket closed', closed)
    await flush()
    expect(h.transports).toHaveLength(2)
    expect(state().phase).toBe('live')

    h.transports[1].opts.onClosed('socket closed', closed)
    await flush()
    await h.tick(60_000)
    expect(h.transports).toHaveLength(2)
    expect(state().lastEnd?.reason).toBe('connection-lost')
    expect(h.fakes.notify).toHaveBeenCalledWith(expect.stringContaining('Voice transcription disconnected'), true)
    expect(state().phase).toBe('off')
  })

  it('a close with code superseded ends voice with superseded and opens no new connection', async () => {
    configure()
    await goLive(h)
    h.transports[0].opts.onClosed('taken over', { dropped: 0, code: 'superseded' })
    await flush()
    await h.tick(60_000)
    expect(h.transports).toHaveLength(1)
    expect(state().lastEnd?.reason).toBe('superseded')
    expect(state().phase).toBe('off')
  })

  it('a close with code held ends voice with held and opens no new connection', async () => {
    configure()
    await goLive(h)
    h.transports[0].opts.onClosed('held by another session', { dropped: 0, code: 'held' })
    await flush()
    await h.tick(60_000)
    expect(h.transports).toHaveLength(1)
    expect(state().lastEnd?.reason).toBe('held')
    expect(state().phase).toBe('off')
  })

  it('a close with code held on a service that does not declare sessions ends voice with connection-lost, not held', async () => {
    const config = makeConfig()
    configure(makeSession(), { ...config, stt: { ...config.stt, options: [{ serviceId: 'stt-1', name: 'STT One' }] } })
    await goLive(h)
    h.transports[0].opts.onClosed('held by another session', { dropped: 0, code: 'held' })
    await flush()
    await h.tick(60_000)
    expect(h.transports).toHaveLength(1)
    expect(state().lastEnd?.reason).toBe('connection-lost')
    expect(h.fakes.notify).toHaveBeenCalledWith(expect.stringContaining('Voice transcription disconnected'), true)
    expect(state().phase).toBe('off')
  })

  it('a session started to take over carries takeover and its session id on its first connection and on a reconnect', async () => {
    configure()
    h.sys.voiceOn({ takeover: true })
    await flush()
    expect(state().phase).toBe('live')
    const sessionId = state().sessionId
    expect(h.transports[0].opts).toMatchObject({ sessionId, takeover: true })

    h.transports[0].opts.onClosed('socket closed', { dropped: 0, code: null })
    await flush()
    expect(h.transports).toHaveLength(2)
    expect(h.transports[1].opts).toMatchObject({ sessionId, takeover: true })
  })

  it('a session started under the always-take-over preference carries takeover on its first connection', async () => {
    const config = makeConfig()
    configure(makeSession(), { ...config, takeover: 'always' })
    await goLive(h)
    expect(h.transports[0].opts.takeover).toBe(true)
  })

  it('a session whose STT service does not declare sessions passes no session id and no takeover, even when started to take over', async () => {
    const config = makeConfig()
    configure(makeSession(), { ...config, stt: { ...config.stt, options: [{ serviceId: 'stt-1', name: 'STT One' }] } })
    h.sys.voiceOn({ takeover: true })
    await flush()
    expect(state().phase).toBe('live')
    expect(h.transports[0].opts.sessionId).toBeUndefined()
    expect(h.transports[0].opts.takeover).toBe(false)
  })

  it('reconfigure under a live session readies the new TTS model without leaving live or restarting the session', async () => {
    configure()
    await goLive(h)
    h.sys.reconfigure(selection2, 'stt-1')
    await flush()
    expect(h.fakes.services.loadTtsModel).toHaveBeenLastCalledWith('https://tts-2.test', 'model-b-key')
    expect(state().reconfiguring).toBe(false)
    expect(state().phase).toBe('live')
    expect(state().sessionId).toBe('s1')
    expect(h.fakes.devices.acquire).toHaveBeenCalledTimes(1)
    expect(h.transports).toHaveLength(1)
  })
})
