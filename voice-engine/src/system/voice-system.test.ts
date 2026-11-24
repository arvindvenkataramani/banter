import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { VoiceSystem, useVoiceSystemStore } from './voice-system'
import type { VoiceSystemDeps, HumanSide, AgentSide } from './voice-system'
import { useTurnManagerStore, resetTurnManager, detachSession } from '../store/turn-manager-store'
import { useMuteStore, resetMutes } from '../human/mute-store'
import { useVoiceSessionStore, setVoiceConfig, setVoiceSelection, publishSession } from '../voice-session-store'
import type { VoiceConfig, VoiceSelection } from '../voice-config'
import type { SttTransport } from '../human/stt-transport'
import type { VoiceSession } from '../session'

// Design record: docs/reference/design/voice-system.md. The collaborators are fakes; the
// turn manager's mode, the mutes and the session store are the real stores. Model
// loads and unloads go through the shared adapters to `fetch`, which the harness
// records. The served config follows docs/reference/design/service-apis.md, "Provisions": each TTS
// provider and STT option carries `provides` and `models`, an STT option lists what
// it `serves` as `{ model, key }`, and `stt.models` holds the roster's models.

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

const SPEECH = { api: 'openai.audio.speech' }
const STREAM = { api: 'fluid.stt.stream' }
const TRANSCRIBE = { api: 'openai.audio.transcriptions' }
const REPOSITORY = { api: 'triton.model-repository', extends: ['resident-slot'] }
const NO_LOADING = { loading: 'none' }
const ALWAYS = { loading: 'required', autoLoad: 'always', resident: 'one' }

interface ConfigShape {
  attempts?: number
  /** The kind the roster declares for the STT model. */
  sttKind?: 'batch' | 'streaming' | 'both'
  sttProvides?: unknown[]
  sttLoading?: unknown
  /** Further fields of the STT model entry, such as `params` and `variants`. */
  sttModel?: Record<string, unknown>
  ttsProvides?: unknown[]
  ttsLoading?: unknown
  ttsProvider?: Record<string, unknown>
  preload?: boolean
  extra?: Record<string, unknown>
  stt?: Record<string, unknown>
}

function makeConfig(shape: ConfigShape = {}): VoiceConfig {
  const { attempts = 3, sttKind = 'streaming', sttProvides = [STREAM, TRANSCRIBE], sttLoading = NO_LOADING } = shape
  const ttsProvides = shape.ttsProvides ?? [SPEECH]
  const ttsLoading = shape.ttsLoading ?? NO_LOADING
  return {
    ...(shape.preload !== undefined ? { preload: shape.preload } : {}),
    tts: {
      providers: [
        { serviceId: 'tts-1', provides: ttsProvides, models: ttsLoading, serves: [{ model: 'model-a', key: 'model-a-key' }, { model: 'model-c', key: 'model-c-key' }], ...shape.ttsProvider },
        { serviceId: 'tts-2', provides: ttsProvides, models: ttsLoading, serves: [{ model: 'model-b', key: 'model-b-key' }] },
      ],
      models: [{ id: 'model-a', name: 'Model A', canClone: false }, { id: 'model-b', name: 'Model B', canClone: false }, { id: 'model-c', name: 'Model C', canClone: false }],
      voices: [
        { id: 'v1', name: 'Voice One', renderings: [{ model: 'model-a', method: 'preset' }] },
        { id: 'v2', name: 'Voice Two', renderings: [{ model: 'model-b', method: 'preset' }] },
      ],
    },
    stt: {
      serviceId: 'stt-1',
      model: 'stt-model',
      options: [{ serviceId: 'stt-1', name: 'STT One', provides: sttProvides, models: sttLoading, serves: [{ model: 'stt-model', key: 'stt-model-key' }] }],
      models: [{ id: 'stt-model', kind: sttKind, ...shape.sttModel }],
      reconnect: { attempts, delayMs: 1000, stableMs: 10_000 },
      ...shape.stt,
    },
    ...shape.extra,
  } as unknown as VoiceConfig
}

const asSelection = (value: unknown) => value as VoiceSelection

const selection = asSelection({
  serviceId: 'tts-1', model: 'model-a', voice: 'v1', speed: 1,
  resolution: { model: 'model-a-key', voice: { name: 'v1-key' } },
})

const selection2 = asSelection({
  serviceId: 'tts-2', model: 'model-b', voice: 'v2', speed: 1,
  resolution: { model: 'model-b-key', voice: { name: 'v2-key' } },
})

function makeSession(): VoiceSession {
  return {
    controls: { send: vi.fn().mockResolvedValue(undefined), abort: vi.fn().mockResolvedValue(undefined) },
  } as unknown as VoiceSession
}

