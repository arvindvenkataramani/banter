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
    /** The transcript as the box shows it now: settled text plus the pending words. */
    transcriptView(): string
    /** What each pending utterance shows, and how many of its leading words are already marked sent. */
    pendingDisplay(): { id: string; text: string; sent: number }[]
    /** Marks the first `count` words of an utterance as sent by dsh; zero clears the mark. */
    markWordsSent(id: string, count: number): void
  }
  /** Called when the mic is auto-muted for typing, or released from it. */
  onTypingChange?(typing: boolean): void
  /** Called when the person sends through dsh's own Send. */
  onSend?(): void
}

/** What a mirror carries across the box leaving and coming back while voice stays attached. */
export interface MirrorSnapshot {
  typing: boolean
  lastWrite: string | null
}

export interface DraftMirror {
  /** Voice attached to the session whose box this is. */
  onAttach(): void
  /** The box came back while voice stayed attached: the transcript is current, the box is not. */
  onResume(snapshot: MirrorSnapshot): void
  /** The state to resume from when this box goes away. */
  snapshot(): MirrorSnapshot
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
  /** The engine is sending the transcript: the box shows what the transcript holds now, which is only words said since. */
  clear(): void
  /** The engine's send failed: put the words back ahead of anything said since. */
  restore(text: string): void
}

/** Two pieces of text as one, single-spaced where both are present. */
export function joinText(first: string, second: string): string {
  if (first === '') return second
  if (second === '') return first
  return `${first} ${second}`
}

/** Puts words from a failed send back at the front of the transcript, ahead of anything settled since. */
export function restoreToTranscript(engine: Pick<DraftMirrorDeps['engine'], 'editTranscript' | 'takeTranscript'>, text: string): void {
  engine.editTranscript(joinText(text, engine.takeTranscript()))
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
  /** From a dsh send until dsh empties the box or refuses; dsh owns the box meanwhile. */
  let sending = false
  /** The transcript view as last reported, shown in the box unless the person is typing. */
  let lastView = ''

  const setTyping = (value: boolean): void => {
    if (typing === value) return
    typing = value
    deps.onTypingChange?.(value)
  }

  /**
   * Marks each pending utterance's words the box shows as sent, counted from
   * its first word, so the engine neither shows them again nor sends them when
   * the utterance settles. Used when the words leave the pending list for the
   * box's own text: a dsh send, or the person typing over them.
   */
  const markShownWords = (): void => {
    for (const { id, text, sent } of engine.pendingDisplay()) {
      const count = text.split(/\s+/).filter(Boolean).length
      if (count > sent) engine.markWordsSent(id, count)
    }
  }

  const enterTyping = (): void => {
    // The box showed the pending words; the typed text takes them in, so they are not pending too.
    if (lastWrite !== null && lastWrite !== '') markShownWords()
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

  /** Shows the transcript view in the box when the plugin may write there. */
  const showView = (): void => {
    if (typing || sending) return
    const state = deps.readInput()
    if (lastView === state.draft) return
    // Never write over text the plugin did not put there.
    if (state.draft !== '' && !isOwn(state)) return
    write(lastView)
  }

  return {
    snapshot: () => ({ typing, lastWrite }),

    onResume(snapshot) {
      seenRev = deps.readInput().draftRev
      ownRevs.clear()
      awaiting = []
      sendClearing = false
      sending = false
      lastWrite = snapshot.lastWrite
      // Typing carries over; otherwise the next transcript report brings the box up to date.
      if (snapshot.typing) setTyping(true)
    },

    onAttach() {
      const state = deps.readInput()
      seenRev = state.draftRev
      ownRevs.clear()
      awaiting = []
      sendClearing = false
      sending = false
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
      if (sending && state.draft === '') {
        // dsh accepted the send and emptied the box; words said meanwhile show now.
        sending = false
        sendClearing = false
        ownRevs.add(state.draftRev)
        showView()
        return
      }
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
      showView()
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
      const state = deps.readInput()
      const own = !typing && state.draft !== '' && isOwn(state)
      engine.takeTranscript()
      if (own) markShownWords()
      engine.reportComposerSend()
      engine.setMicAutoMuted(false)
      engine.reportComposerFocus(false)
      lastWrite = ''
      sendClearing = true
      sending = true
      setTyping(false)
      deps.onSend?.()
    },

    onDshSendRefused() {
      // The refused text stays in the box; it is the person's draft again, under the typing mute.
      // The marks made at the send stay: the box's pending words are part of the draft now.
      sending = false
      lastWrite = null
      sendClearing = false
      enterTyping()
      let draft = deps.readInput().draft
      // Words that settled during the send go after the draft, in the box and in the transcript.
      const since = engine.takeTranscript()
      if (since !== '') {
        draft = joinText(draft, since)
        deps.inputActions.setDraft(draft)
      }
      engine.editTranscript(draft)
    },

    clear() {
      // The engine has taken the transcript; the view reported to the mirror is older than that.
      lastView = engine.transcriptView()
      showView()
    },

    restore(text) {
      if (typing) {
        // The box is the person's: the words go ahead of what they have typed.
        const joined = joinText(text, deps.readInput().draft)
        deps.inputActions.setDraft(joined)
        engine.editTranscript(joined)
        return
      }
      restoreToTranscript(engine, text)
    },
  }
}
