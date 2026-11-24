import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createRelays } from './forward'

// Real loopback sockets: an upstream that holds every connection open, and a
// front server that relays to it the way the host's routes do.

const servers: net.Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    if ('closeAllConnections' in server) (server as http.Server).closeAllConnections()
    await new Promise(resolve => { server.close(resolve) })
  }
})

async function listen<S extends net.Server>(server: S): Promise<{ server: S; port: number }> {
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, port: (server.address() as AddressInfo).port }
}

/** Resolves when the socket or stream has closed; an abort's error on the way is expected. */
const closed = (target: NodeJS.EventEmitter & { closed?: boolean }): Promise<void> =>
  new Promise((resolve) => {
    target.on('error', () => {})
    if (target.closed === true) resolve()
    else target.once('close', () => { resolve() })
  })

describe('relays — unloading closes what is still open', () => {
  it('an HTTP relay holding a streamed response closes on both sides', async () => {
    let upstreamReq: IncomingMessage | undefined
    const upstream = await listen(http.createServer((req, res) => {
      upstreamReq = req
      res.writeHead(200, { 'content-type': 'audio/mpeg' })
      res.write('first chunk')
    }))
    const relays = createRelays()
    const front = await listen(http.createServer((req, res) => {
      relays.http(req, res, new URL(`http://127.0.0.1:${upstream.port}/speech`))
    }))

    const response = await new Promise<IncomingMessage>((resolve) => {
      http.get(`http://127.0.0.1:${front.port}/x`, resolve)
    })
    await once(response, 'data')
    expect(upstreamReq).toBeDefined()
    const bothClosed = Promise.all([closed(response), closed(upstreamReq as IncomingMessage)])

    relays.closeAll()

    await bothClosed
  })

  it('a WebSocket relay closes the client socket and the upstream connection', async () => {
    const upstreamSockets: net.Socket[] = []
    const upstream = await listen(net.createServer((socket) => { upstreamSockets.push(socket) }))
    const relays = createRelays()
    const front = http.createServer()
    front.on('upgrade', (req, socket, head) => {
      relays.upgrade(req, socket, head, new URL(`ws://127.0.0.1:${upstream.port}/stream`))
    })
    const { port } = await listen(front)

    const client = net.connect(port, '127.0.0.1')
    await once(client, 'connect')
    client.write('GET /x HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: a\r\nSec-WebSocket-Version: 13\r\n\r\n')
    while (upstreamSockets.length === 0) await new Promise(resolve => setTimeout(resolve, 5))
    const upstreamSocket = upstreamSockets[0] as net.Socket
    await once(upstreamSocket, 'data')
    const bothClosed = Promise.all([closed(client), closed(upstreamSocket)])

    relays.closeAll()

    await bothClosed
  })

  it('a relay that closes on its own is no longer held', async () => {
    const upstream = await listen(http.createServer((_req, res) => { res.end('done') }))
    const relays = createRelays()
    const front = await listen(http.createServer((req, res) => {
      relays.http(req, res, new URL(`http://127.0.0.1:${upstream.port}/`))
    }))

    const body = await new Promise<string>((resolve) => {
      http.get(`http://127.0.0.1:${front.port}/`, (res) => {
        let text = ''
        res.on('data', (chunk: Buffer) => { text += chunk.toString() })
        res.on('end', () => { resolve(text) })
      })
    })
    expect(body).toBe('done')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(relays.openCount()).toBe(0)
  })
})

describe('relays — a client already gone opens no upstream', () => {
  it('for a WebSocket upgrade', async () => {
    let connections = 0
    const upstream = await listen(net.createServer(() => { connections++ }))
    const relays = createRelays()
    const socket = new PassThrough()
    socket.destroy()
    const req = { headers: {} } as IncomingMessage

    relays.upgrade(req, socket, Buffer.alloc(0), new URL(`ws://127.0.0.1:${upstream.port}/stream`))

    await new Promise(resolve => setTimeout(resolve, 50))
    expect(connections).toBe(0)
  })

  it('for a relay that starts after the unload, closing the client instead', async () => {
    let connections = 0
    const upstream = await listen(net.createServer(() => { connections++ }))
    const relays = createRelays()
    relays.closeAll()
    const socket = new PassThrough()
    const req = { headers: {} } as IncomingMessage

    relays.upgrade(req, socket, Buffer.alloc(0), new URL(`ws://127.0.0.1:${upstream.port}/stream`))

    await new Promise(resolve => setTimeout(resolve, 50))
    expect(connections).toBe(0)
    expect(socket.destroyed).toBe(true)
  })

  it('for an HTTP request', async () => {
    let requests = 0
    const upstream = await listen(http.createServer((_req, res) => { requests++; res.end() }))
    const relays = createRelays()
    const req = new PassThrough() as unknown as IncomingMessage
    Object.assign(req, { headers: {}, method: 'GET' })
    const res = { destroyed: true } as unknown as ServerResponse

    relays.http(req, res, new URL(`http://127.0.0.1:${upstream.port}/`))

    await new Promise(resolve => setTimeout(resolve, 50))
    expect(requests).toBe(0)
  })
})
