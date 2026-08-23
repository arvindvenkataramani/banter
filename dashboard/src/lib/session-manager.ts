import type { GatewayConnection } from './gateway-connection'
import type { AgentEntry, ModelCatalogEntry, GatewaySessionRow, SessionListEntry } from './gateway-types'
import type { Session } from './session'
import { AgentRegistry } from './agent-registry'
import { SessionStore } from './session-store'
import { makeSessionKey } from './gateway-utils'

export interface SessionManagerSnapshot {
  activeSession: Session | null
  currentAgent: string
  currentSessionName: string
  currentModel: string
  contextTokens: number | null
  contextWindow: number | null
  agents: AgentEntry[]
  models: ModelCatalogEntry[]
  sessionKeys: string[]
  sessions: SessionListEntry[]
}

// Titles come from the first user message, which for some sessions is an
// injected envelope rather than anything typed. Strip it.
export function stripInjectedEnvelope(text: string): string {
  let out = text
  // Arrives collapsed to one line and truncated, so the closing fence is
  // often gone — match it when present, otherwise take the rest.
  out = out.replace(/^[^\n]*?\(untrusted metadata\):\s*```[a-z]*\s*[\s\S]*?(?:```\s*|$)/i, '')
  // Bracketed preambles like "[OpenClaw heartbeat …]" or "[WhatsApp 2026-…]".
  out = out.replace(/^\s*\[[^\]]{0,120}\]\s*/, '')
  return out.trim()
}

// Conversations this UI created, plus the agent's default session. Cron and
// channel-backed sessions belong to their own surfaces.
function isDashboardSession(name: string, defaultSessionName: string): boolean {
  return name === defaultSessionName || name.startsWith('dashboard:')
}

function toSessionList(
  rows: GatewaySessionRow[],
  prefix: string,
  defaultSessionName: string,
): SessionListEntry[] {
  return rows
    .map((row) => ({ row, name: row.key.slice(prefix.length) }))
    .filter(({ name }) => isDashboardSession(name, defaultSessionName))
    .map(({ row, name }) => {
      // derivedTitle comes from the gateway (first user message); fall back to
      // an explicit label, then to the bare name for untitled sessions.
      const derived = stripInjectedEnvelope(row.derivedTitle ?? '')
      return {
        key: row.key,
        name,
        title: derived || row.label?.trim() || name,
        preview: stripInjectedEnvelope(row.lastMessagePreview ?? '') || undefined,
        updatedAt: row.updatedAt,
      }
    })
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}

function persistDefaultAgent(agentId: string): void {
  fetch('/api/gateway/defaultAgent', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentId }),
  }).catch(() => {})
}

function persistLastSession(agentId: string, sessionName: string): void {
  fetch('/api/gateway/lastSession', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentId, sessionName }),
  }).catch(() => {})
}

export class SessionManager {
  private connection: GatewayConnection
  private agentRegistry: AgentRegistry
  private sessionStore: SessionStore

  private _activeSession: Session | null = null
  private _currentAgent = ''
  private _currentSessionName = ''
  private _currentModel = ''
  private _contextTokens: number | null = null
  private _contextWindow: number | null = null
  private _modelCatalog: ModelCatalogEntry[] = []
  private _models: ModelCatalogEntry[] = []
  private _sessionKeys: string[] = []
  private _sessionList: SessionListEntry[] = []
  private initialized = false
  private _modelPatchPending = false

  private listeners = new Set<() => void>()
  private snapshot: SessionManagerSnapshot = {
    activeSession: null,
    currentAgent: '',
    currentSessionName: '',
    currentModel: '',
    contextTokens: null,
    contextWindow: null,
    agents: [],
    models: [],
    sessionKeys: [],
    sessions: [],
  }

  private preferredAgentId: string | undefined
  private defaultSessionName: string
  private lastSessionByAgent: Record<string, string>
  private unsubscribeEvent: (() => void) | null = null
  private unsubscribeAgentEvent: (() => void) | null = null
  private unsubscribeSessionTool: (() => void) | null = null
  private unsubscribeConversationEvent: (() => void) | null = null

