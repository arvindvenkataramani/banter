import { createHash } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import type { IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, type Config } from './index'
// A relative import: this package declares no dependency on the shared package for tests.
import * as streamAdapter from '../../../../../shared/apis/adapters/fluid.stt.stream'
import * as listenAdapter from '../../../../../shared/apis/adapters/deepgram.listen.live'
import * as realtimeAdapter from '../../../../../shared/apis/adapters/openai.realtime'

// The relay registers its WebSocket upgrade route at each path the selected STT service's
// stream provisions use, and passes what the browser sends and the server answers through
// untouched (docs/reference/design/service-apis.md, "Provisions"). The host's own context is faked; the
// upstream and the browser are real loopback sockets speaking the WebSocket handshake.
//
// INVENTED: GET /api/voice carries the selected STT option as `stt.options[]`, with its
// `provides`, and the plugin reads the stream provisions from it. The spec's path for the
// stream socket is read from the adapter itself rather than written here.

type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const KEY = 'dGhlIHNhbXBsZSBub25jZQ=='

const disposers: Array<() => void> = []
const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose()
  for (const close of closers.splice(0)) await close()
  vi.unstubAllGlobals()
})

interface StreamAdapter {
  transcribeStream(call: never, callbacks: never): { close(): void }
}

/** What an adapter opens for a provision on a bare endpoint: its path, the spec's. */
function pathOf(adapter: StreamAdapter, provision: Record<string, unknown>): string {
  const urls: string[] = []
  class Capture {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSING = 2
    static readonly CLOSED = 3
    readyState = 0
    binaryType = ''
    onmessage = null
    onclose = null
    onerror = null
    onopen = null
    constructor(url: string) { urls.push(String(url)) }
    send(): void {}
    close(): void { this.readyState = 3 }
  }
  const original = globalThis.WebSocket
  ;(globalThis as { WebSocket: unknown }).WebSocket = Capture
  try {
    const session = adapter.transcribeStream(
      { endpoint: 'http://host.invalid', provision, model: 'm', format: 'pcm16' } as never,
      { onPartial() {}, onFinal() {}, onReady() {}, onClosed() {} } as never,
    )
    session.close()
  } finally {
    ;(globalThis as { WebSocket: unknown }).WebSocket = original
  }
  return new URL(urls[0]).pathname
}

const specPath = (basePath?: string): string => pathOf(streamAdapter, { api: 'fluid.stt.stream', ...(basePath ? { basePath } : {}) })

/** A server that answers an upgrade with the handshake and one close frame whose code is the request's `code` query. */
async function startUpstream() {
  const requests: string[] = []
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    let head = ''
    let answered = false
    socket.on('error', () => {})
    socket.on('data', (chunk) => {
      head += chunk.toString('latin1')
      if (answered || !head.includes('\r\n\r\n')) return
      answered = true
      const target = head.split('\r\n')[0].split(' ')[1]
      requests.push(target)
      const key = /sec-websocket-key: (.+)\r\n/i.exec(head)?.[1] ?? ''
      const accept = createHash('sha1').update(key + GUID).digest('base64')
      const code = Number(new URL(target, 'http://upstream.invalid').searchParams.get('code'))
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
      socket.write(Buffer.from([0x88, 0x02, code >> 8, code & 0xff]))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  closers.push(() => new Promise((resolve) => { server.close(() => { resolve() }); for (const socket of sockets) socket.destroy() }))
  return { port: (server.address() as AddressInfo).port, requests }
}

/** The plugin's host half, applied to a faked context, with a control plane that serves `provides` for the selected STT service. */
async function applyPlugin(provides: unknown[], upstreamPort: number) {
  const upgrades = new Map<string, UpgradeHandler>()
  const ctx = {
    webServer: {
      register: () => () => {},
      registerUpgrade: (route: { path: string; handler: UpgradeHandler }) => {
        upgrades.set(route.path, route.handler)
        return () => { upgrades.delete(route.path) }
      },
    },
    connection: { requestRejection: () => undefined },
    systemPrompt: { section: () => () => {} },
    effect: (callback: () => () => unknown) => { disposers.push(callback() as () => void) },
    on: () => () => {},
    logger: { warn: () => {} },
  }
  const voice = {
    tts: {
      models: [],
      voices: [],
      providers: [{ serviceId: 'tts-b', provides: [{ api: 'openai.audio.speech' }], models: { loading: 'none' }, serves: [] }],
      selection: { serviceId: 'tts-b', model: 'm', voice: 'v', speed: 1, resolution: { model: 'm', voice: { name: 'v' } } },
    },
    stt: {
      serviceId: 'stt-a',
      options: [{ serviceId: 'stt-a', name: 'STT', provides, models: { loading: 'none' }, serves: [] }],
      models: [],
    },
  }
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input)
    if (url === 'http://control.invalid/api/voice') return Response.json(voice)
    if (/\/api\/services\/[^/?]+$/.test(url)) return Response.json({ network: { endpoint: `http://127.0.0.1:${upstreamPort}` } })
    return new Response('not found', { status: 404 })
  }))
  const config = { controlPlaneUrl: { get: () => 'http://control.invalid' }, keepVoiceOutside: { get: () => false } } as unknown as Config
  apply(ctx as never, config)
  await vi.waitFor(() => { expect(upgrades.size).toBeGreaterThan(0) })
  return upgrades
}

