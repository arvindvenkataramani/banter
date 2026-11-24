import { describe, expect, it } from 'vitest'
import { isAllowedControlCall, resolveSpeechUpstream } from '../host/relay'
import { createPluginServices, relayEndpoint, streamingEndpoint } from './services'

const origin = 'http://dsh.invalid:3000'

// The service ids and their real endpoints; the plugin must never hand the engine the latter.
const real = { 'stt-a': 'http://stt.invalid:8000', 'tts-b': 'http://tts.invalid:9000' } as const
const settings = { sttServiceId: 'stt-a', ttsServiceId: 'tts-b', controlPlaneUrl: 'http://control.invalid:7000', endpoints: { ...real } }

/**
 * A stand-in for the control plane behind the relay, answering in the shapes the
 * dashboard reads (api.ts: a service with `health`, `pending` and `network.endpoint`,
 * `{ success }` from a start, `{ ok }` from a ping). Requests are matched by their
 * `/api/services/<id>` suffix, so the relay's own path prefix is not pinned here.
 */
function controlPlane(healthy: Record<string, boolean>) {
  const calls: Array<{ method: string; url: string }> = []
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    calls.push({ method, url })
    const hit = /\/api\/services\/([^/?]+)(\/start|\/ping)?$/.exec(url)
    const id = hit?.[1]
    const verb = hit?.[2]
    if (!id || !(id in real)) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    if (verb === '/start' && method === 'POST') {
      healthy[id] = true
      return json({ success: true })
    }
    if (verb === '/ping' && method === 'POST') return json({ ok: true })
    if (!verb && method === 'GET') {
      return json({ id, health: healthy[id] ? 'healthy' : 'unhealthy', pending: false, network: { endpoint: real[id as keyof typeof real] } })
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
  }
  return { fetch: fetch as typeof globalThis.fetch, calls }
}

describe('plugin services', () => {
  it('readiness resolves to the relay endpoint, never the service\'s own, and a healthy service is not started', async () => {
    const cp = controlPlane({ 'stt-a': true, 'tts-b': true })
    const services = createPluginServices({ origin, fetch: cp.fetch })

    expect(await services.ensureServiceReady('stt-a')).toBe('http://dsh.invalid:3000/dsh-voice/speech/stt-a')
    expect(await services.ensureTtsReady('tts-b')).toBe('http://dsh.invalid:3000/dsh-voice/speech/tts-b')
    expect(relayEndpoint(origin, 'stt-a')).toBe('http://dsh.invalid:3000/dsh-voice/speech/stt-a')
    expect(cp.calls.some(c => c.method === 'POST')).toBe(false)
  })

  it('a service that is not healthy is started once, and readiness still resolves to the relay endpoint', async () => {
    const cp = controlPlane({ 'stt-a': false, 'tts-b': true })
    const services = createPluginServices({ origin, fetch: cp.fetch })

    expect(await services.ensureServiceReady('stt-a')).toBe(relayEndpoint(origin, 'stt-a'))
    expect(cp.calls.filter(c => c.method === 'POST' && c.url.endsWith('/api/services/stt-a/start'))).toHaveLength(1)
  })

  it('every control-plane call goes through the plugin origin and is one the host relay allows', async () => {
    const cp = controlPlane({ 'stt-a': false, 'tts-b': true })
    const services = createPluginServices({ origin, fetch: cp.fetch })
    await services.ensureServiceReady('stt-a')
    await services.ensureTtsReady('tts-b')
    // The engine's services type: ping(serviceId) resolves to a value it ignores (voice-system.ts).
    await services.ping('stt-a')

    expect(cp.calls.length).toBeGreaterThan(0)
    for (const { method, url } of cp.calls) {
      expect(url.startsWith(`${origin}/`), url).toBe(true)
      const { pathname } = new URL(url)
      // INVENTED: the host's allowlist is handed the control plane's own path (relay.test.ts), the suffix from `/api/` on.
      expect(isAllowedControlCall(settings, method, pathname.slice(pathname.indexOf('/api/'))), `${method} ${url}`).toBe(true)
    }
  })

  it('the relay endpoint the engine is given is one the host resolves to the configured service', () => {
    const url = new URL(`${relayEndpoint(origin, 'stt-a')}/probe/items?x=1`)
    expect(resolveSpeechUpstream(settings, url.pathname + url.search)?.href).toBe('http://stt.invalid:8000/probe/items?x=1')
  })
})

describe('the streaming endpoint', () => {
  it('moves a relay endpoint from the desktop page\'s origin onto the Host\'s stream base, path intact', () => {
    expect(streamingEndpoint('dsh-app://app/dsh-voice/speech/stt-a', 'dsh-app://app', 'http://127.0.0.1:51234/'))
      .toBe('http://127.0.0.1:51234/dsh-voice/speech/stt-a')
  })

  it('leaves the endpoint alone on a page without a stream base, and one not on the page\'s origin', () => {
    expect(streamingEndpoint('http://127.0.0.1:3080/dsh-voice/speech/stt-a', 'http://127.0.0.1:3080', undefined))
      .toBe('http://127.0.0.1:3080/dsh-voice/speech/stt-a')
    expect(streamingEndpoint('http://elsewhere.invalid/x', 'dsh-app://app', 'http://127.0.0.1:51234')).toBe('http://elsewhere.invalid/x')
  })
})
