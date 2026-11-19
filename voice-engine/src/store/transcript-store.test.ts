import { describe, it, expect, beforeEach } from 'vitest'
import {
  useTranscriptStore, setPartial, settle, settleVisible, drop, editTranscript, takeTranscript,
} from './transcript-store'

// Each utterance has its own pending entry, in the order it was heard, and
// words move into `settled` only once every entry before theirs has — so
// they land in spoken order whatever order transcriptions return in.

function state() {
  const { settled, pending } = useTranscriptStore.getState()
  return { settled, pending: pending.map((p) => p.id) }
}

beforeEach(() => {
  useTranscriptStore.setState({ settled: '', pending: [] })
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
