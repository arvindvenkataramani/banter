import { describe, expect, test } from 'vitest'
import { ChatTextAssembler, extractMessageText } from './gateway-utils'

// `content` is a union: a plain string (typed user messages) or an array of
// blocks (assistant messages).

describe('extractMessageText', () => {
  test('reads a user message whose content is a plain string', () => {
    expect(extractMessageText({ role: 'user', content: 'move outlook to 7:30' }))
      .toBe('move outlook to 7:30')
  })

  test('reads an assistant message whose content is an array of blocks', () => {
    expect(extractMessageText({ role: 'assistant', content: [{ type: 'text', text: 'Hello there.' }] }))
      .toBe('Hello there.')
  })

  test('joins multiple text blocks in order', () => {
    expect(extractMessageText({
      content: [{ type: 'text', text: 'one ' }, { type: 'text', text: 'two' }],
    })).toBe('one two')
  })

  test('ignores non-text blocks such as images and tool calls', () => {
    expect(extractMessageText({
      content: [
        { type: 'image', omitted: true, bytes: 1024 },
        { type: 'text', text: 'caption' },
        { type: 'tool_use', id: 'tu_1', name: 'bash' },
      ],
    })).toBe('caption')
  })

  test('prefers a top-level text field over content', () => {
    expect(extractMessageText({ text: 'shorthand', content: 'ignored' })).toBe('shorthand')
  })

  test('reads a bare string message', () => {
    expect(extractMessageText('bare')).toBe('bare')
  })

  test('returns empty string for a media-only message with no text', () => {
    expect(extractMessageText({ role: 'user', content: '', MediaPath: '/tmp/x.png' })).toBe('')
  })

  test('returns empty string for null, undefined, and unexpected shapes', () => {
    expect(extractMessageText(null)).toBe('')
    expect(extractMessageText(undefined)).toBe('')
    expect(extractMessageText({ role: 'user' })).toBe('')
    expect(extractMessageText(42)).toBe('')
  })
})

describe('ChatTextAssembler', () => {
  const run = 'r1'
  const msg = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] })
  const ev = (seq: number, state: string, fields: Record<string, unknown>) => ({ runId: run, sessionKey: 'agent:main:main', seq, state, ...fields })

  test('rebuilds the text so far from deltaText increments, ignoring the null message', () => {
    const a = new ChatTextAssembler()
    expect(a.accept(ev(1, 'delta', { deltaText: 'Done', message: msg('Done') }))?.message).toBe('Done')
    expect(a.accept(ev(2, 'delta', { deltaText: '. Both', message: null }))?.message).toBe('Done. Both')
    expect(a.accept(ev(3, 'delta', { deltaText: ' updated', message: null }))?.message).toBe('Done. Both updated')
  })

  test.each([
    ['carries its own message', msg('Done. Both updated.'), 'Done. Both updated.'],
    ['has no message', null, 'Done. Both'],
  ])('a final that %s yields the whole text', (_name, message, expected) => {
    const a = new ChatTextAssembler()
    a.accept(ev(1, 'delta', { deltaText: 'Done', message: msg('Done') }))
    a.accept(ev(2, 'delta', { deltaText: '. Both', message: null }))
    expect(a.accept(ev(3, 'final', { message }))?.message).toBe(expected)
  })

  test('a delta trailing its own final is dropped', () => {
    const a = new ChatTextAssembler()
    a.accept(ev(1, 'delta', { deltaText: 'Done', message: msg('Done') }))
    a.accept(ev(3, 'final', { message: msg('Done.') }))
    expect(a.accept(ev(2, 'delta', { deltaText: '.', message: null }))).toBeNull()
  })

  test('a delta without deltaText takes its message as the text so far', () => {
    const a = new ChatTextAssembler()
    expect(a.accept(ev(1, 'delta', { message: msg('Hello') }))?.message).toBe('Hello')
    expect(a.accept(ev(2, 'delta', { message: msg('Hello there') }))?.message).toBe('Hello there')
  })

  test('status events pass through untouched', () => {
    const a = new ChatTextAssembler()
    expect(a.accept(ev(1, 'status', { message: null }))?.message).toBe('')
  })
})