/** Serves the registered upgrade routes the way dsh's web server does, matching on the exact path. */
async function serveUpgrades(upgrades: Map<string, UpgradeHandler>): Promise<number> {
  const front = http.createServer()
  front.on('upgrade', (req, socket, head) => {
    const handler = upgrades.get(new URL(String(req.url), 'http://front.invalid').pathname)
    if (handler === undefined) socket.destroy()
    else void handler(req, socket, head)
  })
  front.listen(0, '127.0.0.1')
  await once(front, 'listening')
  closers.push(() => new Promise((resolve) => { front.close(() => { resolve() }); front.closeAllConnections() }))
  return (front.address() as AddressInfo).port
}

/** The browser side: sends the upgrade and resolves with what follows the response head once the 4-byte close frame is in. */
function browser(port: number, target: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    let received = Buffer.alloc(0)
    socket.on('error', reject)
    socket.on('connect', () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: dsh.invalid\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: ${KEY}\r\nSec-WebSocket-Version: 13\r\n\r\n`)
    })
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk])
      const end = received.indexOf('\r\n\r\n')
      if (end >= 0 && received.length >= end + 4 + 4) {
        socket.destroy()
        resolve(received.subarray(end + 4))
      }
    })
  })
}

beforeEach(() => { vi.useRealTimers() })

describe('the STT upgrade route', () => {
  it.each([{ basePath: undefined }, { basePath: '/alt' }])('[T2] is registered at the stream provision\'s path under the speech prefix, with basePath $basePath', async ({ basePath }) => {
    const upstream = await startUpstream()
    const upgrades = await applyPlugin([{ api: 'fluid.stt.stream', ...(basePath ? { basePath } : {}) }, { api: 'openai.audio.transcriptions' }], upstream.port)

    expect([...upgrades.keys()]).toEqual([`/dsh-voice/speech/stt-a${specPath(basePath)}`])
  })

  it('[T2] passes the query parameters through to the server, and every close code from 4001 to 4010 through to the browser', async () => {
    const upstream = await startUpstream()
    const upgrades = await applyPlugin([{ api: 'fluid.stt.stream' }], upstream.port)
    const port = await serveUpgrades(upgrades)
    const route = [...upgrades.keys()][0]

    for (let code = 4001; code <= 4010; code++) {
      const frame = await browser(port, `${route}?model=opaque-key&format=opus&session=sess-1&takeover=1&code=${code}`)
      expect([...frame]).toEqual([0x88, 0x02, code >> 8, code & 0xff])
    }
    expect(upstream.requests).toHaveLength(10)
    const first = new URL(upstream.requests[0], 'http://upstream.invalid')
    expect(first.pathname).toBe(specPath())
    expect(Object.fromEntries(first.searchParams)).toEqual({ model: 'opaque-key', format: 'opus', session: 'sess-1', takeover: '1', code: '4001' })
  })
})

describe('the STT upgrade routes of every streaming provision', () => {
  const live = { api: 'deepgram.listen.live', extends: ['endpointing-off'] }
  const realtime = { api: 'openai.realtime', only: ['mode:transcription'] }
  const under = (path: string): string => `/dsh-voice/speech/stt-a${path}`

  it('[T3] has a route at the path of each provision that can stream transcription, the Deepgram and Realtime ones included', async () => {
    const upstream = await startUpstream()
    const upgrades = await applyPlugin([{ api: 'fluid.stt.stream', basePath: '/alt' }, live, realtime, { api: 'openai.audio.transcriptions' }], upstream.port)

    expect([...upgrades.keys()].sort()).toEqual([
      under(pathOf(streamAdapter, { api: 'fluid.stt.stream', basePath: '/alt' })),
      under(pathOf(listenAdapter, live)),
      under(pathOf(realtimeAdapter, realtime)),
    ].sort())
  })

  it('[T3] has none for a provision that cannot decide where an utterance ends, such as Deepgram live without endpointing-off', async () => {
    const upstream = await startUpstream()
    const upgrades = await applyPlugin([{ api: 'fluid.stt.stream' }, { api: 'deepgram.listen.live' }], upstream.port)

    expect([...upgrades.keys()]).toEqual([under(specPath())])
  })
})
