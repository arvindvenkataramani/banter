import { describe, expect, it, vi } from 'vitest'
import type { VoiceConfig } from '@platform/voice-engine/voice-config'
import { createConfigFeed } from './config-feed'

const config = (voice: string): VoiceConfig => ({
  tts: { models: [], providers: [], voices: [], selection: { serviceId: 'tts-b', model: 'model-1', voice, speed: 1 } },
  stt: { serviceId: 'stt-a' },
})

const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function setup() {
  const fetch = vi.fn<typeof globalThis.fetch>()
  let clock = 1000
  const feed = createConfigFeed({ origin: 'http://dsh.invalid', fetch, now: () => clock })
  return { fetch, feed, tick: (ms: number) => { clock += ms } }
}

describe('config feed', () => {
  it('a reload puts the fetched config in use with its load time, and tells subscribers', async () => {
    const { fetch, feed } = setup()
    const listener = vi.fn()
    feed.subscribe(listener)
    fetch.mockResolvedValueOnce(answer(config('voice-1')))

    await feed.reload()

    expect(fetch.mock.calls[0]?.[0]).toBe('http://dsh.invalid/dsh-voice/voice')
    expect(feed.state()).toEqual({ config: config('voice-1'), loadedAt: 1000, error: null })
    expect(listener).toHaveBeenCalled()
  })

  it('a failed reload keeps the config in use and reports the reason', async () => {
    const { fetch, feed, tick } = setup()
    fetch.mockResolvedValueOnce(answer(config('voice-1')))
    await feed.reload()
    tick(5000)

    fetch.mockResolvedValueOnce(answer({ reason: 'Banter answered 503' }, 502))
    await feed.reload()
    expect(feed.state()).toEqual({ config: config('voice-1'), loadedAt: 1000, error: 'Banter answered 503' })

    fetch.mockRejectedValueOnce(new TypeError('fetch failed'))
    await feed.reload()
    expect(feed.state()).toEqual({ config: config('voice-1'), loadedAt: 1000, error: 'No answer from dsh' })
  })

  it('a reload that resolves after a later one has landed does not replace it', async () => {
    const { fetch, feed } = setup()
    let answerFirst: (response: Response) => void = () => {}
    fetch.mockImplementationOnce(() => new Promise(resolve => { answerFirst = resolve }))
    fetch.mockResolvedValueOnce(answer(config('voice-new')))

    const first = feed.reload()
    await feed.reload()
    answerFirst(answer(config('voice-old')))
    await first

    expect(feed.state().config).toEqual(config('voice-new'))
  })

  it('a reload that fails after a later one has landed does not report its failure', async () => {
    const { fetch, feed } = setup()
    let failFirst: (error: Error) => void = () => {}
    fetch.mockImplementationOnce(() => new Promise((_resolve, reject) => { failFirst = reject }))
    fetch.mockResolvedValueOnce(answer(config('voice-new')))

    const first = feed.reload()
    await feed.reload()
    failFirst(new TypeError('fetch failed'))
    await first

    expect(feed.state()).toEqual({ config: config('voice-new'), loadedAt: 1000, error: null })
  })

  it('a check reports reachability and leaves the config and error as they were', async () => {
    const { fetch, feed } = setup()
    fetch.mockResolvedValueOnce(answer(config('voice-1')))
    await feed.reload()
    const before = feed.state()
    const listener = vi.fn()
    feed.subscribe(listener)

    fetch.mockResolvedValueOnce(answer({ reason: 'No answer from http://control.invalid' }, 502))
    expect(await feed.check()).toEqual({ ok: false, reason: 'No answer from http://control.invalid' })
    fetch.mockResolvedValueOnce(answer(config('voice-2')))
    expect(await feed.check()).toEqual({ ok: true })

    expect(fetch.mock.calls[1]?.[0]).toBe('http://dsh.invalid/dsh-voice/voice/check')
    expect(feed.state()).toEqual(before)
    expect(listener).not.toHaveBeenCalled()
  })
})
