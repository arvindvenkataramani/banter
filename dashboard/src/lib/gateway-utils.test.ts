import { describe, expect, test } from 'vitest'
import { extractMessageText } from './gateway-utils'

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
