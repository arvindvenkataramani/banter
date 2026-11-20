import { describe, expect, it } from 'vitest'
import { normaliseServerUrl } from './server-url'

describe('server URL field', () => {
  it('surrounding space and trailing slashes are removed', () => {
    expect(normaliseServerUrl('  http://banter.invalid:7000//  ')).toEqual({ ok: true, url: 'http://banter.invalid:7000' })
    expect(normaliseServerUrl('https://banter.invalid/base/')).toEqual({ ok: true, url: 'https://banter.invalid/base' })
  })

  it('anything other than an absolute http or https URL is refused with a problem', () => {
    for (const input of ['banter.invalid:7000', 'ftp://banter.invalid', '/relative', 'http://', 'not a url']) {
      const result = normaliseServerUrl(input)
      expect(result.ok, input).toBe(false)
      if (!result.ok) expect(result.problem.length, input).toBeGreaterThan(0)
    }
  })

  it('an empty value is accepted as unset', () => {
    expect(normaliseServerUrl('   ')).toEqual({ ok: true, url: '' })
  })
})
