import type { ChatEventPayload } from './gateway-types'
import type { Message } from './chat-types'
import type { GatewayConnection } from './gateway-connection'
import { extractMessageText, extractSenderAgentId, historyId } from './gateway-utils'
import { Conversation } from './conversation-store'
import { normalizeAgentEvent, normalizeSessionToolEvent, chatToRunEvent } from './run-state'
import { SessionControls } from './controls'

// Kept as a shared type — compaction display now lives entirely on
// Conversation (ConversationSnapshot.compactionPhase); Session no longer
// tracks it, but compaction-indicator.tsx and the session-manager handle
// still name this type.
export type CompactionPhase = 'active' | 'retrying' | 'complete' | null

interface HistoryResult {
  messages?: unknown[]
  hasMore?: boolean
  nextOffset?: number
}

// `offset` keeps the positional fallback unique across pages; rows that carry
// __openclaw metadata ignore it entirely.
function toMessages(rows: unknown[], offset = 0): Message[] {
  return rows
    .filter((m: unknown) => {
      const role = (m as Record<string, unknown>).role
      return role === 'user' || role === 'assistant'
    })
    .map((m: unknown, i: number) => {
      const msg = m as Record<string, unknown>
      return {
        id: historyId(msg, offset + i),
        role: msg.role as 'user' | 'assistant',
        text: extractMessageText(m),
        senderAgentId: extractSenderAgentId(m),
      }
    })
}

export interface SessionSnapshot {
  messages: Message[]
  isStreaming: boolean
  isTyping: boolean
  errorMessage: string | null
}

export class Session {
  readonly sessionKey: string
  readonly conversation: Conversation = new Conversation()
  readonly controls: SessionControls = new SessionControls(this)
  private connection: GatewayConnection

  private _messages: Message[] = []
  private _isStreaming = false
  private _isTyping = false
  private _errorMessage: string | null = null
  private _hasMore = false
  private _nextOffset: number | null = null
  private _loadingOlder = false
  private msgCounter = 0

  private listeners = new Set<() => void>()
  private snapshot: SessionSnapshot = { messages: [], isStreaming: false, isTyping: false, errorMessage: null }

  onRunComplete: (() => void) | null = null
  private _runDoneResolve: (() => void) | null = null

  constructor(sessionKey: string, connection: GatewayConnection) {
    this.sessionKey = sessionKey
    this.connection = connection
  }

  // --- Public state accessors ---

