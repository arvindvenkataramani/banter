// Host half: the plugin's row in dsh's composition. Serves the browser assets
// at the paths the client build and the engine reference, hands the page the
// control plane's voice config, relays speech traffic and the three
// control-plane calls for the services that config selects, adds voice
// guidance to the prompt of sessions with voice live, and exposes the plugin's
// own settings as live config.

import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import z from '@deepseek-ai/schemastery'
import { createRelays } from './forward.ts'
import {
  CONFIG_CHECK_PATH, CONFIG_PATH, CONTROL_PREFIX, LIVE_PATH, LIVE_TTL_MS, SPEECH_PREFIX, configuredServiceIds, isAllowedControlCall, parseSpeechPath,
  resolveSpeechUpstream, type RelaySettings,
} from './relay.ts'
import { DEFAULT_SETTINGS } from './settings.ts'
import { serveStatic } from './static.ts'
import { createVoiceConfigSource, type ConfigAnswer } from './voice-config.ts'
import voiceGuidance from '../../../../openclaw/voice-mode/voice-guidance.md?raw'

export const name = 'dsh-voice'

/** The route carrier and the trust fence guarding every route. */
export const inject = ['webServer', 'connection', 'systemPrompt']

/** A config value dsh re-reads on every `get()`, so a card edit applies without a restart. */
interface Live<T> {
  get(): T
}

export interface Config {
  controlPlaneUrl: Live<string>
  keepVoiceOutside: Live<boolean>
}

export const Config: z<Config> = z.object({
  controlPlaneUrl: z.string().default(DEFAULT_SETTINGS.controlPlaneUrl).volatile(),
  keepVoiceOutside: z.boolean().default(DEFAULT_SETTINGS.keepVoiceOutside).volatile(),
}) as unknown as z<Config>

/** The members of dsh's host context this entry uses, typed locally: dsh's packages are not imported. */
interface HostContext {
  webServer: {
    register(route: {
      kind: 'exact' | 'prefix'
      path: string
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
    }): () => void
    registerUpgrade(route: {
      path: string
      handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
    }): () => void
  }
  connection: { requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined }
  systemPrompt: {
    section(section: { name: string; order: number; text: string | ((context: { scope?: object }) => string); interpolate?: boolean }): () => void
  }
  effect(callback: () => () => unknown, label?: string): unknown
  on(event: 'loader/volatile-update', listener: () => void): () => void
  logger: { warn(...args: unknown[]): void }
}

/** A live report is a few bytes; anything larger is refused. */
const LIVE_REPORT_LIMIT = 4096

/** Reads `{ sessionId, live }` from a live-report request body, or null when it is malformed. */
async function readLiveReport(req: IncomingMessage): Promise<{ sessionId: string; live: boolean } | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const part = Buffer.from(chunk as Uint8Array)
    size += part.length
    if (size > LIVE_REPORT_LIMIT) return null
    chunks.push(part)
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const { sessionId, live } = body as { sessionId?: unknown; live?: unknown }
    return typeof sessionId === 'string' && sessionId !== '' && typeof live === 'boolean' ? { sessionId, live } : null
  } catch {
    return null
  }
}

function sendAnswer(res: ServerResponse, answer: ConfigAnswer): void {
  const body = answer.status === 200 ? answer.config : { reason: answer.reason }
  res.writeHead(answer.status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body))
}

const PACKAGE_ROOT = fileURLToPath(new URL('./', import.meta.url))

