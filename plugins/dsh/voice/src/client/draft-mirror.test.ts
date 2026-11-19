import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  editTranscript, markWordsSent, pendingDisplay, pendingText, setPartial, settle, takeTranscript, useTranscriptStore,
} from '@platform/voice-engine/store/transcript-store'
import type { DshInputState } from './dsh-types'
import { createDraftMirror, restoreToTranscript } from './draft-mirror'

// The engine's transcript store is real; the mute and floor reports are
// recorded. The box is a small stand-in for dsh's input: one write is one
// revision, and dsh notifies the mirror after every revision.

// INVENTED: spec section 2 names the mirror's inputs ("injected inputActions, draft reader, and the engine calls it uses") and its five handlers but no keys or arguments. The shape below uses the spec's and the engine's own names (inputActions, setMicAutoMuted, reportComposerFocus, reportComposerSend, editTranscript, takeTranscript); `readInput` is the draft reader; onDraftChange takes dsh's input state, onTranscriptChange the transcript view text, and onAttach, onUnmute and onDshSend take nothing. The mirror learns of a dsh send only through onDshSend (the wiring watches the input state's `phase` for 'sending', spec section 6); no test feeds it phase 'sending'. This fixture is the only place the tests name them.
function setup(initialDraft = '') {
  const box: { -readonly [K in keyof DshInputState]: DshInputState[K] } = { draft: initialDraft, draftRev: initialDraft === '' ? 0 : 3, phase: 'plain' }
  const log: string[] = []
  const inputActions = {
    setDraft: vi.fn((text: string) => {
      box.draft = text
      box.draftRev += 1
    }),
    submit: vi.fn(),
  }
  const engine = {
    setMicAutoMuted: vi.fn((_active: boolean) => { log.push('setMicAutoMuted') }),
    reportComposerFocus: vi.fn((_focused: boolean) => { log.push('reportComposerFocus') }),
    reportComposerSend: vi.fn(() => { log.push('reportComposerSend') }),
    editTranscript: vi.fn((text: string) => { log.push('editTranscript'); editTranscript(text) }),
    takeTranscript: vi.fn(() => { log.push('takeTranscript'); return takeTranscript() }),
    settledText: vi.fn(() => useTranscriptStore.getState().settled),
    pendingDisplay: vi.fn(() => pendingDisplay(useTranscriptStore.getState())),
    markWordsSent: vi.fn((id: string, count: number) => { log.push('markWordsSent'); markWordsSent(id, count) }),
    transcriptView: vi.fn(() => viewNow()),
  }
  const mirror = createDraftMirror({ inputActions, readInput: () => ({ ...box }), engine })
  return {
    mirror,
    box,
    log,
    inputActions,
    engine,
    /** The person types into dsh's box. */
    type(text: string) {
      box.draft = text
      box.draftRev += 1
      mirror.onDraftChange({ ...box })
    },
    /** The transcript view changes; dsh then reports the revision a write produced. */
    speak(view: string) {
      mirror.onTranscriptChange(view)
      mirror.onDraftChange({ ...box })
    },
  }
}

/** The transcript as the box shows it: settled text, then the pending words. */
function viewNow(): string {
  const { settled } = useTranscriptStore.getState()
  const pending = pendingText(useTranscriptStore.getState())
  return settled + (settled && pending ? ' ' : '') + pending
}
const transcript = () => useTranscriptStore.getState().settled
const calledWith = (fn: { mock: { calls: unknown[][] } }, arg: unknown) => fn.mock.calls.some(call => call[0] === arg)

beforeEach(() => {
  useTranscriptStore.setState({ settled: '', pending: [], sent: {} })
})
afterEach(() => {
  useTranscriptStore.setState({ settled: '', pending: [], sent: {} })
})

