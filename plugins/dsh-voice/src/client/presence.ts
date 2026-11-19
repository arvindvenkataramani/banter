// Voice belongs to the page: it follows the session dsh shows, and ends when
// the person leaves the conversation unless they asked it to stay.

import type { DshObservable } from './dsh-types.ts'
import type { ShownSession } from './shown-session.ts'

export interface PresenceDeps {
  shown: DshObservable<ShownSession>
  /** The "keep voice on outside a conversation" setting, read each time it matters. */
  keepOnOutside(): boolean
  /** Whether voice is running. */
  isLive(): boolean
  /** Points the live voice system at another session. */
  attach(sessionId: string): void
  voiceOff(): void
}

/** Starts following the shown session; the returned function stops. */
export function followShownSession(deps: PresenceDeps): () => void {
  let previous = deps.shown.getSnapshot()
  return deps.shown.subscribe(() => {
    const next = deps.shown.getSnapshot()
    const last = previous
    previous = next
    if (next.panelOpen) {
      // A view with no composer replaces the conversation.
      if (!last.panelOpen && deps.isLive() && !deps.keepOnOutside()) deps.voiceOff()
      return
    }
    // A switch changes the session with a composer shown again in the same navigation.
    if (next.sessionId !== null && next.sessionId !== last.sessionId && deps.isLive()) deps.attach(next.sessionId)
  })
}
