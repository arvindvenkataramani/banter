import { describe, expect, test } from 'vitest'
import { stripInjectedEnvelope } from './session-manager'

describe('stripInjectedEnvelope', () => {
  test('drops an untrusted-metadata block and keeps what follows', () => {
    const input = [
      'Conversation info (untrusted metadata):',
      '```json',
      '{',
      '  "chat_id": "channel:1486129145422417970"',
      '}',
      '```',
      '',
      'what did the deploy do?',
    ].join('\n')
    expect(stripInjectedEnvelope(input)).toBe('what did the deploy do?')
  })

  test('drops a Sender metadata block', () => {
    const input = 'Sender (untrusted metadata):\n```json\n{ "label": "alex" }\n```\nhello there'
    expect(stripInjectedEnvelope(input)).toBe('hello there')
  })

  // Collapsed to one line and truncated, so the closing fence is often gone.
  test('drops a one-line envelope whose closing fence was truncated away', () => {
    const input = 'Sender (untrusted metadata): ```json { "label":"alex","platform":"disc'
    expect(stripInjectedEnvelope(input)).toBe('')
  })

  test('drops a collapsed one-line envelope and keeps the message after it', () => {
    const input = 'Sender (untrusted metadata): ```json { "label": "alex" } ``` how did the deploy go?'
    expect(stripInjectedEnvelope(input)).toBe('how did the deploy go?')
  })

  test('drops a bracketed channel preamble', () => {
    expect(stripInjectedEnvelope('[WhatsApp 2026-01-24 13:36] yolo')).toBe('yolo')
  })

  test('drops a heartbeat preamble', () => {
    expect(stripInjectedEnvelope('[OpenClaw heartbeat] check in')).toBe('check in')
  })

  test('leaves an ordinary message untouched', () => {
    const plain = "don't use mcporter!"
    expect(stripInjectedEnvelope(plain)).toBe(plain)
  })

  test('preserves brackets that appear later in the text', () => {
    const input = 'fix the [1m] suffix handling'
    expect(stripInjectedEnvelope(input)).toBe(input)
  })

  test('returns empty when the message is nothing but an envelope', () => {
    const input = 'Conversation info (untrusted metadata):\n```json\n{ "a": 1 }\n```'
    expect(stripInjectedEnvelope(input)).toBe('')
  })

  test('handles empty input', () => {
    expect(stripInjectedEnvelope('')).toBe('')
  })
})
