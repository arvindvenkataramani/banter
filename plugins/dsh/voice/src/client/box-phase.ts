// What a change in dsh's input phase says about a send through dsh's own Send.

import type { DshInputState } from './dsh-types.ts'

/**
 * A send through dsh's own Send shows as the phase becoming 'sending'. dsh
 * accepts a send by clearing the box as the phase ends, so text left in the
 * box when 'sending' ends means it refused.
 */
export function dshSendEvent(previousPhase: DshInputState['phase'], input: DshInputState): 'send' | 'refused' | null {
  if (previousPhase !== 'sending' && input.phase === 'sending') return 'send'
  if (previousPhase === 'sending' && input.phase !== 'sending' && input.draft !== '') return 'refused'
  return null
}