describe('draft mirror', () => {
  it('the plugin\'s own writes to the box never mute the mic', () => {
    const h = setup()
    h.mirror.onAttach()
    h.inputActions.setDraft.mockClear()
    h.speak('hello')
    h.speak('hello world')
    h.speak('hello world again')

    expect(h.inputActions.setDraft.mock.calls.map(c => c[0])).toEqual(['hello', 'hello world', 'hello world again'])
    expect(calledWith(h.engine.setMicAutoMuted, true)).toBe(false)
    expect(calledWith(h.engine.reportComposerFocus, true)).toBe(false)
  })

  it('one revision the plugin did not write mutes the mic, reports composer focus, stops writing, and copies the box into the transcript', () => {
    const h = setup()
    h.mirror.onAttach()
    h.speak('hello')

    h.type('hello, I am typing')
    expect(calledWith(h.engine.setMicAutoMuted, true)).toBe(true)
    expect(calledWith(h.engine.reportComposerFocus, true)).toBe(true)

    const writes = h.inputActions.setDraft.mock.calls.length
    h.mirror.onTranscriptChange('hello, I am typing and speech')
    h.type('hello, I am typing more')
    h.mirror.onTranscriptChange('hello, I am typing more')
    expect(h.inputActions.setDraft.mock.calls.length).toBe(writes)
    expect(transcript()).toBe('hello, I am typing more')

    // INVENTED: the person clearing the box by hand does not end the mute-while-typing; only an unmute or a dsh send does (spec section 6 names those two).
    h.type('')
    h.mirror.onTranscriptChange('speech while muted')
    expect(h.inputActions.setDraft.mock.calls.length).toBe(writes)
    expect(h.engine.reportComposerSend).not.toHaveBeenCalled()
  })

  it('attaching to a session whose box has text starts muted and writes nothing, even as speech arrives', () => {
    const h = setup('half-written message')
    h.mirror.onAttach()
    expect(calledWith(h.engine.setMicAutoMuted, true)).toBe(true)

    h.mirror.onTranscriptChange('spoken words')
    expect(h.inputActions.setDraft).not.toHaveBeenCalled()
    expect(h.box.draft).toBe('half-written message')
  })

  it('a send through dsh empties the transcript before it reports the composer send, ends the mute, and submits nothing itself', () => {
    const h = setup()
    h.mirror.onAttach()
    h.type('send this please')
    h.log.length = 0
    const writes = h.inputActions.setDraft.mock.calls.length

    h.mirror.onDshSend()

    expect(h.log.indexOf('takeTranscript')).toBeGreaterThanOrEqual(0)
    expect(h.log.indexOf('reportComposerSend')).toBeGreaterThan(h.log.indexOf('takeTranscript'))
    expect(h.engine.setMicAutoMuted).toHaveBeenLastCalledWith(false)
    expect(h.engine.reportComposerFocus).toHaveBeenLastCalledWith(false)
    expect(transcript()).toBe('')
    expect(h.inputActions.submit).not.toHaveBeenCalled()
    expect(h.inputActions.setDraft.mock.calls.length).toBe(writes)
  })

  it('the box clearing that follows a dsh send does not mute the mic again, and the next typed revision does', () => {
    const h = setup()
    h.mirror.onAttach()
    h.type('send this please')
    h.mirror.onDshSend()
    const mutes = h.engine.setMicAutoMuted.mock.calls.length
    const focusReports = h.engine.reportComposerFocus.mock.calls.length

    // dsh accepts the send and empties the box itself: a revision the plugin did not write.
    h.box.draft = ''
    h.box.draftRev += 1
    h.mirror.onDraftChange({ ...h.box })
    expect(h.engine.setMicAutoMuted.mock.calls.slice(mutes).some(c => c[0] === true)).toBe(false)
    expect(h.engine.reportComposerFocus.mock.calls.slice(focusReports).some(c => c[0] === true)).toBe(false)

    h.type('a new message')
    expect(h.engine.setMicAutoMuted).toHaveBeenLastCalledWith(true)
    expect(h.engine.reportComposerFocus).toHaveBeenLastCalledWith(true)
  })

  it('unmuting adopts the box text into the transcript, ends the mute, and sends nothing', () => {
    useTranscriptStore.setState({ settled: 'words from another session' })
    const h = setup('my draft')
    h.mirror.onAttach()

    h.mirror.onUnmute()

    expect(transcript()).toBe('my draft')
    expect(h.engine.setMicAutoMuted).toHaveBeenLastCalledWith(false)
    expect(h.engine.reportComposerFocus).toHaveBeenLastCalledWith(false)
    expect(h.engine.reportComposerSend).not.toHaveBeenCalled()
    expect(h.engine.takeTranscript).not.toHaveBeenCalled()
    expect(h.inputActions.submit).not.toHaveBeenCalled()
  })

  it('after an unmute, speech continues from the adopted text, mirroring resumes, and the transcript the engine sends holds all of it', () => {
    // INVENTED: the adopted box text counts as the plugin's own last write, so mirroring resumes over it (spec: "resumes mirroring"; the box otherwise holds text the plugin did not put there).
    const h = setup('my draft')
    h.mirror.onAttach()
    h.mirror.onUnmute()
    const mutes = h.engine.setMicAutoMuted.mock.calls.length

    settle('u1', 'and more')
    const view = transcript()
    expect(view).toBe('my draft and more')
    h.speak(view)

    expect(h.inputActions.setDraft).toHaveBeenLastCalledWith('my draft and more')
    expect(h.engine.setMicAutoMuted.mock.calls.slice(mutes).some(c => c[0] === true)).toBe(false)
    expect(takeTranscript()).toBe('my draft and more')
  })
})

