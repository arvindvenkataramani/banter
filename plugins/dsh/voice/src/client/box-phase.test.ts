import { describe, expect, it } from 'vitest'
import type { DshInputState } from './dsh-types'
import { dshSendEvent } from './box-phase'

const input = (phase: DshInputState['phase'], draft: string): DshInputState => ({ phase, draft, draftRev: 1 })

describe('dsh send detection from the input phase', () => {
  it('the phase becoming sending is a send', () => {
    expect(dshSendEvent('plain', input('sending', 'hello'))).toBe('send')
  })

  it('sending ending with the box emptied is an accepted send, which needs no report', () => {
    expect(dshSendEvent('sending', input('plain', ''))).toBeNull()
  })

  it('sending ending with text left in the box is a refusal', () => {
    expect(dshSendEvent('sending', input('plain', 'hello'))).toBe('refused')
  })

  it('a phase that stays sending, or one that never was, reports nothing', () => {
    expect(dshSendEvent('sending', input('sending', 'hello'))).toBeNull()
    expect(dshSendEvent('plain', input('plain', 'hello'))).toBeNull()
  })
})