function configure(session: VoiceSession | null = makeSession(), config: VoiceConfig = makeConfig()): void {
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

interface FetchCall {
  url: URL
  method: string
  body: Record<string, unknown> | undefined
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

  // Every model load and unload is a request the shared adapters make, so the
  // calls recorded here are the ones the system decided on. Nothing else in
  // these tests reaches `fetch`: the transports, the player and the pings are fakes.
  const fetchCalls: FetchCall[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
    fetchCalls.push({ url: new URL(String(input)), method: init?.method ?? 'GET', body })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }))

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
    sys, fakes, log, transports, fetchCalls,
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
  vi.unstubAllGlobals()
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

  it('[T2] a live start publishes the transcription mode in use and what decided it, and voice ending clears it', async () => {
    configure(makeSession(), makeConfig({ sttKind: 'batch', stt: { preferStreaming: true } }))
    expect(state().stt).toBeNull()

    await goLive(h)
    // The roster declares the model batch, so the model decides, whatever the choice says.
    expect(state().stt).toEqual({ mode: 'batch', decidedBy: 'model', model: 'stt-model' })

    h.sys.voiceOff()
    await flush()
    expect(state().phase).toBe('off')
    expect(state().stt).toBeNull()
  })

  it('[T2] for a model the roster declares as doing both, the published mode follows the choice and says so', async () => {
    configure(makeSession(), makeConfig({ sttKind: 'both', stt: { preferStreaming: true } }))

    await goLive(h)

    expect(state().stt).toEqual({ mode: 'streaming', decidedBy: 'choice', model: 'stt-model' })
  })

  it('[T2] the transcription transport is built for the selected provision, naming the model by the serving\'s key', async () => {
    configure()
    await goLive(h)

    expect(h.transports[0].opts.model).toBe('stt-model-key')
    expect(h.transports[0].opts.mode).toBe('streaming')
    // INVENTED: the options carry the `provision` the selection chose.
    expect((h.transports[0].opts as unknown as { provision: { api: string } }).provision.api).toBe('fluid.stt.stream')
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
    configure(makeSession(), makeConfig({ attempts: 1 }))
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

  it('[T2] a close with code held on a provision that omits the session parameter ends voice with connection-lost, not held', async () => {
    configure(makeSession(), makeConfig({ sttProvides: [{ ...STREAM, omits: ['parameter:session'] }, TRANSCRIBE] }))
    await goLive(h)
    h.transports[0].opts.onClosed('held by another session', { dropped: 0, code: 'held' })
    await flush()
    await h.tick(60_000)
    expect(h.transports).toHaveLength(1)
    expect(state().lastEnd?.reason).toBe('connection-lost')
    expect(h.fakes.notify).toHaveBeenCalledWith(expect.stringContaining('Voice transcription disconnected'), true)
    expect(state().phase).toBe('off')
  })

  it('[T2] a session started to take over carries takeover and its session id on its first connection and on a reconnect', async () => {
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

  it('[T2] a session started under the always-take-over preference carries takeover on its first connection', async () => {
    configure(makeSession(), makeConfig({ extra: { takeover: 'always' } }))
    await goLive(h)
    expect(h.transports[0].opts.takeover).toBe(true)
  })

  it('[T2] a session whose selected provision omits the session parameter passes no session id and no takeover, even when started to take over', async () => {
    configure(makeSession(), makeConfig({ sttProvides: [{ ...STREAM, omits: ['parameter:session'] }, TRANSCRIBE] }))
    h.sys.voiceOn({ takeover: true })
    await flush()
    expect(state().phase).toBe('live')
    expect(h.transports[0].opts.sessionId).toBeUndefined()
    expect(h.transports[0].opts.takeover).toBe(false)
  })

  it('[T2] reconfigure under a live session readies the new TTS model without leaving live or restarting the session', async () => {
    configure(makeSession(), makeConfig({ ttsProvides: [SPEECH, REPOSITORY], ttsLoading: ALWAYS }))
    await goLive(h)
    h.fetchCalls.length = 0
    h.sys.reconfigure(selection2, 'stt-1')
    await flush()

    const loads = h.fetchCalls.filter((c) => c.url.origin === 'https://tts-2.test')
    expect(loads).toHaveLength(1)
    expect(loads[0].url.pathname).toContain('/models/model-b-key/load')
    expect(state().reconfiguring).toBe(false)
    expect(state().phase).toBe('live')
    expect(state().sessionId).toBe('s1')
    expect(h.fakes.devices.acquire).toHaveBeenCalledTimes(1)
    expect(h.transports).toHaveLength(1)
  })

  it('[T2] reconfiguring to a selection the shard could not resolve reports that voice cannot speak, and loads nothing', async () => {
    configure(makeSession(), makeConfig({ ttsProvides: [SPEECH, REPOSITORY], ttsLoading: ALWAYS }))
    await goLive(h)
    const loads = h.fetchCalls.length
    const { resolution: _none, ...unresolved } = selection2 as unknown as Record<string, unknown>
    h.sys.reconfigure(asSelection({ ...unresolved, resolutionError: 'shard unreachable' }), 'stt-1')
    await flush()
    expect(h.fakes.notify).toHaveBeenCalledWith('Voice cannot speak: shard unreachable')
    expect(h.fetchCalls).toHaveLength(loads)
  })
})

// Loading and unloading follow what the services declare (decideLoad and decideUnload,
// docs/reference/design/service-apis.md, "Model loading"), performed through the adapters. The calls
// recorded are the requests those adapters made. Generic paths stand in for any
// declared call, and the repository route is recognised by its model segment.
describe('VoiceSystem model loads', () => {
  const on = (origin: string) => h.fetchCalls.filter((c) => c.url.origin === origin)
  const warm = { method: 'POST', path: '/admin/warm', query: { name: '{model}' } }
  const evict = { method: 'DELETE', path: '/admin/warm', query: { name: '{model}' } }

  it('[T2] a service that declares no loading is never loaded', async () => {
    configure()
    await goLive(h)
    expect(h.fetchCalls).toHaveLength(0)
  })

  // decideLoad's rows are tested in shared/apis/loading.test.ts; the engine adds that an
  // absent preference is on, and that the load goes through the adapter by the serving's key.
  it('[T2] with no preload preference, a service that loads on request is loaded explicitly once, by its serving\'s key', async () => {
    configure(makeSession(), makeConfig({ preload: undefined, ttsProvides: [SPEECH, REPOSITORY], ttsLoading: ALWAYS }))
    await goLive(h)

    const calls = on('https://tts-1.test')
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url.pathname).toContain('/models/model-a-key/load')
  })

  it('[T2] a refused load keeps voice from going live and shows the server\'s own message', async () => {
    configure(makeSession(), makeConfig({ ttsProvides: [SPEECH, REPOSITORY], ttsLoading: ALWAYS }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'its weights are not on this machine' }), { status: 409, headers: { 'content-type': 'application/json' } })))

    h.sys.voiceOn()
    await flush()

    expect(state().phase).not.toBe('live')
    const messages = h.fakes.notify.mock.calls.map((c: unknown[]) => String(c[0]))
    expect(messages.some((m: string) => m.includes('its weights are not on this machine'))).toBe(true)
  })

  it('[T2] the TTS load names the model as its synthesis does: the roster id for a provider that resolves voices', async () => {
    configure(makeSession(), makeConfig({ ttsProvides: [SPEECH, REPOSITORY], ttsLoading: ALWAYS, ttsProvider: { resolvesVoices: true } }))
    setVoiceSelection(asSelection({ ...selection, resolution: { model: 'model-a', voice: { name: 'v1-key' } } }))
    await goLive(h)

    const calls = on('https://tts-1.test')
    expect(calls).toHaveLength(1)
    expect(calls[0].url.pathname).toContain('/models/model-a/load')
  })

  it('[T2] a streaming model with latency tiers is loaded by the serving\'s key, in streaming mode and naming the variant for the configured tier', async () => {
    const tiers = {
      params: [{ name: 'chunkMs', values: [560, 1120] }],
      variants: [
        { id: '560ms', params: [{ name: 'chunkMs', value: 560 }] },
        { id: '1120ms', params: [{ name: 'chunkMs', value: 1120 }] },
      ],
    }
    configure(makeSession(), makeConfig({ sttKind: 'streaming', sttProvides: [STREAM, REPOSITORY], sttLoading: ALWAYS, sttModel: tiers, stt: { chunkMs: 1120 } }))
    await goLive(h)

    const calls = on('https://stt-1.test')
    expect(calls).toHaveLength(1)
    expect(calls[0].url.pathname).toContain('/models/stt-model-key/load')
    expect(calls[0].body).toEqual({ parameters: { mode: 'streaming', variant: '1120ms' } })
  })

  describe('on a model change', () => {
    const many = { loading: 'required', autoLoad: 'always', resident: 'many', load: warm, unload: evict }
    const other = asSelection({ serviceId: 'tts-1', model: 'model-c', voice: 'v1', speed: 1, resolution: { model: 'model-c-key', voice: { name: 'v1-key' } } })
    const sameModel = asSelection({ ...selection, voice: 'v2' })

    // INVENTED: `reconfigure` is called while the session store still holds the
    // selection being left, which is where the model to unload is read from.
    it('[T2] a service that keeps several models resident has the one being left unloaded, and the new one loaded', async () => {
      configure(makeSession(), makeConfig({ ttsLoading: many }))
      await goLive(h)
      h.fetchCalls.length = 0

      h.sys.reconfigure(other, 'stt-1')
      await flush()

      const unloads = h.fetchCalls.filter((c) => c.method === 'DELETE')
      expect(unloads).toHaveLength(1)
      expect(unloads[0].url.searchParams.get('name')).toBe('model-a-key')
      expect(h.fetchCalls.some((c) => c.method === 'POST' && c.url.searchParams.get('name') === 'model-c-key')).toBe(true)
    })

    it('[T2] a change of voice alone unloads nothing', async () => {
      configure(makeSession(), makeConfig({ ttsLoading: many }))
      await goLive(h)
      h.fetchCalls.length = 0

      h.sys.reconfigure(sameModel, 'stt-1')
      await flush()

      expect(h.fetchCalls.some((c) => c.method === 'DELETE')).toBe(false)
    })
  })
})