  getSnapshot(): SessionSnapshot {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // --- Actions (return promises; caller handles toast on rejection) ---

  send(text: string): Promise<void> {
    const id = `msg-${++this.msgCounter}`
    this._messages = [...this._messages, { id, role: 'user', text }]
    this._isTyping = true
    this._errorMessage = null
    this.notify()
    return (this.connection.call('chat.send', {
      sessionKey: this.sessionKey,
      message: text,
      deliver: false,
      idempotencyKey: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }).then(() => { this.onRunComplete?.() }) as Promise<void>).catch((err: unknown) => {
      // Roll back the optimistic user message on send failure
      this._messages = this._messages.filter((m) => m.id !== id)
      this._isTyping = false
      this.notify()
      throw err
    })
  }

  abort(): Promise<void> {
    this._isStreaming = false
    this._isTyping = false
    this.notify()
    return this.connection.call('chat.abort', { sessionKey: this.sessionKey }).then(() => {}) as Promise<void>
  }

  inject(text: string): Promise<void> {
    return this.connection.call('chat.inject', {
      sessionKey: this.sessionKey,
      message: text,
    }).then(() => {}) as Promise<void>
  }

  reset(): Promise<void> {
    this._messages = []
    this._isStreaming = false
    this._isTyping = true
    this._errorMessage = null
    this.conversation.reset()
    this.notify()
    // sessions.reset is a synchronous RPC: the gateway only acks once the
    // session has actually been reset. Using chat.send '/new' is racy
    // because the gateway processes chat.send messages concurrently, so a
    // subsequent send() can land before /new finishes.
    return (this.connection.call('sessions.reset', {
      key: this.sessionKey,
      reason: 'new',
    }).then(() => {
      this._isTyping = false
      this.notify()
    }) as Promise<void>).catch((err: unknown) => {
      this._isTyping = false
      this.notify()
      throw err
    })
  }

  loadHistory(): Promise<void> {
    return (this.connection.call('chat.history', { sessionKey: this.sessionKey })
      .then((payload) => {
        const res = payload as HistoryResult
        if (!res.messages?.length) return
        this._messages = toMessages(res.messages)
        this.conversation.seed(res.messages)
        this._hasMore = res.hasMore === true
        this._nextOffset = typeof res.nextOffset === 'number' ? res.nextOffset : null
        this.notify()
      }) as Promise<void>)
      .catch((err: unknown) => {
        // A failed history load is indistinguishable from an empty conversation
        // unless we say so — silence here hid blank user messages for a month.
        console.error('[session] chat.history failed:', err)
        this._errorMessage = 'Could not load conversation history.'
        this.notify()
        throw err
      })
  }

  get hasMoreHistory(): boolean {
    return this._hasMore
  }

  // Page backward through older history. The gateway caps a single response
  // (200 messages), so earlier turns are only reachable by paging.
  loadOlderHistory(): Promise<void> {
    if (!this._hasMore || this._nextOffset === null || this._loadingOlder) return Promise.resolve()
    this._loadingOlder = true
    const requestedOffset = this._nextOffset
    return (this.connection.call('chat.history', {
      sessionKey: this.sessionKey,
      offset: requestedOffset,
    }).then((payload) => {
      const res = payload as HistoryResult
      const older = toMessages(res.messages ?? [], requestedOffset)
      // Anchored on __openclaw.id, so a row already held is never duplicated.
      const known = new Set(this._messages.map((m) => m.id))
      this._messages = [...older.filter((m) => !known.has(m.id)), ...this._messages]
      this.conversation.prependOlder(res.messages ?? [], requestedOffset)
      this._hasMore = res.hasMore === true
      this._nextOffset = typeof res.nextOffset === 'number' ? res.nextOffset : null
      this._loadingOlder = false
      this.notify()
    }) as Promise<void>)
      .catch((err: unknown) => {
        this._loadingOlder = false
        console.error('[session] paging older history failed:', err)
        this.notify()
        throw err
      })
  }

  // webchat-ui clients can't call sessions.patch — send /model command instead.
  // Resolves once the gateway's run for the /model command has finished, so the
  // caller can verify the switch took effect.
  sendModelCommand(model: string): Promise<void> {
    const runDone = new Promise<void>((resolve) => { this._runDoneResolve = resolve })
    return this.connection.call('chat.send', {
      sessionKey: this.sessionKey,
      message: `/model ${model}`,
      deliver: false,
      idempotencyKey: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }).then(() => runDone)
  }

  // Fed by GatewayConnection.addAgentEventListener — every `agent` event,
  // regardless of stream. Normalizes and hands off to the Conversation layer;
  // does not touch _messages or any existing renderer path.
  applyAgentEvent(payload: unknown): void {
    const event = normalizeAgentEvent(payload, Date.now())
    if (event) this.conversation.ingest(event)
  }

  // Fed by GatewayConnection.addSessionToolListener — the late-attach mirror
  // of the tool stream (no captured example exists yet; the normalizer is
  // tolerant of a wrong shape guess).
  applySessionToolEvent(payload: unknown): void {
    const event = normalizeSessionToolEvent(payload, Date.now())
    if (event) this.conversation.ingest(event)
  }

  // Called by GatewayConnection when a filtered chat event arrives
  applyEvent(event: ChatEventPayload): void {
    // Ground-truth Conversation layer, fed alongside the existing _messages
    // path during migration — voice and error plumbing still read _messages
    // until their respective steps.
    this.conversation.ingest(chatToRunEvent(event, Date.now()))

    if (event.state === 'delta') {
      this._isTyping = false
      this._isStreaming = true
      const existing = this._messages.find((m) => m.id === event.runId)
      if (existing) {
        this._messages = this._messages.map((m) =>
          m.id === event.runId ? { ...m, text: event.message } : m
        )
      } else {
        this._messages = [
          ...this._messages,
          { id: event.runId, role: 'assistant' as const, text: event.message, isStreaming: true },
        ]
      }
    } else if (event.state === 'final') {
      const existing = this._messages.find((m) => m.id === event.runId)
      if (existing) {
        this._isStreaming = false
        this._isTyping = false
        this._messages = this._messages.map((m) =>
          m.id === event.runId
            ? { ...m, text: event.message || m.text, isStreaming: false }
            : m
        )
      } else if (!this._isStreaming && !this._isTyping) {
        // Another device's run, and we're idle — reload history to pick it up
        this.loadHistory().catch(() => {})
      }
      // If we're mid-stream on a different run, ignore this foreign final entirely
    } else if (event.state === 'aborted') {
      const abortedExisting = this._messages.find((m) => m.id === event.runId)
      if (abortedExisting) {
        this._isStreaming = false
        this._isTyping = false
        this._messages = this._messages.map((m) =>
          m.id === event.runId ? { ...m, isStreaming: false } : m
        )
      }
    } else if (event.state === 'error') {
      // Only apply error state if it's for our current run (we're typing/streaming)
      if (this._isStreaming || this._isTyping) {
        this._isStreaming = false
        this._isTyping = false
        this._errorMessage = event.errorMessage ?? 'Gateway error'
      }
    }
    this.notify()
    if (event.state === 'final' || event.state === 'aborted' || event.state === 'error') {
      if (this._runDoneResolve) {
        this._runDoneResolve()
        this._runDoneResolve = null
      }
      this.onRunComplete?.()
    }
  }

  // --- Private ---

  private notify() {
    this.snapshot = {
      messages: this._messages,
      isStreaming: this._isStreaming,
      isTyping: this._isTyping,
      errorMessage: this._errorMessage,
    }
    for (const listener of this.listeners) {
      listener()
    }
  }
}
