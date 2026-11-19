// The engine's transcript shown in dsh's text box, and the person's own edits
// of that box read back into the transcript. One mirror serves one attach of
// voice to one session's box.

import type { DshInputActions, DshInputState } from './dsh-types.ts'

export interface DraftMirrorDeps {
  inputActions: DshInputActions
  /** The box's latest published state. */
  readInput(): DshInputState
  engine: {
    setMicAutoMuted(active: boolean): void
    reportComposerFocus(focused: boolean): void
    reportComposerSend(): void
    editTranscript(text: string): void
    takeTranscript(): string
  }
  /** Called when the mic is auto-muted for typing, or released from it. */
  onTypingChange?(typing: boolean): void
}

export interface DraftMirror {
  /** Voice attached to the session whose box this is. */
  onAttach(): void
  /** dsh published a box state. */
  onDraftChange(state: DshInputState): void
  /** The transcript view (settled text plus pending utterances) changed. */
  onTranscriptChange(view: string): void
  /** The person unmuted the mic while it was muted for typing. */
  onUnmute(): void
  /** The person sent the box's text through dsh's own Send. */
  onDshSend(): void
  /** dsh refused the send: the box still holds the person's text, now theirs again. */
  onDshSendRefused(): void
  /** The engine sent the transcript: empty the box. */
  clear(): void
  /** The engine's send failed: put the words back ahead of anything said since. */
  restore(text: string): void
}

export function createDraftMirror(deps: DraftMirrorDeps): DraftMirror {
  const { engine } = deps
  let typing = false
  /** The text the plugin last put in the box. */
  let lastWrite: string | null = ''
  /** Revisions produced by the plugin's own writes. */
  const ownRevs = new Set<number>()
  /** Own writes whose revision dsh has not published yet. */
  let awaiting: string[] = []
  let seenRev = 0
  /** After a dsh send, the revision that empties the box is dsh's own clearing. */
  let sendClearing = false
  /** The transcript view as last reported, shown in the box unless the person is typing. */
  let lastView = ''

  const setTyping = (value: boolean): void => {
    if (typing === value) return
    typing = value
    deps.onTypingChange?.(value)
  }

  const enterTyping = (): void => {
    engine.setMicAutoMuted(true)
    engine.reportComposerFocus(true)
    awaiting = []
    setTyping(true)
  }

  /** Whether the box holds text the plugin put there. */
  const isOwn = (state: DshInputState): boolean =>
    ownRevs.has(state.draftRev) || state.draft === lastWrite || awaiting.includes(state.draft)

  const write = (text: string): void => {
    const before = deps.readInput().draftRev
    deps.inputActions.setDraft(text)
    lastWrite = text
    const after = deps.readInput().draftRev
    if (after !== before) ownRevs.add(after)
    else awaiting.push(text)
  }

  return {
    onAttach() {
      const state = deps.readInput()
      seenRev = state.draftRev
      ownRevs.clear()
      awaiting = []
      sendClearing = false
      // The attached session's box is the transcript; text already in it is the person's.
      engine.editTranscript(state.draft)
      if (state.draft !== '') {
        lastWrite = null
        enterTyping()
        return
      }
      lastWrite = ''
      engine.setMicAutoMuted(false)
      engine.reportComposerFocus(false)
      setTyping(false)
    },

    onDraftChange(state) {
      if (state.draftRev === seenRev) return
      seenRev = state.draftRev
      if (!typing && isOwn(state)) {
        ownRevs.add(state.draftRev)
        const matched = awaiting.indexOf(state.draft)
        if (matched >= 0) awaiting = awaiting.slice(matched + 1)
        return
      }
      if (sendClearing && state.draft === '') {
        sendClearing = false
        return
      }
      sendClearing = false
      if (!typing) enterTyping()
      engine.editTranscript(state.draft)
    },

    onTranscriptChange(view) {
      lastView = view
      if (typing) return
      const state = deps.readInput()
      if (view === state.draft) return
      // Never write over text the plugin did not put there.
      if (state.draft !== '' && !isOwn(state)) return
      write(view)
    },

    onUnmute() {
      const text = deps.readInput().draft
      engine.editTranscript(text)
      engine.setMicAutoMuted(false)
      engine.reportComposerFocus(false)
      lastWrite = text
      sendClearing = false
      setTyping(false)
    },

    onDshSend() {
      // The words are sent once, by dsh: empty the transcript before the floor hears of the send.
      engine.takeTranscript()
      engine.reportComposerSend()
      engine.setMicAutoMuted(false)
      engine.reportComposerFocus(false)
      lastWrite = ''
      sendClearing = true
      setTyping(false)
    },

    onDshSendRefused() {
      // The refused text stays in the box; it is the person's draft again, under the typing mute.
      lastWrite = null
      sendClearing = false
      enterTyping()
      engine.editTranscript(deps.readInput().draft)
    },

    clear() {
      // Only the plugin's own text goes, and not words said since the send.
      const state = deps.readInput()
      if (typing || lastView !== '' || state.draft === '' || !isOwn(state) || awaiting[awaiting.length - 1] === '') return
      write('')
    },

    restore(text) {
      // While the person types, the box is theirs and the words cannot be shown in it.
      if (typing) return
      const since = engine.takeTranscript()
      engine.editTranscript(since === '' ? text : `${text} ${since}`)
    },
  }
}
