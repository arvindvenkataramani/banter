// Which session dsh shows, and whether a conversation (with its composer) is
// on screen. A session switch changes the id and keeps the conversation; a
// panel such as the Plugins page ends the conversation view.

import type { DshClientContext, DshObservable } from './dsh-types.ts'

export interface ShownSession {
  /** The session the main view retains, or null when none is open. */
  readonly sessionId: string | null
  /** True while a central panel replaces the conversation. */
  readonly panelOpen: boolean
}

/** dsh's main view retains the shown session under this source (packages/api/session-controller/src/client/contract/sessions.ts SessionReferenceSource). */
const MAIN_VIEW = 'mainView'

export function createShownSession(ctx: DshClientContext): DshObservable<ShownSession> & { dispose(): void } {
  const listeners = new Set<() => void>()
  let snapshot: ShownSession = read()

  function read(): ShownSession {
    const rows = Object.entries(ctx.sessions.list.getSnapshot().byId)
    const shown = rows.find(([, row]) => (row.retainedBy[MAIN_VIEW] ?? 0) > 0)
    return { sessionId: shown?.[0] ?? null, panelOpen: ctx.layout.panelInfo.getSnapshot().activePanelId !== null }
  }

  const refresh = (): void => {
    const next = read()
    if (next.sessionId === snapshot.sessionId && next.panelOpen === snapshot.panelOpen) return
    snapshot = next
    for (const listener of listeners) listener()
  }
  const stops = [ctx.sessions.list.subscribe(refresh), ctx.layout.panelInfo.subscribe(refresh)]

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose() {
      for (const stop of stops) stop()
      listeners.clear()
    },
  }
}
