import type { ConnectionState, ChatEventPayload } from './gateway-types'
import { normalizeChatPayload } from './gateway-utils'
import { signChallenge, getDeviceIdPrefix } from './device-identity'

export type { ConnectionState, ChatEventPayload }

const CONNECT_PROTOCOL = 4
const OPERATOR_SCOPES = [
  'operator.admin',
  'operator.read',
  'operator.write',
  'operator.approvals',
  'operator.pairing',
]
// Mirrors GATEWAY_CLIENT_CAPS. Declare only what we implement — without
// 'tool-events' no live tool events arrive and the handshake reports no error.
const CLIENT_CAPS = ['tool-events']

// Display-name precedence: operator label, then client displayName, then
// clientId, then raw deviceId. Without this, devices list shows only hex.
function describeClient(deviceIdPrefix: string): string {
  if (typeof navigator === 'undefined') return `Banter · ${deviceIdPrefix}`
  const ua = navigator.userAgent
  const browser = /Firefox\//.test(ua)
    ? 'Firefox'
    : /Edg\//.test(ua)
      ? 'Edge'
      : /Chrome\//.test(ua) && !/Chromium\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'browser'
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : ''
  // Saved-to-home-screen installs report standalone; browser tabs don't. This
  // is what separates a PWA from a tab of the same browser on the same device.
  const standalone =
    (typeof matchMedia !== 'undefined' && matchMedia('(display-mode: standalone)').matches) ||
    (navigator as { standalone?: boolean }).standalone === true
  const where = [os, browser].filter(Boolean).join(' ')
  // __COMMIT_SHA__ is null only in production builds. Presence, not value —
  // the name is written once at pairing and never refreshed.
  const build = __COMMIT_SHA__ ? ' [dev]' : ''
  return `Banter ${standalone ? 'app' : 'tab'}${build} — ${where} · ${deviceIdPrefix}`
}
const INITIAL_RECONNECT_DELAY_MS = 1_000
const MAX_RECONNECT_DELAY_MS = 15_000
const MAX_RECONNECT_ATTEMPTS = 8

type PendingRequest = {
  resolve: (payload: unknown) => void
  reject: (error: unknown) => void
}

export interface GatewayConnectionOptions {
  url: string
  token: string
  onStateChange: (state: ConnectionState) => void
}

export class GatewayConnection {
  private url: string
  private token: string
  private onStateChange: (state: ConnectionState) => void

  private ws: WebSocket | null = null
  private state: ConnectionState = 'disconnected'
  private requestCounter = 0
  private pending = new Map<string, PendingRequest>()
  private closed = false
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private connectRequestId: string | null = null

  // Challenge nonce from connect.challenge
  private challengeNonce: string | null = null

  // True once we've completed at least one handshake, so the next successful
  // connect is a *re*connect and needs history re-projected.
  private hasConnectedBefore = false

  // Reconnect is a new projection over durable history: re-subscribe and
  // re-fetch rather than trusting in-memory state.
  onReconnected: (() => void) | null = null

  // Fired on `sessions.changed`. The catalog is event-driven — the client guide
  // says to subscribe rather than poll for session/usage updates.
  onSessionsChanged: (() => void) | null = null

  // Per-sessionKey event listeners
  private eventListeners = new Map<string, Set<(event: ChatEventPayload) => void>>()
  private agentEventListeners = new Map<string, Set<(payload: unknown) => void>>()
  private sessionToolListeners = new Map<string, Set<(payload: unknown) => void>>()

  constructor(opts: GatewayConnectionOptions) {
    this.url = opts.url
    this.token = opts.token
    this.onStateChange = opts.onStateChange
  }

  addEventListener(sessionKey: string, cb: (event: ChatEventPayload) => void): () => void {
    let set = this.eventListeners.get(sessionKey)
    if (!set) {
      set = new Set()
      this.eventListeners.set(sessionKey, set)
    }
    set.add(cb)
    return () => {
      set!.delete(cb)
      if (set!.size === 0) this.eventListeners.delete(sessionKey)
    }
  }

  // Fans out every `agent` event's whole payload, regardless of stream — the
  // ground-truth Conversation layer normalizes tool/lifecycle/item/thinking/
  // compaction/unknown streams itself. Not stream-filtered at this layer;
  // the old compaction-only registry was retired once Conversation.ingest
  // took over compaction handling.
  addAgentEventListener(sessionKey: string, cb: (payload: unknown) => void): () => void {
    let set = this.agentEventListeners.get(sessionKey)
    if (!set) {
      set = new Set()
      this.agentEventListeners.set(sessionKey, set)
    }
    set.add(cb)
    return () => {
      set!.delete(cb)
      if (set!.size === 0) this.agentEventListeners.delete(sessionKey)
    }
  }

  // `session.tool` is the late-attach mirror of the agent tool stream. No
  // captured example of this event was available, so the normalizer on the
  // receiving end is tolerant of the payload being shaped differently than
  // expected.
  addSessionToolListener(sessionKey: string, cb: (payload: unknown) => void): () => void {
    let set = this.sessionToolListeners.get(sessionKey)
    if (!set) {
      set = new Set()
      this.sessionToolListeners.set(sessionKey, set)
    }
    set.add(cb)
    return () => {
      set!.delete(cb)
      if (set!.size === 0) this.sessionToolListeners.delete(sessionKey)
    }
  }

