import { describe, expect, it } from 'vitest'
import { isAllowedControlCall, resolveSpeechUpstream, upstreamHeaders } from './relay'

// INVENTED: the settings carry the endpoints the host has learned as an `endpoints` map keyed by service id (decisions.md 5; spec section 7 says only that the upstream is chosen by service id from the settings). The speech path prefix is spec section 2's relay endpoint, `/dsh-voice/speech/<id>`.
const settings = {
  sttServiceId: 'stt-a',
  ttsServiceId: 'tts-b',
  controlPlaneUrl: 'http://control.invalid:7000',
  endpoints: {
    'stt-a': 'http://stt.invalid:8000',
    'tts-b': 'http://tts.invalid:9000',
    'other-svc': 'http://other.invalid:9100',
  },
}

describe('speech relay upstream', () => {
  it('a request for the configured STT or TTS service id goes to that service, path and query intact', () => {
    expect(resolveSpeechUpstream(settings, '/dsh-voice/speech/stt-a/probe/items?x=1')?.href).toBe('http://stt.invalid:8000/probe/items?x=1')
    expect(resolveSpeechUpstream(settings, '/dsh-voice/speech/tts-b/probe/speak')?.href).toBe('http://tts.invalid:9000/probe/speak')
  })

  it('a service id that is not configured is refused, even when the host knows its endpoint', () => {
    expect(resolveSpeechUpstream(settings, '/dsh-voice/speech/other-svc/probe/items')).toBeNull()
    expect(resolveSpeechUpstream(settings, '/dsh-voice/speech/unknown/probe/items')).toBeNull()
    expect(resolveSpeechUpstream(settings, '/dsh-voice/speech//other.invalid/probe/items')).toBeNull()
  })
})

describe('control-plane relay allowlist', () => {
  // INVENTED: the `path` argument is the control plane's own path (`/api/services/:id...`, as spec section 7 writes the calls), not the relay-prefixed one.
  it('allows exactly the three calls the dashboard makes, for the configured ids', () => {
    expect(isAllowedControlCall(settings, 'GET', '/api/services/stt-a')).toBe(true)
    expect(isAllowedControlCall(settings, 'POST', '/api/services/stt-a/start')).toBe(true)
    expect(isAllowedControlCall(settings, 'POST', '/api/services/tts-b/ping')).toBe(true)
  })

  it('refuses every other control-plane call', () => {
    const refused: Array<[string, string]> = [
      ['GET', '/api/services'],
      ['GET', '/api/services/other-svc'],
      ['POST', '/api/services/other-svc/start'],
      ['POST', '/api/services/stt-a/stop'],
      ['DELETE', '/api/services/stt-a'],
      ['GET', '/api/services/stt-a/start'],
      ['POST', '/api/services/stt-a'],
      ['GET', '/api/voice'],
    ]
    for (const [method, path] of refused) {
      expect(isAllowedControlCall(settings, method, path), `${method} ${path}`).toBe(false)
    }
  })
})

describe('headers forwarded upstream', () => {
  // INVENTED: `incoming` is Node's header record (lowercase names, as `IncomingHttpHeaders`), and the result is read as either a plain record or a `Headers`; the spec's table gives only the name and the "no Origin" rule.
  const names = (h: unknown): string[] => (h instanceof Headers ? [...h.keys()] : Object.keys(h as object)).map(k => k.toLowerCase())
  const valueOf = (h: unknown, name: string): unknown => {
    if (h instanceof Headers) return h.get(name)
    const hit = Object.entries(h as Record<string, unknown>).find(([k]) => k.toLowerCase() === name)
    return hit?.[1]
  }

  it('an HTTP request is forwarded without its Origin', () => {
    const out = upstreamHeaders({ origin: 'http://dsh.invalid:3000', host: 'dsh.invalid:3000', 'content-type': 'application/json' })
    expect(names(out)).not.toContain('origin')
    // INVENTED: a request's content-type passes through (a POST body is unreadable without it); the spec does not list which headers pass.
    expect(valueOf(out, 'content-type')).toBe('application/json')
  })

  it('a WebSocket upgrade is forwarded without its Origin and keeps its handshake headers', () => {
    const out = upstreamHeaders({
      origin: 'http://dsh.invalid:3000',
      host: 'dsh.invalid:3000',
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
    })
    expect(names(out)).not.toContain('origin')
    // INVENTED: the upgrade keeps the client's Sec-WebSocket-* headers; the handshake cannot complete without them, and the spec does not list which headers pass (spike "Differed" 8 records the relay replaying them).
    expect(valueOf(out, 'sec-websocket-key')).toBe('dGhlIHNhbXBsZSBub25jZQ==')
    expect(valueOf(out, 'sec-websocket-version')).toBe('13')
  })
})
