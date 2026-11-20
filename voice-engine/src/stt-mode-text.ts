// The sentence both settings pages show while voice is on: how speech is being
// transcribed, and why when the model, not the choice, decided it.

import type { VoiceSystemState } from './system/voice-system'

const AFTER_PAUSE = 'so your words appear after each pause, with no live preview'

export function describeSttInUse(stt: NonNullable<VoiceSystemState['stt']>): string {
  if (stt.mode === 'streaming') {
    return stt.decidedBy === 'model' ? `In use now: streaming, because ${stt.model} only streams.` : 'In use now: streaming.'
  }
  if (stt.decidedBy === 'model') return `In use now: batch, because ${stt.model} only transcribes in batch, ${AFTER_PAUSE}.`
  if (stt.decidedBy === 'unknown') return `In use now: batch, because the server didn't say whether ${stt.model} streams, ${AFTER_PAUSE}.`
  return `In use now: batch, ${AFTER_PAUSE}.`
}
