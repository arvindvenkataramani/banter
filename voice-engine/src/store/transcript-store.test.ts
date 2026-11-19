import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  useTranscriptStore, setPartial, settle, settleVisible, drop, editTranscript, takeTranscript,
  markWordsSent, pendingDisplay, pendingText,
} from './transcript-store'

// Each utterance has its own pending entry, in the order it was heard, and
// words move into `settled` only once every entry before theirs has — so
// they land in spoken order whatever order transcriptions return in.

function state() {
  const { settled, pending } = useTranscriptStore.getState()
  return { settled, pending: pending.map((p) => p.id) }
}

beforeEach(() => {
  useTranscriptStore.setState({ settled: '', pending: [], sent: {} })
})

describe('transcript store — spoken order', () => {
  it('keeps entries in the order they were first seen, updating one in place', () => {
    setPartial('a', 'one', false)
    setPartial('b', 'two', false)
    setPartial('a', 'one more', true)

    expect(useTranscriptStore.getState().pending).toEqual([
      { id: 'a', text: 'one more', paused: true, final: null },
      { id: 'b', text: 'two', paused: false, final: null },
    ])
  })

  it('a later entry settled first waits behind an earlier one with no final', () => {
    setPartial('a', 'first', false)
    setPartial('b', 'second', false)

    settle('b', 'second')
    expect(state()).toEqual({ settled: '', pending: ['a', 'b'] })

    settle('a', 'first')
    expect(state()).toEqual({ settled: 'first second', pending: [] })
  })

  it('dropping the blocking entry releases what was waiting behind it', () => {
    setPartial('a', '', false)
    setPartial('b', 'second', false)
    settle('b', 'second')

    drop('a')

    expect(state()).toEqual({ settled: 'second', pending: [] })
  })

  it('an entry settled empty moves out without adding a space', () => {
    setPartial('a', '', false)
    setPartial('b', 'kept', false)
    settle('a', '')
    settle('b', 'kept')

    expect(state()).toEqual({ settled: 'kept', pending: [] })
  })

  it('settling appends to what is already settled', () => {
    editTranscript('typed')
    setPartial('a', 'spoken', false)
    settle('a', 'spoken')

    expect(useTranscriptStore.getState().settled).toBe('typed spoken')
  })

  it('settling an id with no entry appends it and drains', () => {
    settle('a', 'from nowhere')

    expect(state()).toEqual({ settled: 'from nowhere', pending: [] })
  })
})

describe('transcript store — settleVisible', () => {
  it('settles the text on screen for the entry', () => {
    setPartial('a', 'what they saw', true)

    settleVisible('a')

    expect(state()).toEqual({ settled: 'what they saw', pending: [] })
  })

  it('keeps a final already recorded rather than the partial', () => {
    setPartial('z', '', false)
    setPartial('a', 'partial', false)
    settle('a', 'final')

    settleVisible('a')
    drop('z')

    expect(state()).toEqual({ settled: 'final', pending: [] })
  })
})

describe('transcript store — the composer', () => {
  it('takeTranscript returns and empties only the settled text', () => {
    setPartial('a', 'first', false)
    settle('a', 'first')
    setPartial('b', 'still speaking', false)

    expect(takeTranscript()).toBe('first')
    expect(state()).toEqual({ settled: '', pending: ['b'] })
  })

  it('editTranscript replaces settled and leaves pending alone', () => {
    setPartial('a', 'first', false)
    settle('a', 'first')
    setPartial('b', 'hearing', false)

    editTranscript('rewritten')

    expect(state()).toEqual({ settled: 'rewritten', pending: ['b'] })
  })
})

describe('transcript store — words already sent by the host', () => {
  const shown = () => pendingText(useTranscriptStore.getState())

  it('strips the marked leading words from the final at settle', () => {
    setPartial('a', 'send this now and', true)
    markWordsSent('a', 3)

    settle('a', 'Send this now, and more words.')

    expect(state()).toEqual({ settled: 'and more words.', pending: [] })
  })

  it('shows only the words after the mark while the utterance is pending', () => {
    setPartial('a', 'one two three', true)
    markWordsSent('a', 3)
    expect(shown()).toBe('')

    setPartial('a', 'one two three four five', true)
    expect(shown()).toBe('four five')
  })

  it('counts the words the reveal has shown, not the words received', () => {
    vi.useFakeTimers()
    try {
      setPartial('a', 'alpha beta gamma delta epsilon', false)
      vi.advanceTimersByTime(5000)
      const [entry] = pendingDisplay(useTranscriptStore.getState())
      // The unsettled last word is never shown.
      expect(entry.text).toBe('alpha beta gamma delta')

      markWordsSent('a', entry.text.split(' ').length)
      settle('a', 'alpha beta gamma delta epsilon zeta')
      expect(useTranscriptStore.getState().settled).toBe('epsilon zeta')
    } finally {
      vi.useRealTimers()
    }
  })

  it('an utterance whose words were all sent settles nothing', () => {
    setPartial('a', 'all of it', true)
    markWordsSent('a', 3)

    settle('a', 'all of it')

    expect(state()).toEqual({ settled: '', pending: [] })
  })

  it('leaves a settled utterance behind it intact and in order', () => {
    setPartial('a', 'sent words', true)
    setPartial('b', 'fresh words', false)
    markWordsSent('a', 2)

    settle('b', 'fresh words')
    settle('a', 'sent words')

    expect(state()).toEqual({ settled: 'fresh words', pending: [] })
  })

  it('keeps the mark for an entry a late final creates anew', () => {
    setPartial('a', 'sent words', true)
    markWordsSent('a', 2)
    drop('a')

    settle('a', 'sent words after')

    expect(state()).toEqual({ settled: 'after', pending: [] })
  })

  it('a mark made before the entry exists applies to its final', () => {
    markWordsSent('a', 1)
    settle('a', 'sent kept')
    expect(useTranscriptStore.getState().settled).toBe('kept')
  })

  it('a count of zero clears the mark', () => {
    setPartial('a', 'one two', true)
    markWordsSent('a', 2)
    markWordsSent('a', 0)

    expect(shown()).toBe('one two')
  })

  it('drops marks of utterances no longer pending when another is marked', () => {
    setPartial('a', 'one', true)
    markWordsSent('a', 1)
    settle('a', 'one')
    setPartial('b', 'two', true)
    markWordsSent('b', 1)

    expect(useTranscriptStore.getState().sent).toEqual({ b: 1 })
  })

  it('without a mark the pending text is unchanged', () => {
    setPartial('a', 'one two', true)
    expect(shown()).toBe('one two')
  })
})