describe('draft mirror — a dsh send while an utterance is still being transcribed', () => {
  /** Speech in progress: the utterance's partial reaches the transcript and the box shows it. */
  function sayPartial(h: ReturnType<typeof setup>, id: string, text: string) {
    setPartial(id, text, true)
    h.speak(viewNow())
  }
  /** The person presses dsh's Send; the marks change the transcript view, which the hook reports. */
  function dshSends(h: ReturnType<typeof setup>) {
    h.mirror.onDshSend()
    h.mirror.onTranscriptChange(viewNow())
  }
  /** dsh accepts a send: it empties the box. */
  function dshEmpties(h: ReturnType<typeof setup>) {
    h.box.draft = ''
    h.box.draftRev += 1
    h.mirror.onDraftChange({ ...h.box })
  }

  it('the engine later sends only the words said after the send, and nothing twice', () => {
    const h = setup()
    h.mirror.onAttach()
    sayPartial(h, 'u1', 'one two three')
    expect(h.box.draft).toBe('one two three')
    const sentByDsh = h.box.draft

    dshSends(h)
    dshEmpties(h)
    expect(h.box.draft).toBe('')

    sayPartial(h, 'u1', 'one two three four five')
    expect(h.box.draft).toBe('four five')

    // The final revises the sent words' wording and punctuation, and adds one more.
    settle('u1', 'One, two three. Four five six')
    h.speak(viewNow())
    const sentByEngine = takeTranscript()
    expect(sentByEngine).toBe('Four five six')
    expect(h.box.draft).toBe('Four five six')
    expect(`${sentByDsh} ${sentByEngine}`.split(' ').length).toBe(6)
  })

  it('an utterance whose words were all in the box sends nothing when it settles', () => {
    const h = setup()
    h.mirror.onAttach()
    sayPartial(h, 'u1', 'all of it')

    dshSends(h)
    dshEmpties(h)
    settle('u1', 'all of it')
    h.speak(viewNow())

    expect(takeTranscript()).toBe('')
    expect(h.box.draft).toBe('')
  })

  it('marks the words before the floor hears of the send, so the engine cannot send them first', () => {
    const h = setup()
    h.mirror.onAttach()
    sayPartial(h, 'u1', 'one two')
    h.log.length = 0

    dshSends(h)

    expect(h.log.indexOf('markWordsSent')).toBeGreaterThanOrEqual(0)
    expect(h.log.indexOf('markWordsSent')).toBeLessThan(h.log.indexOf('reportComposerSend'))
  })

  it('words an utterance showed in an earlier dsh send are not counted into the next', () => {
    const h = setup()
    h.mirror.onAttach()
    sayPartial(h, 'u1', 'one two')
    dshSends(h)
    dshEmpties(h)
    sayPartial(h, 'u1', 'one two three four')
    expect(h.box.draft).toBe('three four')

    dshSends(h)
    dshEmpties(h)
    settle('u1', 'one two three four five')

    expect(takeTranscript()).toBe('five')
  })

  it('text the person typed is sent whole, and pending words that never reached the box stay pending', () => {
    const h = setup()
    h.mirror.onAttach()
    h.type('typed text')
    setPartial('u1', 'spoken words', true)

    dshSends(h)
    settle('u1', 'spoken words')

    expect(h.engine.markWordsSent).not.toHaveBeenCalled()
    expect(takeTranscript()).toBe('spoken words')
  })

  it('a refused send leaves the words in the draft, so they are not pending again', () => {
    const h = setup()
    h.mirror.onAttach()
    sayPartial(h, 'u1', 'one two three')

    dshSends(h)
    // dsh refuses: the box still holds the text.
    h.mirror.onDshSendRefused()

    expect(pendingText(useTranscriptStore.getState())).toBe('')
    expect(transcript()).toBe('one two three')
    settle('u1', 'one two three')
    expect(transcript()).toBe('one two three')
  })

  it('the box is brought up to date when the engine takes the transcript for a voice send', () => {
    const h = setup()
    h.mirror.onAttach()
    setPartial('u1', 'first thing', true)
    settle('u1', 'first thing')
    h.speak(viewNow())
    expect(h.box.draft).toBe('first thing')
    setPartial('u2', 'and more', true)
    h.speak(viewNow())

    // The turn manager takes the transcript, then the adapter empties the box before prompting.
    expect(takeTranscript()).toBe('first thing')
    h.mirror.clear()

    expect(h.box.draft).toBe('and more')
    setPartial('u2', 'and more', true)
    settle('u2', 'and more')
    h.mirror.clear()
    expect(takeTranscript()).toBe('and more')
    h.mirror.clear()
    expect(h.box.draft).toBe('')
  })
})

