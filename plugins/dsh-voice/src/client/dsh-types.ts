// Structural types for the dsh fields the plugin reads. Each cites its dsh
// source (tag dsh-v0.2.2-rc.1); no dsh package is imported.

/** packages/typert/protocol/src/types.ts:130 */
export type DshRemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown }

/** packages/core/session/src/types.ts:294-303, 206-227: the durable events a run is read from. */
export type DshTurnEndReason = { readonly kind: 'completed' | 'aborted' | 'blocked' | 'error' | 'max-tokens' | 'interrupted' | 'forked' }

/**
 * One text chunk of a live attempt. `index` is the content-block index, not
 * the chunk's position in the attempt (packages/llm/llm/src/types.ts:496-503).
 */
export type DshStreamChunk =
  | { readonly type: 'text-delta'; readonly index: number; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly index: number; readonly text: string }
  | { readonly type: 'tool-call-delta'; readonly index: number; readonly id: string; readonly name?: string; readonly argumentsDelta: string }
  | { readonly type: 'block-start' | 'block-end' | 'usage' | 'finish' }

/**
 * A window entry: a durable event, or a client-only live chunk. A live chunk
 * carries no chunk ordinal; `seq` is fractional and orders it among durable
 * events (packages/api/session-controller/src/client/contract/events.ts:8-26,
 * sessions/assistant-stream.ts:149-166).
 */
export type DshEntry =
  | { readonly type: 'event'; readonly event: { readonly type: string; readonly seq: number; readonly data?: unknown } }
  | {
    readonly type: 'transient'
    readonly event: {
      readonly type: 'assistant/live-chunk'
      readonly seq: number
      readonly data: { readonly attemptId: string; readonly turn: number; readonly step: number; readonly chunk: DshStreamChunk }
    }
  }

/** packages/api/session-controller/src/client/contract/events.ts:98-115 */
export type DshEventChange =
  | { readonly kind: 'replace' | 'prepend' | 'append'; readonly entries: readonly DshEntry[] }
  | { readonly kind: 'settle-assistant'; readonly attemptId: string; readonly entry?: DshEntry }

export interface DshEventWindow {
  readonly entries: readonly DshEntry[]
  readonly hasMore: boolean
  readonly revision: number
  readonly change: DshEventChange
}

/** packages/client/ui-conversation/src/client/contract/input.ts:258-282 */
export interface DshInputActions {
  /** Replaces the whole draft with plain text; inline reference chips are removed. */
  setDraft(text: string): void
  submit(): void
}

/** packages/client/ui-conversation/src/client/contract/input.ts:295-315 */
export interface DshInputState {
  readonly draft: string
  /** Monotonic editor revision; every text change, the plugin's own included, bumps it. */
  readonly draftRev: number
  readonly phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting' | 'sending'
}

/** packages/api/session-controller/src/client/contract/session.ts:98-124 */
export interface DshSessionLike {
  readonly sessionId: string
  prompt(content: readonly { readonly type: 'text'; readonly text: string }[], mode: 'queue' | 'steer'): Promise<DshRemoteResult<{ accepted: true }>>
  cancel(): Promise<DshRemoteResult<{ accepted: true }>>
}

/** packages/api/session-controller/src/client/sessions/service.ts:105-112 */
export interface DshSessionBinding {
  readonly sessionId: string
  readonly session: DshSessionLike
  readonly eventSource: {
    getSnapshot(): DshEventWindow
    subscribe(listener: () => void): () => void
  }
}

/** The props dsh gives a session-scoped slot component (packages/client/ui-conversation/src/client/contract/slots.ts:385-392). */
export interface DshSessionSlotProps {
  readonly sessionId: string
  useInput<T>(selector: (state: DshInputState) => T): T
  readonly inputActions: DshInputActions
}

/** The observable shape dsh's client stores share (packages/client/store). */
export interface DshObservable<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** The ctx services the client half reads or registers into. */
export interface DshClientContext {
  slots: {
    inject(slot: string, register: () => unknown): unknown
    register(options: Record<string, unknown>, component: unknown): () => void
  }
  sessions: {
    /** packages/api/session-controller/src/client/sessions/service.ts:61-70 and :35-45 */
    list: DshObservable<{ byId: Record<string, { retainedBy: Partial<Record<string, number>> }> }>
    create(opts?: { sessionId?: string }): Promise<string>
    retain(target: string, options: { source: string }): { readonly binding: DshSessionBinding; readonly ready: Promise<DshSessionBinding>; release(): void }
  }
  /** packages/client/ui-layout/src/client/service.ts:30; `activePanelId` is null while a session's conversation is shown. */
  layout: { panelInfo: DshObservable<{ activePanelId: string | null }> }
  /** packages/client/ui-settings/src/client/config-form-types.ts:30-95 */
  configForms: { get<T>(entryId: string): DshConfigForm<T> }
  effect(callback: () => (() => unknown) | void, label?: string): unknown
}

/** The accepted values and write queue of one host entry's config (packages/client/ui-settings/src/client/config-form-types.ts:9-95). */
export interface DshConfigForm<T> extends DshObservable<{ status: 'loading' | 'ready' | 'unavailable'; value: T | undefined; revision: number | undefined; writable: boolean }> {
  set(field: string, value: unknown): Promise<boolean>
}