  constructor(
    connection: GatewayConnection,
    preferredAgentId?: string,
    defaultSession?: string,
    lastSessionByAgent?: Record<string, string>
  ) {
    this.connection = connection
    this.agentRegistry = new AgentRegistry()
    this.sessionStore = new SessionStore()
    this.preferredAgentId = preferredAgentId
    this.defaultSessionName = defaultSession ?? 'main'
    this.lastSessionByAgent = lastSessionByAgent ?? {}
    // Reconnect is a fresh projection over durable history, not a resumption of
    // in-memory state: anything that landed while we were offline is only
    // visible by re-fetching. Event listeners are keyed by sessionKey and
    // outlive the socket, so they don't need re-establishing.
    this.connection.onReconnected = () => {
      // Reconnect is a new projection over durable history, not a resumption:
      // drop any live-run residue before re-fetching, so a run that was
      // mid-flight when the connection dropped doesn't leave stale items.
      const session = this._activeSession
      if (session) {
        session.conversation.reset()
        // Subscriptions are per-connection — this session-scoped one was
        // previously only ever issued once, in switchTo, and silently never
        // re-established after a reconnect.
        this.connection.call('sessions.messages.subscribe', { key: session.sessionKey }).catch(() => {})
        session.loadHistory().catch(() => {})
      }
      // Subscriptions are per-connection, so re-establish after a reconnect.
      this.subscribeSessions()
      if (this._currentAgent) this.refreshSessionKeys(this._currentAgent).then(() => this.notify()).catch(() => {})
    }
    // Reorders the list as conversations are touched, here or on another device.
    this.connection.onSessionsChanged = () => {
      if (!this._currentAgent) return
      this.refreshSessionKeys(this._currentAgent).then(() => this.notify()).catch(() => {})
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      // Session surfaces the failure via errorMessage; swallow here so the
      // rejection doesn't escape as an unhandled promise.
      this._activeSession?.loadHistory().catch(() => {})
      return
    }
    this.initialized = true
    this.subscribeSessions()

    const [agentsResult, modelsResult] = await Promise.all([
      this.connection.call('agents.list', {}).catch(() => null),
      this.connection.call('models.list', {}).catch(() => null),
    ])

    const agents = agentsResult as { defaultId?: string; agents?: AgentEntry[] } | null
    if (agents?.agents?.length) {
      this.agentRegistry.populate(agents.agents, agents.defaultId)
    }

    const models = modelsResult as { models?: ModelCatalogEntry[] } | null
    if (models?.models?.length) {
      this._modelCatalog = models.models
    }

    const preferred = this.preferredAgentId ? this.agentRegistry.list().find(a => a.id === this.preferredAgentId) : undefined
    const agentId = preferred?.id ?? this.agentRegistry.getDefault()?.id ?? this.agentRegistry.list()[0]?.id ?? 'main'
    // Restore the last conversation actually viewed for this agent, not just
    // its structural default — a reload otherwise always lands back on
    // defaultSessionName regardless of what the user was last looking at.
    await this.switchTo(agentId, this.lastSessionByAgent[agentId])
  }

  private subscribeSessions(): void {
    this.connection.call('sessions.subscribe', {}).catch(() => {})
  }

