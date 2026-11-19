import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SttSocket } from './stt-socket'

/** A WebSocket whose lifecycle the test drives. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3

  // Starts connecting, as a real socket does. Audio captured before `open()`
  // is what the pre-open hold exists for, and a fake that starts open cannot
  // exercise it.
  readyState: number = FakeWebSocket.CONNECTING
  binaryType = ''
  sent: Array<string | ArrayBuffer> = []
  onmessage: ((e: MessageEvent) => void) | null = null
  onclose: ((e: CloseEvent) => void) | null = null
  onerror: (() => void) | null = null
  onopen: (() => void) | null = null

  readonly url: string

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
  }

  // ── Test drivers ──
  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  deliver(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent)
  }

  drop(reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ reason } as CloseEvent)
  }

  get textFrames(): string[] {
    return this.sent.filter((f): f is string => typeof f === 'string')
  }

  get binaryFrames(): ArrayBuffer[] {
    return this.sent.filter((f): f is ArrayBuffer => typeof f !== 'string')
  }
}

function connect() {
  const cb = {
    onPartial: vi.fn(),
    onFinal: vi.fn(),
    onReady: vi.fn(),
    onClosed: vi.fn(),
  }
  const socket = new SttSocket(cb)
  socket.connect({ endpoint: 'https://host:8767', model: 'test-model', format: 'opus' })
  const ws = FakeWebSocket.instances.at(-1)!
  ws.open()
  return { socket, ws, cb }
}

beforeEach(() => {
  FakeWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('connection', () => {
  it('asserts the model and format in the URL', () => {
    const { ws } = connect()
    expect(ws.url).toBe(
      'wss://host:8767/v1/audio/stream?model=test-model&format=opus',
    )
  })

  it('reports the server transcripts', () => {
    const { ws, cb } = connect()
    ws.deliver({ type: 'transcript', is_final: false, text: 'partial text' })
    ws.deliver({ type: 'transcript', is_final: true, text: 'settled text' })

    expect(cb.onPartial).toHaveBeenCalledWith('partial text')
    // No Finalize was sent, so there is no wait to report.
    expect(cb.onFinal).toHaveBeenCalledWith('settled text', null)
  })
})

describe('audio captured before the socket opens', () => {
  /** Connect without opening, so frames arrive during the handshake. */
  function connecting() {
    const cb = { onPartial: vi.fn(), onFinal: vi.fn(), onReady: vi.fn(), onClosed: vi.fn() }
    const socket = new SttSocket(cb)
    socket.connect({ endpoint: 'https://host:8767', model: 'test-model', format: 'opus' })
    return { socket, ws: FakeWebSocket.instances.at(-1)!, cb }
  }

  it('sends it once the socket is open, rather than dropping it', () => {
    const { socket, ws } = connecting()
    socket.sendAudio(new ArrayBuffer(8))
    socket.sendAudio(new ArrayBuffer(8))
    expect(ws.binaryFrames).toHaveLength(0)

    ws.open()

    // Capture starts before the handshake finishes; dropping here loses the
    // beginning of the first turn.
    expect(ws.binaryFrames).toHaveLength(2)
  })

  it('keeps the held frames ahead of what follows them', () => {
    const { socket, ws } = connecting()
    const first = new ArrayBuffer(1)
    socket.sendAudio(first)
    ws.open()
    socket.sendAudio(new ArrayBuffer(2))

    expect(ws.binaryFrames[0]).toBe(first)
    expect(ws.binaryFrames).toHaveLength(2)
  })

  it('holds nothing while muted', () => {
    const { socket, ws } = connecting()
    socket.setSending(false)
    socket.sendAudio(new ArrayBuffer(8))
    ws.open()

    expect(ws.binaryFrames).toHaveLength(0)
  })

  it('bounds what it holds, so a socket that never opens cannot grow it', () => {
    const { socket, ws } = connecting()
    for (let i = 0; i < 200; i++) socket.sendAudio(new ArrayBuffer(8))
    ws.open()

    expect(ws.binaryFrames.length).toBeLessThanOrEqual(24)
  })
})

