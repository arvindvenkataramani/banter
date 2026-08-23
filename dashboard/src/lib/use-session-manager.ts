import { useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react'
import type { ConnectionState, AgentEntry, ModelCatalogEntry, SessionListEntry } from './gateway-types'
import type { Message } from './chat-types'
import type { CompactionPhase } from './session'
import type { Session } from './session'
import type { SessionManagerSnapshot } from './session-manager'
import type { ConversationItem, ConversationSnapshot } from './conversation-store'
import type { Activity } from './run-state'
import { SessionManager } from './session-manager'
import { useGateway } from './gateway-context'

const EMPTY_AGENTS: AgentEntry[] = []
const EMPTY_MESSAGES: Message[] = []
const EMPTY_MODELS: ModelCatalogEntry[] = []
const EMPTY_SESSION_KEYS: string[] = []
const EMPTY_SESSIONS: SessionListEntry[] = []
const EMPTY_MANAGER_SNAPSHOT: SessionManagerSnapshot = {
  activeSession: null,
  currentAgent: '',
  currentSessionName: '',
  currentModel: '',
  contextTokens: null,
  contextWindow: null,
  agents: EMPTY_AGENTS,
  models: EMPTY_MODELS,
  sessionKeys: EMPTY_SESSION_KEYS,
  sessions: EMPTY_SESSIONS,
}
const EMPTY_SESSION_SNAPSHOT = { messages: EMPTY_MESSAGES, isStreaming: false, isTyping: false, errorMessage: null }
const EMPTY_ITEMS: ConversationItem[] = []
const EMPTY_CONVERSATION_SNAPSHOT: ConversationSnapshot = {
  items: EMPTY_ITEMS,
  known: true,
  runActive: false,
  runId: null,
  activity: 'idle',
  error: null,
  compactionPhase: null,
}

export interface GatewayConfig {
  url: string
  token: string
  defaultAgent?: string
  defaultSession?: string
  lastSessionByAgent?: Record<string, string>
}

export interface SessionManagerHandle {
  connectionState: ConnectionState
  activeSession: Session | null
  agents: AgentEntry[]
  models: ModelCatalogEntry[]
  sessionKeys: string[]
  sessions: SessionListEntry[]
  currentAgent: string
  currentSessionName: string
  currentModel: string
  contextTokens: number | null
  contextWindow: number | null
  errorMessage: string | null
  compactionPhase: CompactionPhase
  items: ReadonlyArray<ConversationItem>
  runActive: boolean
  activity: Activity | 'unknown'
  error: string | null
  switchTo: (agentId: string, sessionName?: string) => Promise<void>
  selectSession: (sessionName: string) => Promise<void>
  newSession: () => Promise<void>
  send: (text: string) => Promise<void>
  stop: () => void
  resend: (itemId: string) => Promise<void>
  patchModel: (model: string) => Promise<void>
  inject: (text: string) => Promise<void>
  reconnect: () => void
}

export function useSessionManager(): SessionManagerHandle {
  const { connection, state: connectionState, config, reconnect: reconnectGateway } = useGateway()
  const managerRef = useRef<SessionManager | null>(null)
  const [managerVersion, setManagerVersion] = useState(0)

  // Create/replace SessionManager when connection or config changes. The
  // individual config fields are the real dependencies — depending on the
  // config object itself would rebuild the manager on every fetch that
  // returned equivalent values.
  const hasConfig = config != null
  const defaultAgent = config?.defaultAgent
  const defaultSession = config?.defaultSession
  const lastSessionByAgent = config?.lastSessionByAgent
  useEffect(() => {
    if (!connection || !hasConfig) return
    const manager = new SessionManager(connection, defaultAgent, defaultSession, lastSessionByAgent)
    managerRef.current = manager
    setManagerVersion((v) => v + 1)
    return () => {
      managerRef.current = null
    }
  }, [connection, hasConfig, defaultAgent, defaultSession, lastSessionByAgent])

  // Initialize once the gateway reports connected.
  useEffect(() => {
    if (connectionState === 'connected') {
      setTimeout(() => {
        managerRef.current?.initialize().catch(() => {})
      }, 100)
    }
  }, [connectionState])

  // Connection state leaving 'connected' means the active session's ground
  // truth is stale until the next reconnect projection re-establishes it —
  // surfaces should show "unknown", not silently keep the last-known state.
  const prevConnectionStateRef = useRef<ConnectionState>(connectionState)
  useEffect(() => {
    if (prevConnectionStateRef.current === 'connected' && connectionState !== 'connected') {
      managerRef.current?.getSnapshot().activeSession?.conversation.markUnknown()
    }
    prevConnectionStateRef.current = connectionState
  }, [connectionState])

  const subscribeManager = useCallback((cb: () => void) => {
    return managerRef.current?.subscribe(cb) ?? (() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [managerVersion])
  const getManagerSnapshot = useCallback(() => {
    return managerRef.current?.getSnapshot() ?? EMPTY_MANAGER_SNAPSHOT
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [managerVersion])

  const managerSnapshot = useSyncExternalStore(subscribeManager, getManagerSnapshot)

  // Session subscription: re-subscribes when the active session changes.
  const activeSession: Session | null = managerSnapshot.activeSession

  const subscribeSession = useCallback((cb: () => void) => {
    return activeSession?.subscribe(cb) ?? (() => {})
  }, [activeSession])
  const getSessionSnapshot = useCallback(() => {
    return activeSession?.getSnapshot() ?? EMPTY_SESSION_SNAPSHOT
  }, [activeSession])

  const sessionSnapshot = useSyncExternalStore(subscribeSession, getSessionSnapshot)

  const subscribeConversation = useCallback((cb: () => void) => {
    return activeSession?.conversation.subscribe(cb) ?? (() => {})
  }, [activeSession])
  const getConversationSnapshot = useCallback(() => {
    return activeSession?.conversation.getSnapshot() ?? EMPTY_CONVERSATION_SNAPSHOT
  }, [activeSession])

  const conversationSnapshot = useSyncExternalStore(subscribeConversation, getConversationSnapshot)

  return {
    connectionState,
    activeSession: managerSnapshot.activeSession,
    agents: managerSnapshot.agents,
    models: managerSnapshot.models,
    sessionKeys: managerSnapshot.sessionKeys,
    sessions: managerSnapshot.sessions,
    currentAgent: managerSnapshot.currentAgent,
    currentSessionName: managerSnapshot.currentSessionName,
    currentModel: managerSnapshot.currentModel,
    contextTokens: managerSnapshot.contextTokens,
    contextWindow: managerSnapshot.contextWindow,
    errorMessage: sessionSnapshot.errorMessage,
    compactionPhase: conversationSnapshot.compactionPhase,
    items: conversationSnapshot.items,
    runActive: conversationSnapshot.runActive,
    activity: conversationSnapshot.known ? conversationSnapshot.activity : 'unknown',
    error: conversationSnapshot.error,
    switchTo: (agentId, sessionName) => {
      return managerRef.current?.switchTo(agentId, sessionName) ?? Promise.resolve()
    },
    selectSession: (name) => managerRef.current?.selectSession(name) ?? Promise.resolve(),
    newSession: () => managerRef.current?.newSession() ?? Promise.resolve(),
    send: (text) => {
      const session = managerRef.current?.getSnapshot().activeSession
      if (!session) return Promise.resolve()
      return session.controls.send(text)
    },
    stop: () => {
      managerRef.current?.getSnapshot().activeSession?.controls.stop().catch(() => {})
    },
    resend: (itemId) => {
      const session = managerRef.current?.getSnapshot().activeSession
      if (!session) return Promise.resolve()
      return session.controls.resend(itemId)
    },
    patchModel: (model) => {
      return managerRef.current?.patchModel(model) ?? Promise.resolve()
    },
    inject: (text) => {
      const session = managerRef.current?.getSnapshot().activeSession
      if (!session) return Promise.resolve()
      return session.inject(text)
    },
    reconnect: reconnectGateway,
  }
}
