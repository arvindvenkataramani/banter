import { describe, expect, it, vi } from 'vitest'
import type { VoiceConfig } from '@platform/voice-engine/voice-config'
import { createVoiceConfigSource } from './voice-config'

// A control-plane /api/voice answer, generic values only, with mic samples turned on.
const config = (sttServiceId: string, ttsServiceId: string): VoiceConfig => ({
  enabled: true,
  tts: {
    providers: [{ serviceId: ttsServiceId, responseFormat: 'mp3', models: [] }],
    selection: { serviceId: ttsServiceId, model: 'model-1', voice: 'voice-1', speed: 1 },
  },
  stt: { serviceId: sttServiceId },
  debug: { saveMicSamples: true },
})

const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function setup(url = 'http://control.invalid:7000') {
  const fetch = vi.fn<typeof globalThis.fetch>()
  const source = createVoiceConfigSource({ controlPlaneUrl: () => url, fetch })
  return { fetch, source }
}

describe('voice config source', () => {
  it('a load answers the server\'s config without its debug section and records the selected STT and TTS services', async () => {
    const { fetch, source } = setup()
    fetch.mockResolvedValueOnce(answer(config('stt-a', 'tts-b')))

    const result = await source.load()

    expect(fetch.mock.calls[0]?.[0]).toBe('http://control.invalid:7000/api/voice')
    expect(result.status).toBe(200)
    if (result.status !== 200) return
    expect(result.config.debug).toBeUndefined()
    expect(result.config.tts.selection?.serviceId).toBe('tts-b')
    expect(source.selected()).toEqual({ sttServiceId: 'stt-a', ttsServiceId: 'tts-b' })
  })

  it('a check answers the same and records nothing, keeping what an earlier load recorded', async () => {
    const { fetch, source } = setup()
    expect(source.selected()).toBeNull()
    fetch.mockResolvedValueOnce(answer(config('stt-a', 'tts-b')))
    expect((await source.check()).status).toBe(200)
    expect(source.selected()).toBeNull()

    fetch.mockResolvedValueOnce(answer(config('stt-a', 'tts-b')))
    await source.load()
    fetch.mockResolvedValueOnce(answer(config('stt-other', 'tts-other')))
    await source.check()

    expect(source.selected()).toEqual({ sttServiceId: 'stt-a', ttsServiceId: 'tts-b' })
  })

  it('with no URL nothing is fetched and the answer is 404 with its reason', async () => {
    const { fetch, source } = setup('')

    expect(await source.load()).toEqual({ status: 404, reason: 'No Banter server URL is set' })
    expect(await source.check()).toEqual({ status: 404, reason: 'No Banter server URL is set' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('no answer and a non-2xx are 502 with their reasons, and keep what an earlier load recorded', async () => {
    const { fetch, source } = setup()
    fetch.mockRejectedValueOnce(new TypeError('fetch failed'))
    await source.load()
    expect(source.selected()).toBeNull()
    fetch.mockResolvedValueOnce(answer(config('stt-a', 'tts-b')))
    await source.load()

    fetch.mockRejectedValueOnce(new TypeError('fetch failed'))
    expect(await source.load()).toEqual({ status: 502, reason: 'No answer from http://control.invalid:7000' })
    fetch.mockResolvedValueOnce(answer({ error: 'down' }, 503))
    expect(await source.load()).toEqual({ status: 502, reason: 'Banter answered 503' })

    expect(source.selected()).toEqual({ sttServiceId: 'stt-a', ttsServiceId: 'tts-b' })
  })

  it('the services of the selection before the current one stay served, so a page still on them keeps working', async () => {
    const { fetch, source } = setup()
    fetch.mockResolvedValueOnce(answer(config('stt-a', 'tts-b')))
    await source.load()
    fetch.mockResolvedValueOnce(answer(config('stt-c', 'tts-d')))
    await source.load()
    expect(source.allowed().sort()).toEqual(['stt-a', 'stt-c', 'tts-b', 'tts-d'])

    fetch.mockResolvedValueOnce(answer(config('stt-e', 'tts-d')))
    await source.load()
    expect(source.allowed().sort()).toEqual(['stt-c', 'stt-e', 'tts-d'])
  })

  it('a load that answers after a later load has recorded, or that started before a clear, records nothing', async () => {
    const { fetch, source } = setup()
    let answerFirst: (response: Response) => void = () => {}
    fetch.mockImplementationOnce(() => new Promise(resolve => { answerFirst = resolve }))
    fetch.mockResolvedValueOnce(answer(config('stt-new', 'tts-new')))
    const first = source.load()
    await source.load()
    answerFirst(answer(config('stt-old', 'tts-old')))
    await first
    expect(source.selected()).toEqual({ sttServiceId: 'stt-new', ttsServiceId: 'tts-new' })

    let answerBeforeClear: (response: Response) => void = () => {}
    fetch.mockImplementationOnce(() => new Promise(resolve => { answerBeforeClear = resolve }))
    const inFlight = source.load()
    source.clear()
    answerBeforeClear(answer(config('stt-old-banter', 'tts-old-banter')))
    await inFlight
    expect(source.selected()).toBeNull()
    expect(source.allowed()).toEqual([])
  })

  it('clearing forgets the recorded services, so the relays serve nothing until the next load', async () => {
    const { fetch, source } = setup()
    fetch.mockResolvedValueOnce(answer(config('stt-a', 'tts-b')))
    await source.load()

    source.clear()

    expect(source.selected()).toBeNull()
  })

  it('a change of recorded services is reported once, the first load included, and a load with the same services reports nothing', async () => {
    const { fetch, source } = setup()
    const listener = vi.fn()
    source.onChange(listener)

    fetch.mockResolvedValueOnce(answer(config('stt-a', 'tts-b')))
    await source.load()
    fetch.mockResolvedValueOnce(answer(config('stt-a', 'tts-b')))
    await source.load()
    expect(listener).toHaveBeenCalledTimes(1)

    fetch.mockResolvedValueOnce(answer(config('stt-c', 'tts-b')))
    await source.load()
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
