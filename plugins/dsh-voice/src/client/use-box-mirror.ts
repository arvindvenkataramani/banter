// Connects a mounted dsh text box to the engine's transcript while voice is
// attached to that box's session. The mirror's rules live in draft-mirror.ts;
// this hook only feeds it what React shows.

import { useEffect, useRef, useSyncExternalStore } from 'react'
import { setMicAutoMuted } from '@platform/voice-engine/human/mute-store'
import { usePendingView } from '@platform/voice-engine/human/use-revealed-transcript'
import { reportComposerFocus, reportComposerSend } from '@platform/voice-engine/store/turn-manager-store'
import { editTranscript, takeTranscript, useTranscriptStore } from '@platform/voice-engine/store/transcript-store'
import type { DshInputActions, DshInputState } from './dsh-types.ts'
import { createDraftMirror, type DraftMirror } from './draft-mirror.ts'
import type { VoiceRuntime } from './runtime.ts'

export interface BoxMirrorOptions {
  runtime: VoiceRuntime
  sessionId: string
  /** Voice is live and attached to this box's session. */
  active: boolean
  input: DshInputState
  inputActions: DshInputActions
}

export function useBoxMirror({ runtime, sessionId, active, input, inputActions }: BoxMirrorOptions): void {
  const inputRef = useRef(input)
  const mirrorRef = useRef<DraftMirror | null>(null)
  /** The commit that attaches the mirror holds a view older than the transcript the attach sets. */
  const skipView = useRef(false)
  const previousPhase = useRef(input.phase)

  const settled = useSyncExternalStore(
    listener => useTranscriptStore.subscribe(listener),
    () => useTranscriptStore.getState().settled,
  )
  const pending = usePendingView()
  const view = settled + (settled && pending ? ' ' : '') + pending

  // First, so every effect below reads the state this commit rendered.
  useEffect(() => {
    inputRef.current = input
  })

  useEffect(() => {
    if (!active) return undefined
    const mirror = createDraftMirror({
      inputActions,
      readInput: () => inputRef.current,
      engine: { setMicAutoMuted, reportComposerFocus, reportComposerSend, editTranscript, takeTranscript },
      onTypingChange: (typing) => { runtime.ui.set({ ...runtime.ui.get(), typing }) },
    })
    mirrorRef.current = mirror
    const unregister = runtime.registerBox(sessionId, mirror)
    skipView.current = true
    previousPhase.current = inputRef.current.phase
    mirror.onAttach()
    return () => {
      unregister()
      mirrorRef.current = null
    }
  }, [active, sessionId, inputActions, runtime])

  useEffect(() => {
    if (skipView.current) {
      skipView.current = false
      return
    }
    mirrorRef.current?.onTranscriptChange(view)
  }, [view, active, sessionId, inputActions, runtime])

  useEffect(() => {
    const mirror = mirrorRef.current
    if (mirror !== null) {
      mirror.onDraftChange(input)
      // A send through dsh's own Send shows as the input state's phase becoming 'sending'.
      if (previousPhase.current !== 'sending' && input.phase === 'sending') mirror.onDshSend()
    }
    previousPhase.current = input.phase
  }, [input])
}
