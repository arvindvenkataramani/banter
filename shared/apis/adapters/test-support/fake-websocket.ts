// A WebSocket whose lifecycle a test drives. It stands in for the global the
// adapters open, so timing and close codes are deterministic.

type Handler = ((event: never) => void) | null

export class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  // Starts connecting, as a real socket does: audio captured before open() is
  // what an adapter's pre-open hold exists for.
  readyState: number = FakeWebSocket.CONNECTING
  binaryType = ''
  sent: Array<string | ArrayBuffer | ArrayBufferView> = []
  onmessage: Handler = null
  onclose: Handler = null
  onerror: Handler = null
  onopen: Handler = null
  readonly url: string
  private listeners = new Map<string, Set<(event: unknown) => void>>()

  constructor(url: string | URL) {
    this.url = String(url)
    FakeWebSocket.instances.push(this)
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(listener)
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  private fire(type: string, handler: Handler, event: unknown): void {
    ;(handler as ((e: unknown) => void) | null)?.(event)
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
  }

  // Test drivers.
  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.fire('open', this.onopen, {})
  }

  deliver(msg: unknown): void {
    this.fire('message', this.onmessage, { data: JSON.stringify(msg) })
  }

  /** The connection ends, as a server's close frame or a dropped network would end it. */
  drop(reason = '', code = 1006): void {
    this.readyState = FakeWebSocket.CLOSED
    this.fire('close', this.onclose, { reason, code, wasClean: code !== 1006 })
  }

  get textFrames(): string[] {
    return this.sent.filter((f): f is string => typeof f === 'string')
  }

  get jsonFrames(): Array<Record<string, unknown>> {
    return this.textFrames.map((f) => JSON.parse(f) as Record<string, unknown>)
  }

  get binaryFrames(): Array<ArrayBuffer | ArrayBufferView> {
    return this.sent.filter((f): f is ArrayBuffer | ArrayBufferView => typeof f !== 'string')
  }
}

/** Makes FakeWebSocket the global the adapters open; the returned function restores the real one. */
export function installFakeWebSocket(): () => void {
  const original = globalThis.WebSocket
  FakeWebSocket.instances = []
  ;(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket
  return () => {
    ;(globalThis as { WebSocket: unknown }).WebSocket = original
  }
}
