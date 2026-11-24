// A WebSocket server on a free port that records what a client sends and lets
// a test answer it. Used with the adapters' real WebSocket client.

import type { ServerWebSocket } from 'bun'

export interface MockSocketServer {
  /** http://127.0.0.1:<port>, the endpoint an adapter is given. */
  endpoint: string
  /** The URL of each upgrade request, in arrival order. */
  requests: URL[]
  /** Text frames the client sent, parsed as JSON, in arrival order. */
  messages: Array<Record<string, unknown>>
  /** Binary frames the client sent. */
  frames: ArrayBuffer[]
  /** How many connections are open. */
  readonly connections: number
  /** Sends a JSON text frame to the most recent connection. */
  send(message: unknown): void
  /** Closes the most recent connection with a code. */
  close(code: number, reason?: string): void
  /** Resolves once the predicate holds; rejects after the timeout. */
  waitFor(predicate: () => boolean, timeoutMs?: number): Promise<void>
  stop(): void
}

/** `onMessage` sees each parsed client frame and may answer through `send`; `onOpen` speaks first, as a server does on connect. */
export function startMockSocketServer(
  onMessage?: (message: Record<string, unknown>, send: (message: unknown) => void) => void,
  onOpen?: (send: (message: unknown) => void) => void,
): MockSocketServer {
  const requests: URL[] = []
  const messages: Array<Record<string, unknown>> = []
  const frames: ArrayBuffer[] = []
  const sockets: ServerWebSocket<unknown>[] = []

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      requests.push(new URL(req.url))
      if (srv.upgrade(req)) return undefined
      return new Response('upgrade required', { status: 426 })
    },
    websocket: {
      open(ws) { sockets.push(ws); onOpen?.((m) => ws.send(JSON.stringify(m))) },
      message(ws, data) {
        if (typeof data === 'string') {
          const parsed = JSON.parse(data) as Record<string, unknown>
          messages.push(parsed)
          onMessage?.(parsed, (m) => ws.send(JSON.stringify(m)))
        } else {
          frames.push(new Uint8Array(data).buffer as ArrayBuffer)
        }
      },
    },
  })

  return {
    endpoint: `http://127.0.0.1:${server.port}`,
    requests,
    messages,
    frames,
    get connections() { return sockets.length },
    send: (message) => { sockets.at(-1)?.send(JSON.stringify(message)) },
    close: (code, reason) => { sockets.at(-1)?.close(code, reason) },
    async waitFor(predicate, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error('timed out waiting for the mock socket server')
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    },
    stop: () => { server.stop(true) },
  }
}