  async switchTo(agentId: string, sessionName?: string): Promise<void> {
    const name = sessionName ?? (this._currentSessionName || this.defaultSessionName)
    const key = makeSessionKey(agentId, name)
    const session = this.sessionStore.getOrCreate(key, this.connection)

    this.unsubscribeEvent?.()
    this.unsubscribeAgentEvent?.()
    this.unsubscribeSessionTool?.()
    this.unsubscribeConversationEvent?.()
    this.unsubscribeEvent = this.connection.addEventListener(key, (e) => session.applyEvent(e))
    // Compaction now routes entirely through Conversation.ingest (fed via
    // addAgentEventListener below) — the old compaction-only registry was
    // retired. The one side effect that registry used to trigger (refreshing
    // session metadata once a compaction completes) now comes from
    // Conversation's own ordered tap, which sees every event including
    // compaction ones.
    this.unsubscribeConversationEvent = session.conversation.onEvent((e) => {
      if (e.kind === 'compaction' && e.phase === 'end' && e.completed) {
        this.refreshSessionMetadata().catch(() => {})
      }
    })
    this.unsubscribeAgentEvent = this.connection.addAgentEventListener(key, (p) => session.applyAgentEvent(p))
    this.unsubscribeSessionTool = this.connection.addSessionToolListener(key, (p) => session.applySessionToolEvent(p))

    // Its old transcript-scraping consumer is retired — kept because it may
    // be load-bearing for multi-device liveness; removal is a separate decision.
    this.connection.call('sessions.messages.subscribe', { key }).catch(() => {})

    const agentChanged = this._currentAgent !== agentId
    this._activeSession = session
    this._currentAgent = agentId
    this._currentSessionName = name
    this._models = this.modelsForAgent(agentId)

    if (agentChanged && this.initialized) {
      persistDefaultAgent(agentId)
    }
    if (this.initialized) {
      this.lastSessionByAgent[agentId] = name
      persistLastSession(agentId, name)
    }

    session.onRunComplete = () => {
      this.refreshSessionMetadata().catch(() => {})
    }

    // Fetch sessions for this agent
    await this.refreshSessionKeys(agentId)

    this.notify()

    session.loadHistory().catch(() => {})
  }

  // Open an existing conversation for the current agent.
  selectSession(sessionName: string): Promise<void> {
    if (sessionName === this._currentSessionName) return Promise.resolve()
    return this.switchTo(this._currentAgent, sessionName)
  }

  newSession(): Promise<void> {
    if (!this._activeSession) return Promise.resolve()
    return this._activeSession.reset()
  }

  // Selector option keys and the gateway's models.list ids both use the qualified
  // `provider/model` form. The gateway's session row splits these into separate
  // `model` and `modelProvider` fields — refreshSession* recombines them.
  async patchModel(qualifiedModel: string): Promise<void> {
    if (!this._activeSession) return
    const session = this._activeSession
    this._currentModel = qualifiedModel
    this._modelPatchPending = true
    this.notify()
    try {
      await session.sendModelCommand(qualifiedModel)
      this._modelPatchPending = false
      const resolved = await this.fetchActiveModel()
      if (!resolved) {
        throw new Error('Model switch failed: gateway did not report a model')
      }
      if (resolved !== qualifiedModel) {
        this._currentModel = resolved
        this.notify()
        throw new Error(`Model switch failed: gateway resolved to ${resolved}`)
      }
      this._currentModel = resolved
      this.notify()
    } catch (err) {
      this._modelPatchPending = false
      throw err
    }
  }

