import { test, expect } from 'vitest'
import { TextChunker } from './text-chunker'

// recommendFlush() is the tool-pause hint: when a tool call arrives mid-turn,
// generation pauses, and any COMPLETE sentences sitting in the buffer below the
// normal minWords floor should play now instead of waiting for the turn to end.
//
// Contract: flush emits all complete sentences currently buffered as a SINGLE
// chunk (keeping the TTS request whole), leaving only the trailing partial
// fragment. It never cuts mid-phrase. The flush is a one-shot consumption —
// subsequent feeds resume normal threshold behavior.

test('two-chunk: flush emits a complete sub-minWords sentence', () => {
  const chunks: string[] = []
  const c = new TextChunker({ mode: 'two-chunk', minWords: 12, onChunk: (t) => chunks.push(t) })

  c.feed('Let me check the cron config. ')
  expect(chunks).toEqual([]) // held — below the 12-word floor

  c.recommendFlush()
  expect(chunks).toEqual(['Let me check the cron config.'])
})

test('two-chunk: flush works for a SECOND tool pause later in the same turn', () => {
  const chunks: string[] = []
  const c = new TextChunker({ mode: 'two-chunk', minWords: 12, onChunk: (t) => chunks.push(t) })

  c.feed('I will now go ahead and read the configuration file to see what is there. ')
  expect(chunks.length).toBe(1)

  c.feed('Now let me run the tests. ')
  c.recommendFlush()
  expect(chunks).toEqual([
    'I will now go ahead and read the configuration file to see what is there.',
    'Now let me run the tests.',
  ])
})

test('flush emits ALL complete buffered sentences, keeping the partial tail', () => {
  const chunks: string[] = []
  const c = new TextChunker({ mode: 'two-chunk', minWords: 12, onChunk: (t) => chunks.push(t) })

  // Two complete short sentences plus a dangling partial. The complete
  // sentences emit together as one chunk; the partial stays buffered.
  c.feed('First I will look. Then I will edit. And finally I')
  c.recommendFlush()

  expect(chunks).toEqual(['First I will look. Then I will edit.'])
})

test('flush with no complete sentence emits nothing (never cuts mid-phrase)', () => {
  const chunks: string[] = []
  const c = new TextChunker({ mode: 'two-chunk', minWords: 12, onChunk: (t) => chunks.push(t) })

  c.feed('Let me just')
  c.recommendFlush()
  expect(chunks).toEqual([])
})

test('flush is one-shot: the next short sentence is held again at normal threshold', () => {
  const chunks: string[] = []
  const c = new TextChunker({ mode: 'two-chunk', minWords: 12, onChunk: (t) => chunks.push(t) })

  c.feed('Reading the file. ')
  c.recommendFlush()
  expect(chunks).toEqual(['Reading the file.'])

  c.feed('Short one. ') // below floor, no flush this time
  expect(chunks).toEqual(['Reading the file.'])
})

test('sentence: flush emits a complete sub-minWords sentence', () => {
  const chunks: string[] = []
  const c = new TextChunker({ mode: 'sentence', minWords: 12, onChunk: (t) => chunks.push(t) })

  c.feed('Reading the file now. ')
  expect(chunks).toEqual([])
  c.recommendFlush()
  expect(chunks).toEqual(['Reading the file now.'])
})
