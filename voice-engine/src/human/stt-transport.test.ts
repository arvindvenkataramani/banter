import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const transcribeAudio = vi.fn(() => Promise.resolve('batch transcript'))
const ensureServiceReady = vi.fn(() => Promise.resolve('https://moved:8767'))
vi.mock('./stt-client', () => ({
  transcribeAudio: (...args: unknown[]) => transcribeAudio(...(args as [])),
  setSaveMicSamples: vi.fn(),
}))

import { select } from '@platform/shared/apis/select'
import { BatchSttTransport } from './stt-transport-batch'
import { StreamingSttTransport } from './stt-transport-streaming'

const BATCH = { api: 'openai.audio.transcriptions' } as never
/** What the selection returns for a service providing the stream socket: its provision and adapter. */
const STREAM_SELECTION = (select as unknown as (...args: unknown[]) => { provision: unknown; adapter: unknown })(
  'transcribeStream',
  { id: 'stt-a', provides: [{ api: 'fluid.stt.stream' }], models: undefined },
  ['client-endpointing'],
  [],
)

/** A WebSocket whose lifecycle the test drives. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3

  readyState: number = FakeWebSocket.CONNECTING
  binaryType = ''
  sent: Array<string | ArrayBuffer> = []
  onmessage: ((e: MessageEvent) => void) | null = null
  onclose: ((e: CloseEvent) => void) | null = null
  onerror: (() => void) | null = null
  onopen: (() => void) | null = null

  readonly url: string
  constructor(url: string) { this.url = String(url); FakeWebSocket.instances.push(this) }
  send(data: string | ArrayBuffer): void { this.sent.push(data) }
  close(): void { this.readyState = FakeWebSocket.CLOSED }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }
  deliver(msg: unknown): void { this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent) }
  drop(reason = 'gone'): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ reason } as CloseEvent)
  }

  get textFrames(): string[] { return this.sent.filter((f): f is string => typeof f === 'string') }
  get binaryFrames(): ArrayBuffer[] { return this.sent.filter((f): f is ArrayBuffer => typeof f !== 'string') }
}

beforeEach(() => {
  FakeWebSocket.instances = []
  vi.clearAllMocks()
  vi.stubGlobal('WebSocket', FakeWebSocket)
  // No AudioEncoder in jsdom, so the encoder falls back to pcm16 — which is
  // the path being tested here anyway: that frames reach the socket at all.
  vi.stubGlobal('AudioEncoder', undefined)
})

afterEach(() => { vi.unstubAllGlobals() })

describe('the batch transport', () => {
  it('does nothing per frame, and nothing on discard', async () => {
    const t = new BatchSttTransport({ endpoint: 'https://host:8767', provision: BATCH })
    t.onFrame(new Float32Array(512))
    t.setSending(false)
    await t.discard()

    // Discarding is free here: the audio never left the device, so there is
    // no server context to clear.
    expect(transcribeAudio).not.toHaveBeenCalled()
  })

  it('posts the utterance on commit', async () => {
    const t = new BatchSttTransport({ endpoint: 'https://host:8767', provision: BATCH })
    expect(await t.commit(new Float32Array(16000))).toBe('batch transcript')
    expect(transcribeAudio).toHaveBeenCalledTimes(1)
  })

  it('restarts a stopped service once and retries', async () => {
    transcribeAudio
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce('after the restart')

    const onEndpointChange = vi.fn()
    const t = new BatchSttTransport({
      endpoint: 'https://host:8767',
      provision: BATCH,
      serviceId: 'stt-fluid',
      ensureServiceReady,
      onEndpointChange,
    })

    expect(await t.commit(new Float32Array(16000))).toBe('after the restart')
    expect(ensureServiceReady).toHaveBeenCalledTimes(1)
    expect(onEndpointChange).toHaveBeenCalledWith('https://moved:8767')
  })

  it('names both attempts when the retry fails differently', async () => {
    transcribeAudio
      .mockRejectedValueOnce(new Error('first reason'))
      .mockRejectedValueOnce(new Error('second reason'))

    const t = new BatchSttTransport({ endpoint: 'https://host:8767', provision: BATCH, serviceId: 'stt-fluid', ensureServiceReady })

    // Reporting only the second hides that the endpoint changed in between.
    await expect(t.commit(new Float32Array(16000))).rejects.toThrow(/second reason.*first reason/s)
  })
})

describe('the streaming transport', () => {
  // INVENTED: the transport takes the selection's result as `provision` and `adapter`,
  // and no `format`: the encoding follows the provision and the browser.
  function connect() {
    const onPartial = vi.fn()
    const onClosed = vi.fn()
    const t = new StreamingSttTransport({
      endpoint: 'https://host:8767',
      model: 'parakeet-unified-0.6b-streaming',
      ...STREAM_SELECTION,
      onPartial,
      onClosed,
    } as never)
    const ws = FakeWebSocket.instances.at(-1)!
    ws.open()
    return { t, ws, onPartial, onClosed }
  }

  it('sends captured frames', () => {
    const { t, ws } = connect()
    t.onFrame(new Float32Array(512))
    expect(ws.binaryFrames).toHaveLength(1)
  })

  it('stops sending while muted, and keeps the connection', () => {
    const { t, ws } = connect()
    t.setSending(false)
    t.onFrame(new Float32Array(512))

    expect(ws.binaryFrames).toHaveLength(0)
    expect(ws.readyState).toBe(FakeWebSocket.OPEN)
  })

  it('resolves commit with the settled transcript', async () => {
    const { t, ws } = connect()
    const settled = t.commit(new Float32Array(0))

    expect(ws.textFrames.some((f) => f.includes('Finalize'))).toBe(true)
    ws.deliver({ type: 'transcript', is_final: true, text: 'what was said' })

    expect(await settled).toBe('what was said')
  })

  it('finalizes on discard, so the audio does not reach the next turn', async () => {
    const { t, ws } = connect()
    const done = t.discard()
    ws.deliver({ type: 'transcript', is_final: true, text: 'rejected noise' })
    await done

    // The transcript is thrown away; the reset it performs is the point.
    expect(ws.textFrames.filter((f) => f.includes('Finalize'))).toHaveLength(1)
  })

  it('reports partials as they arrive', () => {
    const { ws, onPartial } = connect()
    ws.deliver({ type: 'transcript', is_final: false, text: 'so far' })
    expect(onPartial).toHaveBeenCalledWith('so far')
  })

  it('rejects an in-flight commit when the socket dies', async () => {
    const { t, ws, onClosed } = connect()
    const settled = t.commit(new Float32Array(0))
    ws.drop('the tab went away')

    // Everything was sent and the server had it; resolving empty would read
    // as "you said nothing" rather than "this was lost".
    await expect(settled).rejects.toThrow(/the tab went away/)
    expect(onClosed).toHaveBeenCalled()
  })

  it('refuses to commit once closed', async () => {
    const { t } = connect()
    t.close()
    await expect(t.commit(new Float32Array(0))).rejects.toThrow(/closed/)
  })
})

describe('the audio the streaming transport sends', () => {
  /** The smallest AudioEncoder and AudioData the Opus encoder path constructs. */
  class FakeAudioEncoder {
    state = 'unconfigured'
    constructor(_init: unknown) {}
    configure(): void { this.state = 'configured' }
    encode(): void {}
    close(): void { this.state = 'closed' }
  }
  class FakeAudioData {
    constructor(_init: unknown) {}
    close(): void {}
  }

  function opened(): FakeWebSocket {
    new StreamingSttTransport({
      endpoint: 'https://host:8767',
      model: 'parakeet-unified-0.6b-streaming',
      ...STREAM_SELECTION,
      onPartial: vi.fn(),
      onClosed: vi.fn(),
    } as never)
    return FakeWebSocket.instances.at(-1)!
  }

  it('[T2] is Opus when the provision holds opus and the browser can encode it', () => {
    vi.stubGlobal('AudioEncoder', FakeAudioEncoder)
    vi.stubGlobal('AudioData', FakeAudioData)

    expect(new URL(opened().url).searchParams.get('format')).toBe('opus')
  })

  // Spec section 6: pcm16 listed before opus in voice.stt.encodings means pcm16 is sent
  // even to a provision that accepts Opus. INVENTED: the transport takes the list as
  // its `encodings` option.
  it('[T2] is pcm16 when voice.stt.encodings lists pcm16 first, even where Opus could be sent', () => {
    vi.stubGlobal('AudioEncoder', FakeAudioEncoder)
    vi.stubGlobal('AudioData', FakeAudioData)
    new StreamingSttTransport({
      endpoint: 'https://host:8767',
      model: 'parakeet-unified-0.6b-streaming',
      ...STREAM_SELECTION,
      encodings: ['pcm16', 'opus'],
      onPartial: vi.fn(),
      onClosed: vi.fn(),
    } as never)
    expect(new URL(FakeWebSocket.instances.at(-1)!.url).searchParams.get('format')).toBe('pcm16')
  })

  it('[T2] is pcm16 when the browser cannot encode Opus', () => {
    // beforeEach leaves AudioEncoder undefined, as jsdom has it.
    expect(new URL(opened().url).searchParams.get('format')).toBe('pcm16')
  })
})
