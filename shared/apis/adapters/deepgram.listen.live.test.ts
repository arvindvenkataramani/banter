// The deepgram.listen.live adapter (docs/reference/design/service-apis.md, "Adapters"): how it
// connects, what it sends, and how it turns Deepgram's results into the guarantees of
// `transcribeStream`: the whole utterance in each partial, and exactly one final per
// Finalize, an empty one included.
//
// The call and callbacks are those of fluid.stt.stream's adapter (see its test).
// INVENTED: the audio the caller gives is already encoded as `format` says, 'opus' for
// raw packets or 'pcm16' for 16-bit samples. INVENTED: the transcript sits where
// Deepgram's `Results.channel` puts it, at `channel.alternatives[0].transcript`.

import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test'
import * as listen from './deepgram.listen.live'
import { FakeWebSocket, installFakeWebSocket } from './test-support/fake-websocket'
import { startMockSocketServer, type MockSocketServer } from './test-support/mock-socket-server'

const bare = { api: 'deepgram.listen.live' }
const claiming = { ...bare, extends: ['session-claim'] }
const answering = { ...bare, extends: ['finalize-answered'] }

/** A Results message, as Deepgram sends it. */
const results = (transcript: string, flags: { is_final?: boolean; from_finalize?: boolean } = {}) => ({
  type: 'Results',
  channel_index: [0, 1],
  duration: 1,
  start: 0,
  is_final: flags.is_final ?? false,
  speech_final: false,
  from_finalize: flags.from_finalize ?? false,
  channel: { alternatives: [{ transcript, confidence: 0.9, words: [] }] },
})

const callbacks = () => ({ onPartial: mock(), onFinal: mock(), onReady: mock(), onClosed: mock() })

describe('over a real socket', () => {
  let server: MockSocketServer
  let session: { close(): void } | undefined

  beforeEach(() => { server = startMockSocketServer() })
  afterEach(() => { session?.close(); session = undefined; server.stop() })

  /** Opens a session against the server and waits for the connection. */
  async function open(over: Record<string, unknown> = {}) {
    const cb = callbacks()
    const call = { endpoint: server.endpoint, provision: bare, format: 'pcm16', ...over }
    const opened = listen.transcribeStream(call as never, cb as never)
    session = opened
    await server.waitFor(() => server.connections > 0)
    return { session: opened as never as Record<string, (...a: unknown[]) => unknown>, cb }
  }
  const query = () => server.requests[0].searchParams

  describe('connecting', () => {
    it('[T3] connects with encoding, sample_rate, channels=1, interim_results=true and endpointing=false, and model when named', async () => {
      await open({ model: 'opaque-key' })

      expect(query().get('encoding')).toBe('linear16')
      expect(Number(query().get('sample_rate'))).toBeGreaterThan(0)
      expect(query().get('channels')).toBe('1')
      expect(query().get('interim_results')).toBe('true')
      expect(query().get('endpointing')).toBe('false')
      expect(query().get('model')).toBe('opaque-key')
    })

    it('[T3] names no model when the caller names none', async () => {
      await open()
      expect(query().has('model')).toBe(false)
    })

    it.each([
      { name: 'a bare provision', provision: bare },
      { name: 'one that defaults endpointing to 700 and declares endpointing-off', provision: { ...bare, defaults: { endpointing: 700 }, extends: ['endpointing-off'] } },
    ])('[T3] sends endpointing=false whatever the server defaults to: $name', async ({ provision }) => {
      await open({ provision })
      expect(query().get('endpointing')).toBe('false')
    })

    it('[T3] opens the spec\'s path under the endpoint\'s own path and the provision\'s basePath', async () => {
      await open({ endpoint: `${server.endpoint}/relay/stt-a`, provision: { ...bare, basePath: '/alt' } })
      expect(server.requests[0].pathname).toBe('/relay/stt-a/alt/v1/listen')
    })
  })

  describe('the encoding', () => {
    // Whether opus is allowed at all is selection's call (the `opus` capability);
    // see select.test.ts.
    it('[T3] is opus when the caller sends Opus to a provision with opus-packets', async () => {
      await open({ provision: { ...bare, extends: ['opus-packets'] }, format: 'opus' })
      expect(query().get('encoding')).toBe('opus')
    })
  })

  describe('claiming the session', () => {
    it('[T3] carries the session id and take-over only with session-claim, and only when the caller asks', async () => {
      await open({ provision: claiming, session: 'sess-1', takeover: true })
      expect(query().get('session')).toBe('sess-1')
      expect(query().get('takeover')).toBe('1')
    })

    it('[T3] sends neither without the extension, whatever the caller asks', async () => {
      await open({ provision: bare, session: 'sess-1', takeover: true })
      expect(query().has('session')).toBe(false)
      expect(query().has('takeover')).toBe(false)
    })

    it('[T3] sends neither with the extension when the caller asks for nothing', async () => {
      await open({ provision: claiming })
      expect(query().has('session')).toBe(false)
      expect(query().has('takeover')).toBe(false)
    })
  })

  describe('what it sends', () => {
    it('[T3] sends audio as binary frames, Finalize on a finalize and CloseStream on a close', async () => {
      const { session: live } = await open()
      live.sendAudio(new Uint8Array([1, 2, 3]).buffer)
      live.finalize()
      live.close()
      session = undefined

      await server.waitFor(() => server.frames.length > 0 && server.messages.length >= 2)
      expect([...new Uint8Array(server.frames[0])]).toEqual([1, 2, 3])
      expect(server.messages.map((m) => m.type)).toEqual(['Finalize', 'CloseStream'])
    })
  })

  describe('the utterance so far', () => {
    it('[T3] goes out as a partial holding the settled segments and the interim one together, and starts over after a final', async () => {
      const { session: live, cb } = await open()

      server.send(results('hello'))
      await server.waitFor(() => cb.onPartial.mock.calls.length === 1)
      server.send(results('hello wor'))
      await server.waitFor(() => cb.onPartial.mock.calls.length === 2)
      server.send(results('hello world', { is_final: true }))
      await server.waitFor(() => cb.onPartial.mock.calls.length === 3)
      server.send(results('how are'))
      await server.waitFor(() => cb.onPartial.mock.calls.length === 4)

      expect(cb.onPartial.mock.calls.map((c) => c[0])).toEqual(['hello', 'hello wor', 'hello world', 'hello world how are'])

      live.finalize()
      server.send(results('how are you', { is_final: true, from_finalize: true }))
      await server.waitFor(() => cb.onFinal.mock.calls.length === 1)
      server.send(results('next'))
      await server.waitFor(() => cb.onPartial.mock.calls.length === 5)
      expect(cb.onPartial.mock.calls[4][0]).toBe('next')
    })

    // INVENTED: an is_final result settles the segment its interim results were
    // building, so it replaces that interim text rather than adding to it.
    it('[T3] the result answering a Finalize replaces the interim text of its segment in the final', async () => {
      const { session: live, cb } = await open()

      server.send(results('hello world', { is_final: true }))
      server.send(results('how are'))
      await server.waitFor(() => cb.onPartial.mock.calls.length === 2)
      live.finalize()
      server.send(results('how are you', { is_final: true, from_finalize: true }))
      await server.waitFor(() => cb.onFinal.mock.calls.length === 1)

      expect(cb.onFinal.mock.calls[0][0]).toBe('hello world how are you')
    })
  })

  describe('one final per Finalize', () => {
    it('[T3] answers a Finalize with an empty final when nothing was said', async () => {
      const { session: live, cb } = await open({ provision: answering })

      live.finalize()
      server.send(results('', { is_final: true, from_finalize: true }))
      await server.waitFor(() => cb.onFinal.mock.calls.length === 1)

      expect(cb.onFinal.mock.calls[0][0]).toBe('')
    })

    it('[T3] answers each of two Finalizes once, in order', async () => {
      const { session: live, cb } = await open({ provision: answering })

      live.finalize()
      live.finalize()
      server.send(results('first', { is_final: true, from_finalize: true }))
      server.send(results('second', { is_final: true, from_finalize: true }))
      await server.waitFor(() => cb.onFinal.mock.calls.length === 2)

      expect(cb.onFinal.mock.calls.map((c) => c[0])).toEqual(['first', 'second'])
    })

    it('[T3] gives no final for a result marked from_finalize that no Finalize is waiting for', async () => {
      const { cb } = await open({ provision: answering })

      server.send(results('stray', { is_final: true, from_finalize: true }))
      // A partial after it is processed after it: by then a final would have fired.
      server.send(results('later'))
      await server.waitFor(() => cb.onPartial.mock.calls.length > 0)

      expect(cb.onFinal).not.toHaveBeenCalled()
    })
  })
})

