// OpenClaw gateway protocol types
// Types for the OpenClaw gateway websocket protocol — see https://docs.openclaw.ai/.
// Mirrors the wire format the gateway sends; nothing here reads OpenClaw's
// on-disk layout, and nothing should. The gateway URL in config.json is the
// only coupling between this platform and an OpenClaw install.

// --- Connection state ---

export type ConnectionState = 'connecting' | 'reconnecting' | 'connected' | 'disconnected'

// --- Frame discriminators ---

export interface GatewayRequest {
  type: 'req'
  id: string
  method: string
  params: Record<string, unknown>
}

export interface GatewayResponse {
  type: 'res'
  id: string
  ok: boolean
  payload?: Record<string, unknown>
  error?: Record<string, unknown>
}

export interface GatewayEvent {
  type: 'event'
  event: string
  payload: Record<string, unknown>
  seq?: number
  stateVersion?: number
}

export interface TickFrame {
  type: 'tick'
  ts: number
}

export interface HelloOk {
  type: 'hello-ok'
  protocol: number
  policy: { tickIntervalMs: number }
  auth: {
    deviceToken: string
    role: string
    scopes: string[]
    deviceTokens: unknown[]
  }
}

export interface ShutdownFrame {
  type: 'shutdown'
  reason: string
  restartExpectedMs?: number
}

export type IncomingFrame = GatewayResponse | GatewayEvent | TickFrame | HelloOk | ShutdownFrame

// --- Connect ---

export interface ConnectChallenge {
  nonce: string
  ts: number
}

export interface ConnectParams {
  minProtocol: number
  maxProtocol: number
  client: {
    id: string
    version: string
    platform: string
  }
  role: 'node'
  scopes: string[]
  caps: unknown[]
  commands: unknown[]
  auth: { token: string }
  locale: string
}

// --- Chat ---

export interface ChatSendParams {
  sessionKey: string
  message: string
  idempotencyKey: string
}

export interface ChatAbortParams {
  sessionKey: string
  runId?: string
}

export type ChatEventState = 'delta' | 'final' | 'aborted' | 'error'

export interface ChatEventPayload {
  runId: string
  sessionKey: string
  seq: number
  state: ChatEventState
  message: string
  errorMessage?: string
  usage?: Record<string, unknown>
  stopReason?: string
}

// --- Sessions ---

export interface SessionsResetParams {
  key: string
  reason?: 'new' | 'reset'
}

export interface SessionsGetParams {
  key: string
}

export interface SessionsCreateParams {
  key?: string
  agentId?: string
  label?: string
  model?: string
}

export interface SessionsPatchParams {
  key: string
  model?: string
  label?: string
}

// --- Agents ---

export interface AgentModel {
  primary?: string
  fallbacks?: string[]
}

export interface AgentEntry {
  id: string
  name?: string
  label?: string
  default?: boolean
  model?: AgentModel
}

export interface AgentsListResponse {
  agents: AgentEntry[]
}

// --- Models ---

export interface ModelCatalogEntry {
  id: string
  name: string
  provider: string
  alias?: string
  contextWindow?: number
  reasoning?: boolean
  input?: Array<'text' | 'image' | 'document'>
}

// --- Sessions ---

export interface GatewaySessionRow {
  key: string
  kind: 'direct' | 'group' | 'global' | 'unknown'
  label?: string
  // Returned only when sessions.list is called with includeDerivedTitles /
  // includeLastMessage — both cost a transcript read, so they are opt-in.
  derivedTitle?: string
  lastMessagePreview?: string
  updatedAt: number | null
  model?: string
  modelProvider?: string
  contextTokens?: number
  totalTokens?: number
}

// A dashboard-created conversation, as shown in the session list.
export interface SessionListEntry {
  key: string
  name: string
  title: string
  preview?: string
  updatedAt: number | null
}

export interface SessionsListResult {
  sessions: GatewaySessionRow[]
}

// --- Gateway config (from control plane /api/gateway) ---

export interface GatewayConfig {
  url: string
  token: string
}