  connect() {
    if (this.closed) return

    this.setState(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting')

    const ws = new WebSocket(this.url)
    this.ws = ws
    this.connectRequestId = null
    this.requestCounter = 0

    ws.onmessage = (ev) => {
      let frame: { type: string; event?: string; payload?: unknown; id?: string; ok?: boolean; error?: unknown; seq?: number }
      try {
        frame = JSON.parse(ev.data as string)
      } catch {
        return
      }
      this.handleFrame(frame)
    }

    ws.onclose = () => {
      if (this.closed) return
      this.rejectPending('Gateway connection closed.')
      this.connectRequestId = null
      this.setState('disconnected')
      this.scheduleReconnect()
    }

    ws.onerror = () => {
      // onclose fires after onerror; reconnect is handled there
    }
  }

  disconnect() {
    this.closed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.rejectPending('Gateway disconnected.')
    this.ws?.close()
    this.ws = null
  }

  // Reset retry counter and reconnect — call after giving up
  reconnect() {
    if (this.closed) return
    this.reconnectAttempt = 0
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.connect()
  }

  getState(): ConnectionState {
    return this.state
  }

  call(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Not connected'))
        return
      }
      const id = this.nextId()
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ type: 'req', id, method, params }))
    })
  }

  private scheduleReconnect() {
    if (this.closed) return
    if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      return
    }
    if (this.reconnectTimer) return
    const delay = Math.min(
      INITIAL_RECONNECT_DELAY_MS * Math.pow(1.7, this.reconnectAttempt),
      MAX_RECONNECT_DELAY_MS
    )
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private setState(s: ConnectionState) {
    this.state = s
    this.onStateChange(s)
  }

  private nextId(): string {
    return String(++this.requestCounter)
  }

  private rejectPending(msg: string) {
    for (const [, p] of this.pending) {
      p.reject(new Error(msg))
    }
    this.pending.clear()
  }

  private handleFrame(frame: { type: string; event?: string; payload?: unknown; id?: string; ok?: boolean; error?: unknown; seq?: number }) {
    if (frame.type === 'event') {
      this.handleEvent(frame.event ?? '', frame.payload)
    } else if (frame.type === 'res' && frame.id) {
      this.handleResponse(frame.id, frame.ok ?? false, frame.payload, frame.error)
    }
  }

  private handleEvent(event: string, payload: unknown) {
    if (event === 'connect.challenge') {
      const challenge = payload as { nonce?: string } | undefined
      this.challengeNonce = challenge?.nonce ?? null
      this.sendConnectRequest()
    } else if (event === 'chat') {
      const normalized = normalizeChatPayload(payload)
      const listeners = this.eventListeners.get(normalized.sessionKey)
      if (listeners) {
        for (const cb of listeners) cb(normalized)
      }
    } else if (event === 'sessions.changed') {
      this.onSessionsChanged?.()
    } else if (event === 'agent') {
      const p = payload as { sessionKey?: string }
      if (p.sessionKey) {
        const agentListeners = this.agentEventListeners.get(p.sessionKey)
        if (agentListeners) {
          for (const cb of agentListeners) cb(payload)
        }
      }
    } else if (event === 'session.tool') {
      const p = payload as { sessionKey?: string } | undefined
      if (p?.sessionKey) {
        const listeners = this.sessionToolListeners.get(p.sessionKey)
        if (listeners) {
          for (const cb of listeners) cb(payload)
        }
      }
    }
  }

  private async sendConnectRequest() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.connectRequestId) return
    const id = this.nextId()
    this.connectRequestId = id

    const clientId = 'webchat-ui'
    const clientMode = 'webchat'
    const role = 'operator'

    const deviceIdPrefix = await getDeviceIdPrefix().catch(() => '??????')

    let device = undefined
    if (this.challengeNonce) {
      try {
        device = await signChallenge(this.challengeNonce, this.token, clientId, clientMode, role, OPERATOR_SCOPES)
      } catch (err) {
        console.error('[gateway] device signing failed, connecting without device:', err)
      }
    }

    const params = {
      minProtocol: CONNECT_PROTOCOL,
      maxProtocol: CONNECT_PROTOCOL,
      client: {
        id: clientId,
        displayName: describeClient(deviceIdPrefix),
        version: '0.1.0',
        platform: 'web',
        mode: clientMode,
        deviceFamily: 'browser',
      },
      role,
      scopes: OPERATOR_SCOPES,
      caps: CLIENT_CAPS,
      auth: { token: this.token },
      device,
    }
    this.pending.set(id, {
      resolve: () => {
        this.reconnectAttempt = 0
        this.setState('connected')
        const wasReconnect = this.hasConnectedBefore
        this.hasConnectedBefore = true
        if (wasReconnect) this.onReconnected?.()
      },
      reject: (err) => {
        console.error('[gateway] connect rejected:', err)
      },
    })
    this.ws.send(JSON.stringify({ type: 'req', id, method: 'connect', params }))
  }

  private handleResponse(id: string, ok: boolean, payload: unknown, error: unknown) {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    if (ok) {
      p.resolve(payload)
    } else {
      const err = error && typeof error === 'object' && 'message' in error
        ? new Error(String((error as { message: unknown }).message))
        : new Error('Gateway request failed')
      p.reject(err)
    }
  }
}