  // Fetches the active session row and returns its qualified model, if any.
  // Used to verify model-switch success without going through the refresh side effects.
  private async fetchActiveModel(): Promise<string | null> {
    try {
      const payload = await this.connection.call('sessions.list', {})
      const res = payload as { sessions?: GatewaySessionRow[] }
      const activeKey = makeSessionKey(this._currentAgent, this._currentSessionName)
      const activeRow = res?.sessions?.find((s) => s.key === activeKey)
      if (!activeRow?.model) return null
      return activeRow.modelProvider
        ? `${activeRow.modelProvider}/${activeRow.model}`
        : activeRow.model
    } catch {
      return null
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot(): SessionManagerSnapshot {
    return this.snapshot
  }

  private async refreshSessionMetadata(): Promise<void> {
    try {
      const payload = await this.connection.call('sessions.list', {})
      const res = payload as { sessions?: GatewaySessionRow[] }
      if (res?.sessions) {
        const activeKey = makeSessionKey(this._currentAgent, this._currentSessionName)
        const activeRow = res.sessions.find((s) => s.key === activeKey)
        if (activeRow) {
          this._contextTokens = activeRow.totalTokens ?? null
          this._contextWindow = activeRow.contextTokens ?? null
          const qualified = activeRow.model
            ? (activeRow.modelProvider ? `${activeRow.modelProvider}/${activeRow.model}` : activeRow.model)
            : null
          if (qualified && !this._modelPatchPending) {
            this._currentModel = qualified
          }
          this.notify()
        }
      }
    } catch {
      // ignore
    }
  }

  private modelsForAgent(agentId: string): ModelCatalogEntry[] {
    const agent = this.agentRegistry.list().find((a) => a.id === agentId)
    if (!agent?.model) return this._modelCatalog

    // Dedupe: a model can be listed as both primary and a fallback (or repeated
    // across fallbacks). Each qualified id must appear once, or the selector
    // renders duplicate-keyed options. Preserve first-seen order (primary first).
    const ids: string[] = []
    const seen = new Set<string>()
    const pushUnique = (id: string) => { if (!seen.has(id)) { seen.add(id); ids.push(id) } }
    if (agent.model.primary) pushUnique(agent.model.primary)
    if (agent.model.fallbacks) agent.model.fallbacks.forEach(pushUnique)
    if (ids.length === 0) return this._modelCatalog

    // models.list returns bare ids (e.g. "qwen/qwen3.5-35b-a3b") with provider as a
    // separate field; agents reference the qualified form ("lmstudio/qwen/..."). Key
    // the lookup map by the qualified form so name/alias survive the join.
    const catalogByQualified = new Map(
      this._modelCatalog.map((m) => [m.provider ? `${m.provider}/${m.id}` : m.id, m]),
    )
    return ids.map((qualified) => {
      const entry = catalogByQualified.get(qualified)
      if (entry) return { ...entry, id: qualified }
      return { id: qualified, name: qualified, provider: '' }
    })
  }

  private async refreshSessionKeys(agentId: string): Promise<void> {
    try {
      // Titles and previews require reading each transcript, so the gateway
      // only computes them on request. Asked for here alone — the model/context
      // refreshes below don't need them.
      const payload = await this.connection.call('sessions.list', {
        includeDerivedTitles: true,
        includeLastMessage: true,
      })
      const res = payload as { sessions?: GatewaySessionRow[] }
      if (res?.sessions) {
        const prefix = `agent:${agentId}:`
        const agentSessions = res.sessions.filter((s) => s.key.startsWith(prefix))
        this._sessionKeys = agentSessions.map((s) => s.key.slice(prefix.length))
        if (!this._sessionKeys.includes(this.defaultSessionName)) {
          this._sessionKeys.unshift(this.defaultSessionName)
        }
        this._sessionList = toSessionList(agentSessions, prefix, this.defaultSessionName)

        // Read the effective model and context usage from the active session's row
        const activeKey = makeSessionKey(agentId, this._currentSessionName)
        const activeRow = res.sessions.find((s) => s.key === activeKey)
        const qualified = activeRow?.model
          ? (activeRow.modelProvider ? `${activeRow.modelProvider}/${activeRow.model}` : activeRow.model)
          : null
        if (qualified && !this._modelPatchPending) {
          this._currentModel = qualified
        }
        this._contextTokens = activeRow?.totalTokens ?? null
        this._contextWindow = activeRow?.contextTokens ?? null
      }
    } catch {
      this._sessionKeys = [this.defaultSessionName]
    }
  }

  private notify() {
    this.snapshot = {
      activeSession: this._activeSession,
      currentAgent: this._currentAgent,
      currentSessionName: this._currentSessionName,
      currentModel: this._currentModel,
      contextTokens: this._contextTokens,
      contextWindow: this._contextWindow,
      agents: this.agentRegistry.list(),
      models: this._models,
      sessionKeys: this._sessionKeys,
      sessions: this._sessionList,
    }
    for (const listener of this.listeners) {
      listener()
    }
  }
}
