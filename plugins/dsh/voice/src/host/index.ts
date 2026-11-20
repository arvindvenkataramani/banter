// Host half: the plugin's row in dsh's composition. Serves the browser assets
// at the paths the client build and the engine reference, relays speech
// traffic and the three control-plane calls, adds voice guidance to the
// prompt of sessions with voice live, and exposes the plugin's settings as
// live config.

import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import z from '@deepseek-ai/schemastery'
import { forwardHttp, forwardUpgrade } from './forward.ts'
import {
  CONTROL_PREFIX, LIVE_PATH, LIVE_TTL_MS, SPEECH_PREFIX, configuredServiceIds, isAllowedControlCall, parseSpeechPath, resolveSpeechUpstream,
  type RelaySettings,
} from './relay.ts'
import { DEFAULT_SETTINGS, type PluginSettings } from './settings.ts'
import { serveStatic } from './static.ts'
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
  sttServiceId: Live<string>
  sttModel: Live<string>
  ttsServiceId: Live<string>
  ttsModel: Live<string>
  ttsVoice: Live<string>
  ttsSpeed: Live<number>
  keepVoiceOutside: Live<boolean>
  rest: Live<string>
}

export const Config: z<Config> = z.object({
  controlPlaneUrl: z.string().default(DEFAULT_SETTINGS.controlPlaneUrl).volatile(),
  sttServiceId: z.string().default(DEFAULT_SETTINGS.sttServiceId).volatile(),
  sttModel: z.string().default(DEFAULT_SETTINGS.sttModel).volatile(),
  ttsServiceId: z.string().default(DEFAULT_SETTINGS.ttsServiceId).volatile(),
  ttsModel: z.string().default(DEFAULT_SETTINGS.ttsModel).volatile(),
  ttsVoice: z.string().default(DEFAULT_SETTINGS.ttsVoice).volatile(),
  ttsSpeed: z.number().min(0.25).max(4).default(DEFAULT_SETTINGS.ttsSpeed).volatile(),
  keepVoiceOutside: z.boolean().default(DEFAULT_SETTINGS.keepVoiceOutside).volatile(),
  rest: z.string().default(DEFAULT_SETTINGS.rest).volatile(),
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

const PACKAGE_ROOT =fileURLToPath(new URL('./', import.meta.url))

/** The streaming WebSocket path the engine's STT socket opens, below its endpoint. */
const STT_STREAM_PATH = '/v1/audio/stream'

export function apply(ctx: HostContext, config: Config): void {
  const settings = (): PluginSettings => ({
    controlPlaneUrl: config.controlPlaneUrl.get(),
    sttServiceId: config.sttServiceId.get(),
    sttModel: config.sttModel.get(),
    ttsServiceId: config.ttsServiceId.get(),
    ttsModel: config.ttsModel.get(),
    ttsVoice: config.ttsVoice.get(),
    ttsSpeed: config.ttsSpeed.get(),
    keepVoiceOutside: config.keepVoiceOutside.get(),
    rest: config.rest.get(),
  })

  // The control plane reports each service's real endpoint; the relay learns it
  // on first use and forgets it when the settings change or an upstream fails.
  const endpoints = new Map<string, string>()
  const relaySettings = (): RelaySettings => ({ ...settings(), endpoints: Object.fromEntries(endpoints) })

  const endpointOf = async (serviceId: string): Promise<string | null> => {
    const known = endpoints.get(serviceId)
    if (known !== undefined) return known
    const { controlPlaneUrl } = settings()
    if (controlPlaneUrl === '') return null
    try {
      const response = await fetch(`${controlPlaneUrl.replace(/\/+$/, '')}/api/services/${encodeURIComponent(serviceId)}`)
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

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: SPEECH_PREFIX,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      const url = String(req.url)
      const serviceId = parseSpeechPath(url)?.serviceId
      if (serviceId === undefined || !configuredServiceIds(settings()).includes(serviceId)) {
        res.writeHead(404).end()
        return
      }
      await endpointOf(serviceId)
      const upstream = resolveSpeechUpstream(relaySettings(), url)
      if (upstream === null) {
        res.writeHead(404).end()
        return
      }
      forwardHttp(req, res, upstream, () => { endpoints.delete(serviceId ?? '') })
    },
  }), 'dsh-voice: speech relay')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: CONTROL_PREFIX,
    handler: (req, res) => {
      if (rejected(req, res)) return
      const apiPath = String(req.url).slice(CONTROL_PREFIX.length)
      const { controlPlaneUrl } = settings()
      if (controlPlaneUrl === '' || !isAllowedControlCall(settings(), req.method ?? '', apiPath)) {
        res.writeHead(404).end()
        return
      }
      forwardHttp(req, res, new URL(`${controlPlaneUrl.replace(/\/+$/, '')}${apiPath}`))
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

  // dsh matches upgrade routes by exact path, so the STT stream route follows
  // the configured service id.
  let disposeUpgrade: (() => void) | undefined
  const registerUpgrade = (): void => {
    disposeUpgrade?.()
    disposeUpgrade = undefined
    endpoints.clear()
    const { sttServiceId } = settings()
    if (sttServiceId === '') return
    disposeUpgrade = ctx.webServer.registerUpgrade({
      path: `${SPEECH_PREFIX}/${encodeURIComponent(sttServiceId)}${STT_STREAM_PATH}`,
      handler: async (req, socket, head) => {
        const rejection = ctx.connection.requestRejection(req)
        if (rejection !== undefined) {
          socket.end(`HTTP/1.1 ${rejection} ${rejection === 401 ? 'Unauthorized' : 'Forbidden'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
          return
        }
        const url = String(req.url)
        await endpointOf(sttServiceId)
        const upstream = resolveSpeechUpstream(relaySettings(), url)
        if (upstream === null) {
          socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
          return
        }
        forwardUpgrade(req, socket, head, upstream, () => { endpoints.delete(sttServiceId) })
      },
    })
  }
  registerUpgrade()
  ctx.effect(() => ctx.on('loader/volatile-update', registerUpgrade), 'dsh-voice: follow settings')
  ctx.effect(() => () => { disposeUpgrade?.() }, 'dsh-voice: STT upgrade route')
}
