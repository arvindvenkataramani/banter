import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { editTranscript, settle, takeTranscript, useTranscriptStore } from '@platform/voice-engine/store/transcript-store'
import type { DshInputState } from './dsh-types'
import { createDraftMirror } from './draft-mirror'

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

const transcript = () => useTranscriptStore.getState().settled
const calledWith = (fn: { mock: { calls: unknown[][] } }, arg: unknown) => fn.mock.calls.some(call => call[0] === arg)

beforeEach(() => {
  useTranscriptStore.setState({ settled: '', pending: [] })
})
afterEach(() => {
  useTranscriptStore.setState({ settled: '', pending: [] })
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
