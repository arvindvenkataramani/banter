// A stored selection that fails the selection check is shown beside the selector it
// concerns, from `tts.selection.selectionError` and `stt.selectionError` as
// GET /api/voice serves them, and nothing is shown while the selection passes.

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { VoiceConfig } from '@platform/voice-engine/voice-config'
import { seedDraft, selectionErrors, setProvider, setSttService, sttPickerOptions } from './voice-settings-model'
import { ListeningPanel, SpeechPanel } from './voice-settings-panels'

const TTS_ERROR = 'tts-a cannot synthesize: it provides openai.audio.transcriptions'
const STT_ERROR = 'stt-a cannot transcribe: it provides fluid.stt.stream'

function config(errors: { tts?: string; stt?: string } = {}): VoiceConfig {
  return {
    tts: {
      models: [{ id: 'a-one', name: 'A One', canClone: false }, { id: 'b-one', name: 'B One', canClone: false }],
      providers: [
        { serviceId: 'tts-a', name: 'Provider A', serves: [{ model: 'a-one', realtime: true }] },
        { serviceId: 'tts-b', name: 'Provider B', serves: [{ model: 'b-one', realtime: true }] },
      ],
      voices: [
        { id: 'a1', name: 'A1', renderings: [{ model: 'a-one', method: 'preset' }] },
        { id: 'b1', name: 'B1', renderings: [{ model: 'b-one', method: 'preset' }] },
      ],
      selection: { serviceId: 'tts-a', model: 'a-one', voice: 'a1', speed: 1, ...(errors.tts && { selectionError: errors.tts }) },
    },
    stt: {
      serviceId: 'stt-a',
      options: [
        { serviceId: 'stt-a', name: 'STT A', provides: [{ api: 'fluid.stt.stream' }] },
        { serviceId: 'stt-b', name: 'STT B', provides: [{ api: 'openai.audio.transcriptions' }] },
      ],
      ...(errors.stt && { selectionError: errors.stt }),
    },
  } as unknown as VoiceConfig
}

const draftOf = (cfg: VoiceConfig) => seedDraft(cfg, cfg.tts.selection!)
const noEdit = () => {}

afterEach(cleanup)

// jsdom has no ResizeObserver, which the Radix controls on these panels observe with.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }

describe('selectionErrors', () => {
  it('carries each served failure while the draft names the stored service', () => {
    expect(selectionErrors(draftOf(config({ tts: TTS_ERROR, stt: STT_ERROR })))).toEqual({ tts: TTS_ERROR, stt: STT_ERROR })
  })

  it('is empty when nothing fails', () => {
    expect(selectionErrors(draftOf(config()))).toEqual({})
  })

  it('drops a failure once the draft names another service, since it concerns the stored one', () => {
    const draft = draftOf(config({ tts: TTS_ERROR, stt: STT_ERROR }))
    expect(selectionErrors(setProvider(draft, 'tts-b')).tts).toBeUndefined()
    expect(selectionErrors(setSttService(draft, 'stt-b')).stt).toBeUndefined()
  })
})

describe('the voice settings panels', () => {
  const speech = (cfg: VoiceConfig) => render(<TooltipProvider><SpeechPanel draft={draftOf(cfg)} edit={noEdit} /></TooltipProvider>)
  const listening = (cfg: VoiceConfig) => render(<TooltipProvider><ListeningPanel draft={draftOf(cfg)} edit={noEdit} /></TooltipProvider>)

  it('show the TTS failure on the Speech tab when it is served', () => {
    speech(config({ tts: TTS_ERROR }))
    expect(screen.getByRole('alert').textContent).toBe(TTS_ERROR)
  })

  it('show the STT failure on the Listening tab when it is served', () => {
    listening(config({ stt: STT_ERROR }))
    expect(screen.getByRole('alert').textContent).toBe(STT_ERROR)
  })

  it('show no failure when none is served', () => {
    speech(config())
    listening(config())
    expect(screen.queryAllByRole('alert')).toEqual([])
  })

  it('keep each failure on its own tab', () => {
    speech(config({ stt: STT_ERROR }))
    listening(config({ tts: TTS_ERROR }))
    expect(screen.queryAllByRole('alert')).toEqual([])
  })
})

// An STT service that declares no API to transcribe through is listed, labelled and
// disabled, with the reason GET /api/voice served as `unavailable`.
describe('sttPickerOptions', () => {
  const withUnavailable = (stored: string) => {
    const cfg = config()
    const stt = cfg.stt as unknown as { serviceId: string; options: { serviceId: string; name: string; unavailable?: string }[] }
    stt.serviceId = stored
    stt.options.push({ serviceId: 'stt-c', name: 'STT C', unavailable: 'stt-c cannot transcribe or transcribeStream: it provides no API' })
    return draftOf(cfg)
  }

  it('lists an unavailable service disabled and labelled, and leaves usable ones as they are', () => {
    expect(sttPickerOptions(withUnavailable('stt-a'))).toEqual([
      { value: 'stt-a', label: 'STT A', disabled: false },
      { value: 'stt-b', label: 'STT B', disabled: false },
      { value: 'stt-c', label: 'STT C (no usable API)', disabled: true },
    ])
  })

  it('keeps an unavailable service enabled while the draft names it, so the field still shows it', () => {
    expect(sttPickerOptions(withUnavailable('stt-c')).find(o => o.value === 'stt-c')).toEqual({ value: 'stt-c', label: 'STT C (no usable API)', disabled: false })
  })
})