describe('the wait for a Finalize to be answered', () => {
  let restore: () => void

  beforeEach(() => {
    restore = installFakeWebSocket()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
    restore()
  })

  function connect(provision: unknown) {
    const cb = callbacks()
    const live = listen.transcribeStream({ endpoint: 'https://host:8767', provision, format: 'pcm16' } as never, cb as never) as never as Record<string, (...a: unknown[]) => unknown>
    const ws = FakeWebSocket.instances.at(-1)!
    ws.open()
    return { live, ws, cb }
  }

  it('[T3] without finalize-answered settles on the utterance so far after 3000 ms, and not at 2999', () => {
    const { live, ws, cb } = connect(bare)
    ws.deliver(results('so far', { is_final: true }))
    live.finalize()

    jest.advanceTimersByTime(2999)
    expect(cb.onFinal).not.toHaveBeenCalled()
    jest.advanceTimersByTime(1)

    expect(cb.onFinal).toHaveBeenCalledTimes(1)
    expect(cb.onFinal.mock.calls[0][0]).toBe('so far')
  })

  it('[T3] without finalize-answered settles at once on a result marked from_finalize, and the timer then adds no second final', () => {
    const { live, ws, cb } = connect(bare)
    live.finalize()
    ws.deliver(results('answered', { is_final: true, from_finalize: true }))

    expect(cb.onFinal).toHaveBeenCalledTimes(1)
    jest.advanceTimersByTime(10_000)
    expect(cb.onFinal).toHaveBeenCalledTimes(1)
  })

  it('[T3] a result marked from_finalize that arrives after the wait ended gives no second final', () => {
    const { live, ws, cb } = connect(bare)
    live.finalize()
    jest.advanceTimersByTime(3000)
    expect(cb.onFinal).toHaveBeenCalledTimes(1)

    ws.deliver(results('late', { is_final: true, from_finalize: true }))

    expect(cb.onFinal).toHaveBeenCalledTimes(1)
  })

  it('[T3] with finalize-answered never settles on the timer, only on the answer', () => {
    const { live, ws, cb } = connect(answering)
    live.finalize()

    jest.advanceTimersByTime(10_000)
    expect(cb.onFinal).not.toHaveBeenCalled()

    ws.deliver(results('answered', { is_final: true, from_finalize: true }))
    expect(cb.onFinal).toHaveBeenCalledTimes(1)
    expect(cb.onFinal.mock.calls[0][0]).toBe('answered')
  })

  it('[T3] sends KeepAlive while no audio flows', () => {
    const { ws } = connect(bare)
    jest.advanceTimersByTime(30_000)

    expect(ws.jsonFrames.some((frame) => frame.type === 'KeepAlive')).toBe(true)
  })
})