export function apply(ctx: HostContext, config: Config): void {
  const controlPlaneUrl = (): string => config.controlPlaneUrl.get()
  const source = createVoiceConfigSource({ controlPlaneUrl, fetch: (...args) => fetch(...args) })

  /** The services the relays serve, loading them first when no load has succeeded yet. */
  const selection = async (): Promise<{ sttServiceId: string; ttsServiceId: string; alsoServed: string[] }> => {
    if (source.selected() === null) await source.load()
    return { ...(source.selected() ?? { sttServiceId: '', ttsServiceId: '' }), alsoServed: source.allowed() }
  }

  // Relayed requests and streams are held by this instance and closed when it unloads,
  // after the routes go: a live STT stream would otherwise outlive the plugin.
  const relays = createRelays()
  ctx.effect(() => () => { relays.closeAll() }, 'dsh-voice: open relays')

  // The control plane reports each service's real endpoint; the relay learns it
  // on first use and forgets it when the settings change or an upstream fails.
  const endpoints = new Map<string, string>()
  const relaySettings = async (): Promise<RelaySettings> => ({
    ...await selection(),
    controlPlaneUrl: controlPlaneUrl(),
    endpoints: Object.fromEntries(endpoints),
  })

  const endpointOf = async (serviceId: string): Promise<string | null> => {
    const known = endpoints.get(serviceId)
    if (known !== undefined) return known
    const url = controlPlaneUrl()
    if (url === '') return null
    try {
      const response = await fetch(`${url.replace(/\/+$/, '')}/api/services/${encodeURIComponent(serviceId)}`)
      if (!response.ok) return null
      const body = await response.json() as { network?: { endpoint?: unknown } }
      const endpoint = body.network?.endpoint
      if (typeof endpoint !== 'string') return null
      endpoints.set(serviceId, endpoint)
      return endpoint
    } catch {
      return null
    }
  }

  /** Answers a rejected request; true when it was rejected. */
  const rejected = (req: IncomingMessage, res: ServerResponse): boolean => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection === undefined) return false
    res.writeHead(rejection).end()
    return true
  }

  const staticRoute = (path: string, directory: string): void => {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path,
      handler: async (req, res) => {
        if (rejected(req, res)) return
        const pathname = new URL(String(req.url), 'http://localhost').pathname
        await serveStatic(`${PACKAGE_ROOT}${directory}`, pathname.slice(path.length), req, res)
      },
    }), `dsh-voice: static ${path}`)
  }
  staticRoute('/models', 'public/models')
  staticRoute('/tones', 'public/tones')
  staticRoute('/dsh-voice/assets', 'assets')

  const configRoute = (path: string, answer: () => Promise<ConfigAnswer>, label: string): void => {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        if (rejected(req, res)) return
        if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET' }).end()
          return
        }
        sendAnswer(res, await answer())
      },
    }), label)
  }
  configRoute(CONFIG_PATH, () => source.load(), 'dsh-voice: voice config')
  configRoute(CONFIG_CHECK_PATH, () => source.check(), 'dsh-voice: connection check')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: SPEECH_PREFIX,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      const url = String(req.url)
      const serviceId = parseSpeechPath(url)?.serviceId
      if (serviceId === undefined || !configuredServiceIds(await selection()).includes(serviceId)) {
        res.writeHead(404).end()
        return
      }
      await endpointOf(serviceId)
      const upstream = resolveSpeechUpstream(await relaySettings(), url)
      if (upstream === null) {
        res.writeHead(404).end()
        return
      }
      relays.http(req, res, upstream, () => { endpoints.delete(serviceId ?? '') })
    },
  }), 'dsh-voice: speech relay')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: CONTROL_PREFIX,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      const apiPath = String(req.url).slice(CONTROL_PREFIX.length)
      const url = controlPlaneUrl()
      if (url === '' || !isAllowedControlCall(await selection(), req.method ?? '', apiPath)) {
        res.writeHead(404).end()
        return
      }
      relays.http(req, res, new URL(`${url.replace(/\/+$/, '')}${apiPath}`))
    },
  }), 'dsh-voice: control-plane relay')

  // The page reports which sessions have voice live; their prompt carries the voice guidance.
  // Each report holds a session live until its expiry; the page repeats it while voice runs.
  const liveSessions = new Map<string, number>()
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: LIVE_PATH,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' }).end()
        return
      }
      const report = await readLiveReport(req)
      if (report === null) {
        res.writeHead(400).end()
        return
      }
      const now = Date.now()
      for (const [id, expiry] of liveSessions) if (expiry <= now) liveSessions.delete(id)
      if (report.live) liveSessions.set(report.sessionId, now + LIVE_TTL_MS)
      else liveSessions.delete(report.sessionId)
      res.writeHead(204).end()
    },
  }), 'dsh-voice: live sessions')

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'dsh-voice:guidance',
    // After the deployment persona prefix and before every tool section.
    order: 100,
    text: (context) => {
      const id = (context.scope as { id?: unknown } | undefined)?.id
      return typeof id === 'string' && (liveSessions.get(id) ?? 0) > Date.now() ? voiceGuidance : ''
    },
    interpolate: false,
  }), 'dsh-voice: voice guidance')

  // dsh matches upgrade routes by exact path, so the STT stream routes follow
  // the served STT services (the selection and the one before it) and the paths
  // their streaming provisions use, re-registered whenever a load changes them.
  let disposeUpgrades: Array<() => void> = []
  const registerUpgrade = (): void => {
    for (const dispose of disposeUpgrades) dispose()
    const sttIds = [source.selected()?.sttServiceId ?? '', source.previous()?.sttServiceId ?? ''].filter((id, i, all) => id !== '' && all.indexOf(id) === i)
    disposeUpgrades = sttIds.flatMap(sttServiceId => source.streamPaths(sttServiceId).map(path => upgradeRoute(sttServiceId, path)))
  }
  const upgradeRoute = (sttServiceId: string, streamPath: string): (() => void) =>
    ctx.webServer.registerUpgrade({
      path: `${SPEECH_PREFIX}/${encodeURIComponent(sttServiceId)}${streamPath}`,
      handler: async (req, socket, head) => {
        const rejection = ctx.connection.requestRejection(req)
        if (rejection !== undefined) {
          socket.end(`HTTP/1.1 ${rejection} ${rejection === 401 ? 'Unauthorized' : 'Forbidden'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
          return
        }
        const url = String(req.url)
        await endpointOf(sttServiceId)
        const upstream = resolveSpeechUpstream(await relaySettings(), url)
        if (upstream === null) {
          socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
          return
        }
        relays.upgrade(req, socket, head, upstream, () => { endpoints.delete(sttServiceId) })
      },
    })
  ctx.effect(() => source.onChange(registerUpgrade), 'dsh-voice: follow the selected STT service')
  ctx.effect(() => () => { for (const dispose of disposeUpgrades) dispose() }, 'dsh-voice: STT upgrade routes')
  // A changed URL may name another Banter: forget what the old one selected, and load again.
  // Other settings changes (keep-voice-outside) leave the served services alone.
  let loadedUrl = controlPlaneUrl()
  ctx.effect(() => ctx.on('loader/volatile-update', () => {
    if (controlPlaneUrl() === loadedUrl) return
    loadedUrl = controlPlaneUrl()
    endpoints.clear()
    source.clear()
    registerUpgrade()
    void source.load()
  }), 'dsh-voice: follow settings')
  void source.load()
}