describe('draft mirror — words in the box and the transcript that settles later', () => {
  function sayPartial(h: ReturnType<typeof setup>, id: string, text: string, paused = true) {
    setPartial(id, text, paused)
    h.speak(viewNow())
  }
  function dshSends(h: ReturnType<typeof setup>) {
    h.mirror.onDshSend()
    h.mirror.onTranscriptChange(viewNow())
  }
  function dshEmpties(h: ReturnType<typeof setup>) {
    h.box.draft = ''
    h.box.draftRev += 1
    h.mirror.onDraftChange({ ...h.box })
  }

  it('a final with a different word count than the partial, its filler stripped, loses no word after a dsh send', () => {
    const h = setup()
    h.mirror.onAttach()
    sayPartial(h, 'u1', 'um so I think')
    expect(h.box.draft).toBe('um so I think')

    dshSends(h)
    dshEmpties(h)
    // The final drops the filler the partial carried.
    settle('u1', 'so I think we should go')
    h.speak(viewNow())

    expect(takeTranscript()).toBe('we should go')
  })

  it('on the word-reveal path, the words the box showed are the ones marked, and nothing is sent twice', () => {
    vi.useFakeTimers()
    try {
      const h = setup()
      h.mirror.onAttach()
      setPartial('u1', 'alpha beta gamma delta epsilon', false)
      vi.advanceTimersByTime(5000)
      h.speak(viewNow())
      // The reveal never shows the last, unsettled word.
      expect(h.box.draft).toBe('alpha beta gamma delta')

      dshSends(h)
      dshEmpties(h)
      expect(h.engine.markWordsSent).toHaveBeenCalledWith('u1', 4)
      settle('u1', 'alpha beta gamma delta epsilon zeta')
      h.speak(viewNow())

      expect(takeTranscript()).toBe('epsilon zeta')
    } finally {
      vi.useRealTimers()
    }
  })

  it('typing while a shown utterance is still transcribing keeps its words from coming again when it settles', () => {
    const h = setup()
    h.mirror.onAttach()
    sayPartial(h, 'u1', 'one two three')
    expect(h.box.draft).toBe('one two three')

    h.type('one two three and mine')
    settle('u1', 'one two three')
    h.mirror.onTranscriptChange(viewNow())

    expect(transcript()).toBe('one two three and mine')
    expect(takeTranscript()).toBe('one two three and mine')
  })

  it('typing marks nothing when the box held no words of the plugin\'s', () => {
    const h = setup()
    h.mirror.onAttach()
    h.type('typed first')
    setPartial('u1', 'spoken', true)

    expect(h.engine.markWordsSent).not.toHaveBeenCalled()
  })

  it('a refused send keeps the marks and adopts the whole draft, whose text a paused entry may end in a space of', () => {
    const h = setup()
    h.mirror.onAttach()
    sayPartial(h, 'u1', 'one two three ')

    dshSends(h)
    h.mirror.onDshSendRefused()

    expect(transcript()).toBe(h.box.draft)
    expect(pendingText(useTranscriptStore.getState())).toBe('')
    settle('u1', 'one two three')
    expect(transcript()).toBe('one two three ')
    expect(takeTranscript()).toBe('one two three ')
  })

  it('a refused send keeps words that settled while dsh was sending, after the draft', () => {
    const h = setup()
    h.mirror.onAttach()
    sayPartial(h, 'u1', 'first words')
    dshSends(h)
    settle('u1', 'first words')
    settle('u2', 'said after')

    h.mirror.onDshSendRefused()

    expect(h.box.draft).toBe('first words said after')
    expect(transcript()).toBe('first words said after')
  })

  it('a failed voice send while the person types puts the words ahead of the box text, in the box and the transcript', () => {
    const h = setup()
    h.mirror.onAttach()
    h.type('typed now')

    h.mirror.restore('the lost words')

    expect(h.box.draft).toBe('the lost words typed now')
    expect(transcript()).toBe('the lost words typed now')
  })
})