describe('audio transmission', () => {
  it('sends captured frames while unmuted', () => {
    const { socket, ws } = connect()
    socket.sendAudio(new ArrayBuffer(8))

    expect(ws.binaryFrames).toHaveLength(1)
  })

  it('stops sending audio while muted', () => {
    const { socket, ws } = connect()
    socket.setSending(false)
    socket.sendAudio(new ArrayBuffer(8))

    expect(ws.binaryFrames).toHaveLength(0)
  })

  it('resumes sending on unmute', () => {
    const { socket, ws } = connect()
    socket.setSending(false)
    socket.sendAudio(new ArrayBuffer(8))
    socket.setSending(true)
    socket.sendAudio(new ArrayBuffer(8))

    expect(ws.binaryFrames).toHaveLength(1)
  })

  it('keeps sending KeepAlive while muted', () => {
    const { socket, ws } = connect()
    socket.setSending(false)
    vi.advanceTimersByTime(4000)

    expect(ws.textFrames).toContain(JSON.stringify({ type: 'KeepAlive' }))
  })
})

describe('turn end', () => {
  it('sends Finalize and leaves the socket open', () => {
    const { socket, ws } = connect()
    socket.finalize()

    expect(ws.textFrames).toEqual([JSON.stringify({ type: 'Finalize' })])
    expect(socket.isOpen).toBe(true)
  })

  it('reports how long the settled transcript took to come back', () => {
    const { socket, ws, cb } = connect()
    socket.finalize()
    ws.deliver({ type: 'transcript', is_final: true, text: 'done' })

    const [, waitMs] = cb.onFinal.mock.calls[0]
    expect(typeof waitMs).toBe('number')
    expect(waitMs).toBeGreaterThanOrEqual(0)
  })

  it('does not attribute a second final to the first Finalize', () => {
    const { socket, ws, cb } = connect()
    socket.finalize()
    ws.deliver({ type: 'transcript', is_final: true, text: 'first' })
    // A final with no Finalize outstanding has no wait to report rather than
    // one measured from the previous turn.
    ws.deliver({ type: 'transcript', is_final: true, text: 'second' })

    expect(cb.onFinal.mock.calls[1][1]).toBeNull()
  })
})

describe('a closed socket ends the session', () => {
  it('reports a dropped connection once', () => {
    const { ws, cb } = connect()
    ws.drop('going away')

    expect(cb.onClosed).toHaveBeenCalledTimes(1)
    expect(cb.onClosed.mock.calls[0][0]).toContain('going away')
  })

  it('reports an error frame by its own message, not the close that follows', () => {
    const { ws, cb } = connect()
    ws.deliver({ type: 'error', message: 'no model is loaded' })
    ws.drop()

    expect(cb.onClosed).toHaveBeenCalledTimes(1)
    expect(cb.onClosed.mock.calls[0][0]).toContain('no model is loaded')
  })

  it('reports once when a failed connection fires both error and close', () => {
    const { ws, cb } = connect()
    ws.onerror?.()
    ws.drop()

    expect(cb.onClosed).toHaveBeenCalledTimes(1)
  })

  it('stops the keepalive, so nothing is sent after the session ends', () => {
    const { ws, cb } = connect()
    ws.drop()
    const after = ws.sent.length
    vi.advanceTimersByTime(20000)

    expect(ws.sent).toHaveLength(after)
    expect(cb.onClosed).toHaveBeenCalledTimes(1)
  })

  it('sends no audio once closed', () => {
    const { socket, ws } = connect()
    ws.drop()
    socket.sendAudio(new ArrayBuffer(8))

    expect(ws.binaryFrames).toHaveLength(0)
  })

  it('sends CloseStream on a deliberate close and discards the reply', () => {
    const { socket, ws, cb } = connect()
    socket.close()
    ws.deliver({ type: 'transcript', is_final: true, text: 'too late' })

    expect(ws.textFrames).toContain(JSON.stringify({ type: 'CloseStream' }))
    expect(cb.onFinal).not.toHaveBeenCalled()
    expect(cb.onClosed).not.toHaveBeenCalled()
  })
})
