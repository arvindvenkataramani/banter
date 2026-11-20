// The speech services as the page reaches them: readiness, start and
// keep-alive go to the control plane through the host half's relay, and the
// endpoint handed to the engine is the speech relay's, never the service's own.

import { CONTROL_PREFIX, SPEECH_PREFIX } from '../host/relay.ts'

const POLL_INTERVAL_MS = 500

/** How long the control plane may fail to answer before a start's wait gives up (dashboard/src/lib/voice/voice-service.ts). */
const UNREACHABLE_GRACE_MS = 45_000

/** The slice of a control-plane service record the readiness logic reads. */
interface ServiceInfo {
  health?: string
  pending?: boolean
  runner?: { type?: string }
  network?: { endpoint?: string }
  lastEvent?: { data?: { error?: unknown } }
}

export interface PluginServices {
  ensureServiceReady(serviceId: string): Promise<string>
  ensureTtsReady(serviceId: string): Promise<string>
  ping(serviceId: string): Promise<unknown>
}

/** Where the engine reaches a speech service: the host's relay on the page's own origin. */
export function relayEndpoint(origin: string, serviceId: string): string {
  return `${origin}${SPEECH_PREFIX}/${encodeURIComponent(serviceId)}`
}

/**
 * Where the streaming transport opens its WebSocket. In the desktop app the page's origin is `dsh-app://app`, which
 * fetch reaches through the app but a WebSocket can't; the app names its Host's own http origin as
 * `__DSH_TRANSPORT__.streamBaseUrl` (dsh-client-connection's README), and dsh's own streams connect there. A relay
 * endpoint on the page's origin moves onto that base; anything else, or a page without one, is left as it is.
 */
export function streamingEndpoint(endpoint: string, pageOrigin: string, streamBaseUrl: string | undefined): string {
  if (streamBaseUrl === undefined || !endpoint.startsWith(`${pageOrigin}/`)) return endpoint
  return `${streamBaseUrl.replace(/\/+$/, '')}${endpoint.slice(pageOrigin.length)}`
}

/** The page's stream base, when the page declares one. */
export function pageStreamBaseUrl(): string | undefined {
  const base = (globalThis as { __DSH_TRANSPORT__?: { streamBaseUrl?: unknown } }).__DSH_TRANSPORT__?.streamBaseUrl
  return typeof base === 'string' && /^https?:\/\//.test(base) ? base : undefined
}

export function createPluginServices(deps: { origin: string; fetch: typeof globalThis.fetch }): PluginServices {
  const { origin, fetch } = deps

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${origin}${CONTROL_PREFIX}${path}`, init)
    if (!res.ok) {
      let message = res.statusText
      try {
        const body = await res.json() as { error?: string }
        if (body.error) message = body.error
      } catch { /* the status text stands */ }
      throw new Error(message)
    }
    return await res.json() as T
  }

  const getService = (id: string): Promise<ServiceInfo> => request<ServiceInfo>(`/api/services/${encodeURIComponent(id)}`)
  const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

  /** A start runs in the background on the control plane; wait for it to settle, riding out a control plane that stops answering for a while. */
  async function waitWhilePending(serviceId: string): Promise<ServiceInfo> {
    let unreachableSince: number | null = null
    for (;;) {
      try {
        const service = await getService(serviceId)
        unreachableSince = null
        if (service.pending !== true) return service
      } catch (err) {
        unreachableSince ??= Date.now()
        if (Date.now() - unreachableSince > UNREACHABLE_GRACE_MS) {
          throw new Error(`Lost contact while starting "${serviceId}": ${err instanceof Error ? err.message : 'unknown error'}`)
        }
      }
      await sleep(POLL_INTERVAL_MS)
    }
  }

  async function ensureServiceReady(serviceId: string): Promise<string> {
    // Ask before starting: a healthy service needs no start, and an externally managed one cannot be started.
    let service = await getService(serviceId)
    if (service.health !== 'healthy' && service.runner?.type !== 'external') {
      const started = await request<{ success: boolean; error?: string }>(`/api/services/${encodeURIComponent(serviceId)}/start`, { method: 'POST' })
      if (!started.success) throw new Error(started.error ?? `Service "${serviceId}" could not be started`)
      service = await waitWhilePending(serviceId)
      if (service.health !== 'healthy') {
        const reason = service.lastEvent?.data?.error
        throw new Error(typeof reason === 'string'
          ? `Service "${serviceId}" is not available: ${reason}`
          : `Service "${serviceId}" is not available`)
      }
    }
    if (!service.network?.endpoint) throw new Error(`Service "${serviceId}" has no endpoint`)
    return relayEndpoint(origin, serviceId)
  }

  return {
    ensureServiceReady,
    ensureTtsReady: ensureServiceReady,
    ping: (serviceId) => request<{ ok: boolean }>(`/api/services/${encodeURIComponent(serviceId)}/ping`, { method: 'POST' }),
  }
}

/** Loads a TTS model on the service behind `endpoint` (the relay's), as the dashboard does (dashboard/src/lib/voice/voice-service.ts). */
export async function loadTtsModel(endpoint: string, modelName: string): Promise<void> {
  const res = await fetch(`${endpoint}/v1/models?model_name=${encodeURIComponent(modelName)}`, { method: 'POST' })
  if (!res.ok) throw new Error(`Failed to load model "${modelName}": ${res.status}`)
}

/**
 * Loads an STT model before the first utterance. `mode` names which way a
 * model capable of both is brought up; `chunkMs` is its latency tier.
 */
export async function loadSttModel(endpoint: string, model: string, mode?: 'batch' | 'streaming', chunkMs?: number): Promise<void> {
  const res = await fetch(`${endpoint}/v1/models/load`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, ...(mode ? { mode } : {}), ...(typeof chunkMs === 'number' ? { chunkMs } : {}) }),
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => null) as { error?: unknown } | null
    const reason = detail && typeof detail.error === 'string' ? `: ${detail.error}` : ''
    throw new Error(`Failed to load STT model "${model}" (${res.status})${reason}`)
  }
}

/** Reads a configured service's health through the relay, without starting it. */
export async function checkService(deps: { origin: string; fetch: typeof globalThis.fetch }, serviceId: string): Promise<{ healthy: boolean; detail: string }> {
  const { origin, fetch } = deps
  try {
    const res = await fetch(`${origin}${CONTROL_PREFIX}/api/services/${encodeURIComponent(serviceId)}`, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return { healthy: false, detail: `answered ${res.status}` }
    const service = await res.json() as ServiceInfo
    return service.health === 'healthy'
      ? { healthy: true, detail: 'running' }
      : { healthy: false, detail: 'not running; voice starts it when needed' }
  } catch {
    return { healthy: false, detail: 'unreachable' }
  }
}
