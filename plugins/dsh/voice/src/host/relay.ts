// Pure upstream selection and allowlist for the two relays. Nothing here
// touches the network; the host entry feeds it settings and request paths.

/** Plugin-owned path prefixes on dsh's origin. */
export const SPEECH_PREFIX = '/dsh-voice/speech'
export const CONTROL_PREFIX = '/dsh-voice/control'
/** Where the page reads the control plane's voice config, and where it checks the connection without changing what the relays serve. */
export const CONFIG_PATH = '/dsh-voice/voice'
export const CONFIG_CHECK_PATH = '/dsh-voice/voice/check'
/** Where the page tells the host which sessions have voice live, as `{ sessionId, live }`. */
export const LIVE_PATH = '/dsh-voice/live'
/** How often the page repeats a live report, and how long the host keeps one without a repeat. */
export const LIVE_HEARTBEAT_MS = 30_000
export const LIVE_TTL_MS = 180_000

/** The request headers that cross to an upstream: no cookie, no Origin, no Referer. */
const FORWARDED_HEADERS = new Set(['accept', 'content-type', 'content-length', 'range', 'user-agent'])

/**
 * The headers a relayed request carries upstream, for an HTTP request or a
 * WebSocket upgrade alike. An upgrade keeps the client's handshake headers;
 * the relay writes `Connection` and `Upgrade` itself.
 */
export function upstreamHeaders(incoming: Readonly<Record<string, string | string[] | undefined>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(incoming)) {
    const key = name.toLowerCase()
    if (value === undefined || !(FORWARDED_HEADERS.has(key) || key.startsWith('sec-websocket-'))) continue
    out[key] = Array.isArray(value) ? value.join(', ') : value
  }
  return out
}

/** The settings the relays read. */
export interface RelaySettings {
  sttServiceId: string
  ttsServiceId: string
  /** Further service ids served: the selection before the current one, which a running page may still use. */
  alsoServed?: readonly string[]
  controlPlaneUrl: string
  /** Real endpoint of each service the control plane has reported, by service id. */
  endpoints: Readonly<Record<string, string>>
}

/** The service ids the relays serve, configured ones only. */
export function configuredServiceIds(settings: Pick<RelaySettings, 'sttServiceId' | 'ttsServiceId' | 'alsoServed'>): string[] {
  return [...new Set([settings.sttServiceId, settings.ttsServiceId, ...(settings.alsoServed ?? [])].filter(id => id !== ''))]
}

/** Splits `<SPEECH_PREFIX>/<serviceId>/<rest>?query` into its service id and the upstream-relative remainder. */
export function parseSpeechPath(path: string): { serviceId: string; rest: string } | null {
  if (!path.startsWith(`${SPEECH_PREFIX}/`)) return null
  const tail = path.slice(SPEECH_PREFIX.length + 1)
  const slash = tail.search(/[/?]/)
  if (slash <= 0) return null
  const serviceId = decodeId(tail.slice(0, slash))
  const rest = tail.slice(slash)
  return serviceId === null || !rest.startsWith('/') ? null : { serviceId, rest }
}

/** The upstream URL for a request to the speech relay, or null when the request names anything but a configured service. */
export function resolveSpeechUpstream(settings: RelaySettings, path: string): URL | null {
  const parsed = parseSpeechPath(path)
  if (parsed === null || !configuredServiceIds(settings).includes(parsed.serviceId)) return null
  const endpoint = settings.endpoints[parsed.serviceId]
  if (endpoint === undefined) return null
  const rawPath = parsed.rest.split('?')[0] ?? ''
  if (hasDotSegment(rawPath) || /%2e|%2f|%5c|\\/i.test(rawPath)) return null
  const target = new URL(parsed.rest, 'http://relay.invalid')
  const base = new URL(endpoint)
  const basePath = base.pathname.replace(/\/+$/, '')
  return new URL(`${base.origin}${basePath}${target.pathname}${target.search}`)
}

/** Whether the control-plane relay may forward this call: the three calls the dashboard's voice code makes, for configured services. */
export function isAllowedControlCall(
  settings: Pick<RelaySettings, 'sttServiceId' | 'ttsServiceId' | 'alsoServed'>,
  method: string,
  path: string,
): boolean {
  const match = /^\/api\/services\/([^/?#]+)(\/start|\/ping)?$/.exec(path.split('?')[0] ?? '')
  if (match === null) return false
  const id = decodeId(match[1] ?? '')
  if (id === null || !configuredServiceIds(settings).includes(id)) return false
  const verb = match[2]
  if (verb === undefined) return method === 'GET'
  return method === 'POST'
}

function decodeId(raw: string): string | null {
  try {
    const id = decodeURIComponent(raw)
    return id !== '' && !id.includes('/') ? id : null
  } catch {
    return null
  }
}

function hasDotSegment(rawPath: string): boolean {
  return rawPath.split('/').some(segment => segment === '..' || segment === '.')
}
