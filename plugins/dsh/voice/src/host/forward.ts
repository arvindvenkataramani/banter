// Streaming forwarders for the relays: an HTTP request and a WebSocket
// upgrade, each piped to an upstream URL. Bodies are never buffered whole.

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { upstreamHeaders } from './relay.ts'

/** Response headers that describe one hop and must not be copied across. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'set-cookie'])

/** The relays of one plugin instance, holding each open client side so the plugin's unload can close them. */
export interface Relays {
  http(req: IncomingMessage, res: ServerResponse, upstream: URL, onFailure?: () => void): void
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, upstream: URL, onFailure?: () => void): void
  /** Destroys every relayed response and socket still open (each one's upstream closes with it) and refuses later ones. */
  closeAll(): void
  openCount(): number
}

export function createRelays(): Relays {
  const open = new Set<{ destroy(): unknown }>()
  let closed = false
  /** Holds the client side until it closes; false when it should get no upstream. */
  const hold = (side: (ServerResponse | Duplex)): boolean => {
    // A client gone while the route awaited gets no upstream, nor does one that arrives after the unload.
    if (side.destroyed) return false
    if (closed) {
      side.destroy()
      return false
    }
    open.add(side)
    side.once('close', () => { open.delete(side) })
    return true
  }
  return {
    http(req, res, upstream, onFailure) {
      if (hold(res)) forwardHttp(req, res, upstream, onFailure)
    },
    upgrade(req, socket, head, upstream, onFailure) {
      if (hold(socket)) forwardUpgrade(req, socket, head, upstream, onFailure)
    },
    closeAll() {
      closed = true
      for (const side of [...open]) side.destroy()
      open.clear()
    },
    openCount: () => open.size,
  }
}

/** Pipes `req` to `upstream` and the upstream's response back to `res`, chunk by chunk. */
function forwardHttp(req: IncomingMessage, res: ServerResponse, upstream: URL, onFailure?: () => void): void {
  const client = upstream.protocol === 'https:' ? https : http
  const out = client.request(upstream, { method: req.method, headers: upstreamHeaders(req.headers) }, (upstreamRes) => {
    const responseHeaders: http.OutgoingHttpHeaders = {}
    for (const [name, value] of Object.entries(upstreamRes.headers)) {
      if (value !== undefined && !HOP_BY_HOP.has(name)) responseHeaders[name] = value
    }
    // dsh's web server gzips compressible responses through a buffering middleware, which would hold a
    // streamed body until it ends; no-transform opts the relayed response out.
    const cacheControl = responseHeaders['cache-control']
    responseHeaders['cache-control'] = cacheControl === undefined ? 'no-transform' : `${String(cacheControl)}, no-transform`
    res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders)
    upstreamRes.pipe(res)
    upstreamRes.on('error', () => { res.destroy() })
  })
  out.on('error', () => {
    onFailure?.()
    if (res.headersSent) res.destroy()
    else res.writeHead(502).end()
  })
  res.on('close', () => { if (!res.writableFinished) out.destroy() })
  req.pipe(out)
}

/** Opens a socket to `upstream`, replays the client's upgrade request without Origin, and pipes the two sockets together. */
function forwardUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, upstream: URL, onFailure?: () => void): void {
  const secure = upstream.protocol === 'https:' || upstream.protocol === 'wss:'
  const port = Number(upstream.port || (secure ? 443 : 80))
  const connection: Duplex = secure
    ? tls.connect({ host: upstream.hostname, port, servername: upstream.hostname })
    : net.connect(port, upstream.hostname)
  const fail = (): void => {
    onFailure?.()
    socket.destroy()
    connection.destroy()
  }
  connection.once('error', fail)
  socket.once('error', fail)
  connection.once('close', () => { socket.destroy() })
  socket.once('close', () => { connection.destroy() })
  connection.once(secure ? 'secureConnect' : 'connect', () => {
    const lines = [
      `GET ${upstream.pathname}${upstream.search} HTTP/1.1`,
      `Host: ${upstream.host}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
    ]
    for (const [name, value] of Object.entries(upstreamHeaders(req.headers))) {
      if (name.startsWith('sec-websocket-')) lines.push(`${name}: ${value}`)
    }
    connection.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head.length > 0) connection.write(head)
    socket.pipe(connection)
    connection.pipe(socket)
  })
}
