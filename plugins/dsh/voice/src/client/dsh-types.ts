// Structural types for the dsh fields the plugin reads. Each cites its dsh
// source (tag dsh-v0.2.2-rc.5); no dsh package is imported.

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

/** packages/client/ui-conversation/src/client/contract/input.ts:264-288 */
export interface DshInputActions {
  /** Replaces the whole draft with plain text; inline reference chips are removed. */
  setDraft(text: string): void
  submit(): void
}

/** packages/client/ui-conversation/src/client/contract/input.ts:306-326 */
export interface DshInputState {
  readonly draft: string
  /** Monotonic editor revision; every text change, the plugin's own included, bumps it. */
  readonly draftRev: number
  readonly phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting' | 'sending'
}

/** The session face: packages/api/session-controller/src/client/contract/session.ts:98-124. */
export interface DshSessionFace {
  readonly sessionId: string
  prompt(content: readonly { readonly type: 'text'; readonly text: string }[], mode: 'queue' | 'steer'): Promise<DshRemoteResult<{ accepted: true }>>
  cancel(): Promise<DshRemoteResult<{ accepted: true }>>
}

/** The binding's event feed (packages/api/session-controller/src/client/contract/events.ts:68-98). */
export interface DshEventSource {
  getSnapshot(): DshEventWindow
  subscribe(listener: () => void): () => void
}

/** The session face and the binding's event window as one object. */
export interface DshSessionLike extends DshSessionFace {
  readonly eventSource: DshEventSource
}

/** packages/api/session-controller/src/client/sessions/service.ts:105-112 */
export interface DshSessionBinding {
  readonly sessionId: string
  readonly session: DshSessionFace
  readonly eventSource: DshEventSource
}

/** The props dsh gives a session-scoped slot component (packages/client/ui-conversation/src/client/contract/slots.ts:395-402). */
export interface DshSessionSlotProps {
  readonly sessionId: string
  useInput<T>(selector: (state: DshInputState) => T): T
  readonly inputActions: DshInputActions
}

/** One shortcut command (packages/client/shortcuts/src/client/types.ts:20-31, binding.ts:5-24). */
export interface DshShortcutCommand {
  readonly id: string
  readonly label: () => string
  readonly aliases: readonly string[]
  readonly defaults: Readonly<Partial<Record<string, { readonly code: string; readonly modifiers: readonly ('primary' | 'control' | 'alt' | 'shift' | 'meta')[] }>>>
  readonly regions: readonly ('page' | 'editable' | 'terminal')[]
  readonly modals: readonly string[]
  resolve(context: unknown): { readonly status: 'handled'; run(): void } | { readonly status: 'blocked'; readonly reason: string } | { readonly status: 'pass' }
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
  /** packages/client/shortcuts/src/client/types.ts:137 */
  shortcuts: { register(command: DshShortcutCommand): () => void }
  /** packages/client/ui-settings/src/client/config-form-types.ts:30-95 */
  configForms: { get<T>(entryId: string): DshConfigForm<T> }
  effect(callback: () => (() => unknown) | void, label?: string): unknown
}

/**
 * One edit of a settings write: `set` writes the value at the path, `unset` removes it
 * (packages/settings/settings/src/types.ts:52, `SettingsPathOpView`).
 */
export type DshSettingsOp =
  | { readonly op: 'set'; readonly path: string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: string[] }

/**
 * The accepted values and write queue of one host entry's config (packages/client/ui-settings/src/client/config-form-types.ts:9-95).
 * `mutate` is the atomic write (config-form-types.ts:44-55): every op shares one revision fence
 * and Host validation. With `expectedRevision` the write is fenced by that revision, so one read earlier than the
 * latest refuses it rather than overwriting. It resolves false when the Host refuses and rejects on a transport failure.
 */
export interface DshConfigForm<T> extends DshObservable<{ status: 'loading' | 'ready' | 'unavailable'; value: T | undefined; revision: number | undefined; writable: boolean }> {
  mutate(ops: readonly DshSettingsOp[], expectedRevision?: number): Promise<boolean>
}
