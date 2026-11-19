// The engine's view of one dsh session: its conversation read from the
// session's event window, and the controls that prompt and cancel it.

import type { RunEvent } from '@platform/voice-engine/run-event'
import type { VoiceAnnotation, VoiceSession } from '@platform/voice-engine/session'
import type { DshRemoteResult, DshSessionLike } from './dsh-types.ts'
import { initialReaderState, readWindow, type ReaderSnapshot } from './run-reader.ts'

/** The note an interruption prepends to the person's words, as the dashboard's `ANNOTATIONS` writes it (dashboard/src/lib/controls.ts). */
const ANNOTATIONS: Record<VoiceAnnotation, string> = {
  'interrupted-speaking': '[[note: interrupted you while you were speaking]]',
  'interrupted-working': '[[note: interrupted you while you were working]]',
}

export interface VoiceSessionDeps {
  /** Silences agent audio at once. */
  haltAudio(): void
  /** Empties dsh's text box after a send. */
  clearDraft(): void
}

function accepted(result: DshRemoteResult<unknown>, what: string): void {
  if (result.ok) return
  const reason = result.error instanceof Error ? result.error.message : typeof result.error === 'string' ? result.error : 'refused'
  throw new Error(`${what} failed: ${reason}`)
}

export function createVoiceSession(session: DshSessionLike, deps: VoiceSessionDeps): VoiceSession & { dispose(): void } {
  let state = initialReaderState
  let snapshot: ReaderSnapshot = state.snapshot
  const eventListeners = new Set<(e: RunEvent) => void>()
  const snapshotListeners = new Set<() => void>()

  const pump = (): void => {
    const read = readWindow(state, session.eventSource.getSnapshot())
    state = read.state
    for (const event of read.events) for (const listener of [...eventListeners]) listener(event)
    if (read.snapshot !== snapshot) {
      snapshot = read.snapshot
      for (const listener of [...snapshotListeners]) listener()
    }
  }
  pump()
  const stop = session.eventSource.subscribe(pump)

  return {
    conversation: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        snapshotListeners.add(listener)
        return () => { snapshotListeners.delete(listener) }
      },
      onEvent(listener) {
        eventListeners.add(listener)
        return () => { eventListeners.delete(listener) }
      },
    },
    controls: {
      async send(text, opts) {
        const finalText = opts?.annotation ? `${ANNOTATIONS[opts.annotation]} ${text}` : text
        accepted(await session.prompt([{ type: 'text', text: finalText }], 'queue'), 'Send')
        deps.clearDraft()
      },
      async abort() {
        deps.haltAudio()
        accepted(await session.cancel(), 'Cancel')
      },
    },
    dispose() {
      stop()
      eventListeners.clear()
      snapshotListeners.clear()
    },
  }
}
