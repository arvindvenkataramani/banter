// The settings page's summary carries each stored selection's error, as GET /api/voice
// serves it (`stt.selectionError`, `tts.selection.selectionError`), on the row it concerns,
// and nothing while the selections pass.

import { describe, expect, it } from 'vitest'
import type { VoiceConfig } from '@platform/voice-engine/voice-config'
import { voiceSummary } from './voice-summary'

const TTS_ERROR = 'tts-a cannot synthesize: it provides openai.audio.transcriptions'
const STT_ERROR = 'stt-a cannot transcribe or transcribeStream: it provides no API'

const config = (errors: { tts?: string; stt?: string } = {}): VoiceConfig => ({
  tts: {
    models: [{ id: 'a-one', name: 'A One', canClone: false }],
    providers: [{ serviceId: 'tts-a', name: 'Provider A', serves: [{ model: 'a-one', realtime: true }] }],
    voices: [{ id: 'a1', name: 'A1', renderings: [{ model: 'a-one', method: 'preset' }] }],
    selection: { serviceId: 'tts-a', model: 'a-one', voice: 'a1', speed: 1, ...(errors.tts && { selectionError: errors.tts }) },
  },
  stt: {
    serviceId: 'stt-a',
    options: [{ serviceId: 'stt-a', name: 'STT A' }],
    ...(errors.stt && { selectionError: errors.stt }),
  },
} as unknown as VoiceConfig)

const row = (rows: ReturnType<typeof voiceSummary>, label: string) => rows.find(r => r.label === label)!

describe('voiceSummary', () => {
  it('puts each stored selection error on the row of the selection it concerns', () => {
    const rows = voiceSummary(config({ tts: TTS_ERROR, stt: STT_ERROR }))
    expect(row(rows, 'Transcription').problem).toBe(STT_ERROR)
    expect(row(rows, 'Voice').problem).toBe(TTS_ERROR)
    expect(rows.filter(r => r.problem !== undefined)).toHaveLength(2)
  })

  it('carries no problem while the selections pass', () => {
    expect(voiceSummary(config()).every(r => r.problem === undefined)).toBe(true)
  })

  it('still names what is selected beside the problem', () => {
    const rows = voiceSummary(config({ stt: STT_ERROR }))
    expect(row(rows, 'Transcription').value).toContain('STT A')
    expect(row(rows, 'Voice').value).toBe('Provider A · A One · A1')
  })
})