describe('draft mirror — words that settle while the person types, and unmuting after', () => {
  it('unmuting then typing before a pending utterance settles loses none of its words', () => {
    const h = setup()
    h.mirror.onAttach()
    setPartial('u1', 'one two three', true)
    h.speak(viewNow())
    h.type('one two three and')
    // Words said while typing reach the transcript, not the box.
    setPartial('u1', 'one two three four', true)
    h.mirror.onTranscriptChange(viewNow())
    expect(h.box.draft).toBe('one two three and')

    h.mirror.onUnmute()
    expect(h.box.draft).toBe('one two three and four')
    h.type(`${h.box.draft}!`)
    settle('u1', 'one two three four')
    h.mirror.onTranscriptChange(viewNow())

    expect(h.box.draft).toBe('one two three and four!')
    expect(transcript()).toBe('one two three and four!')
  })

  it('a word that settles after the person starts typing joins the box and the transcript on the next keystroke, once', () => {
    vi.useFakeTimers()
    try {
      const h = setup()
      h.mirror.onAttach()
      setPartial('u1', 'one two three', false)
      vi.advanceTimersByTime(5000)
      h.speak(viewNow())
      // The reveal never shows the last, unsettled word.
      expect(h.box.draft).toBe('one two')

      h.type('one two!')
      settle('u1', 'one two three')
      h.type('one two!?')

      expect(h.box.draft).toBe('one two!? three')
      expect(transcript()).toBe('one two!? three')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a word that settles while typing shows in the box at once, and the next keystroke does not repeat it', () => {
    const h = setup()
    h.mirror.onAttach()
    setPartial('u1', 'one two', true)
    h.speak(viewNow())
    h.type('one two!')
    settle('u1', 'one two three')
    h.mirror.onTranscriptChange(viewNow())
    expect(h.box.draft).toBe('one two! three')

    h.type('one two! three?')

    expect(h.box.draft).toBe('one two! three?')
    expect(transcript()).toBe('one two! three?')
  })

  it('words put back by a failed voice send while the box was away survive the person typing when it returns', () => {
    const h = setup()
    h.mirror.onAttach()
    h.type('typed')
    const away = h.mirror.snapshot()

    restoreToTranscript(h.engine, 'the lost words')
    h.mirror.onResume(away)
    h.type('typed!')

    expect(h.box.draft).toBe('the lost words typed!')
    expect(transcript()).toBe('the lost words typed!')
  })
})
