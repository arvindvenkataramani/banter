import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { select } from '@platform/shared/apis/select'
import { StreamingSttTransport } from './stt-transport-streaming'

// The streaming transport sends Opus only when the selected provision holds the opus
// capability and the browser can encode it (docs/reference/design/service-apis.md, "Provisions").
// The Deepgram live provision holds it through `opus-packets`, so one that lacks the
// extension is sent linear16 even from a browser that can encode Opus. The transport
// takes the selection's `provision` and `adapter`, as stt-transport.test.ts has it.

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  readyState: number = FakeWebSocket.CONNECTING
  binaryType = ''
  onmessage: unknown = null
  onclose: unknown = null
  onerror: unknown = null
  onopen: unknown = null
  readonly url: string
  constructor(url: string) { this.url = String(url); FakeWebSocket.instances.push(this) }
  send(): void {}
  close(): void { this.readyState = FakeWebSocket.CLOSED }
  addEventListener(): void {}
  removeEventListener(): void {}
}

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

beforeEach(() => {
  FakeWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal('AudioEncoder', FakeAudioEncoder)
  vi.stubGlobal('AudioData', FakeAudioData)
})

afterEach(() => { vi.unstubAllGlobals() })

function open(extensions: string[]): URL {
  const provides = [{ api: 'deepgram.listen.live', extends: ['endpointing-off', ...extensions] }]
  const chosen = (select as unknown as (...args: unknown[]) => { provision: unknown; adapter: unknown })(
    'transcribeStream',
    { id: 'stt-a', provides, models: undefined },
    ['client-endpointing'],
    [],
  )
  new StreamingSttTransport({
    endpoint: 'https://host:8767',
    model: 'opaque-key',
    ...chosen,
    onPartial: vi.fn(),
    onClosed: vi.fn(),
  } as never)
  return new URL(FakeWebSocket.instances.at(-1)!.url)
}

describe('the encoding the streaming transport asks a Deepgram live provision for', () => {
  it('[T3] is opus when the provision declares opus-packets and the browser can encode it', () => {
    expect(open(['opus-packets']).searchParams.get('encoding')).toBe('opus')
  })

  it('[T3] is linear16 when the provision does not declare opus-packets, though the browser can encode Opus', () => {
    expect(open([]).searchParams.get('encoding')).toBe('linear16')
  })
})
