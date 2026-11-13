import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { PageSecurityNotice } from './page-security-notice'
import { voicePageSupport } from './voice-page-support'

afterEach(cleanup)

describe('voicePageSupport', () => {
  test('a page that is not a secure context cannot use the microphone', () => {
    expect(voicePageSupport({ isSecureContext: false, crossOriginIsolated: false })).toBe('insecure')
  })

  test('a secure page without isolation runs the voice models on one thread', () => {
    expect(voicePageSupport({ isSecureContext: true, crossOriginIsolated: false })).toBe('not-isolated')
  })

  test('a secure, isolated page has full voice support', () => {
    expect(voicePageSupport({ isSecureContext: true, crossOriginIsolated: true })).toBe('ok')
  })
})

describe('PageSecurityNotice', () => {
  test('renders nothing on a secure, isolated page', () => {
    const { container } = render(<PageSecurityNotice page={{ isSecureContext: true, crossOriginIsolated: true }} />)
    expect(container.innerHTML).toBe('')
  })

  test('on an insecure page, alerts that voice cannot start and points at https', () => {
    render(<PageSecurityNotice page={{ isSecureContext: false, crossOriginIsolated: false }} />)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/microphone/i)
    expect(alert.textContent).toMatch(/https/)
  })

  test('on a secure page without isolation, notes single-threaded turn detection without alerting', () => {
    render(<PageSecurityNotice page={{ isSecureContext: true, crossOriginIsolated: false }} />)
    expect(screen.queryByRole('alert')).toBeNull()
    const note = screen.getByRole('status')
    expect(note.textContent).toMatch(/one thread/i)
    expect(note.textContent).toMatch(/Cross-Origin-Opener-Policy/)
  })
})
