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
  /** A prompt failed: hands the person's words back and says why. */
  sendFailed?(text: string, message: string): void
}

function accepted(result: DshRemoteResult<unknown>, what: string): void {
  if (result.ok) return
  const reason = result.error instanceof Error ? result.error.message : typeof result.error === 'string' ? result.error : 'refused'
  throw new Error(`${what} failed: ${reason}`)
}

export function createVoiceSession(session: DshSessionLike, deps: VoiceSessionDeps): VoiceSession & { dispose(): void } {
  // dsh numbers turns per session, so the session's id keeps run ids apart across sessions.
  let state = { ...initialReaderState, idPrefix: `${session.sessionId}:` }
  let snapshot: ReaderSnapshot = state.snapshot
  /** The run the engine asked to abort; a run that ends aborted any other way was stopped in dsh. */
  let engineAbortedRun: string | null = null
  const eventListeners = new Set<(e: RunEvent) => void>()
  const snapshotListeners = new Set<() => void>()

  const pump = (): void => {
    const read = readWindow(state, session.eventSource.getSnapshot())
    state = read.state
    for (const event of read.events) {
      for (const listener of [...eventListeners]) listener(event)
      // Stop in dsh silences the voice as Banter's Stop does; the halt follows the event so the chunker's last flush is cut too.
      if (event.kind === 'chat' && event.state === 'aborted' && event.runId !== engineAbortedRun) deps.haltAudio()
    }
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
        try {
          accepted(await session.prompt([{ type: 'text', text: finalText }], 'queue'), 'Send')
        } catch (err) {
          deps.sendFailed?.(text, err instanceof Error ? err.message : 'Send failed')
          throw err
        }
        deps.clearDraft()
      },
      async abort() {
        engineAbortedRun = snapshot.runActive ? snapshot.runId : null
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
