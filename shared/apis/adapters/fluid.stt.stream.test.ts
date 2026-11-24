// The fluid.stt.stream adapter (dev/specs/service-apis.md, section 8): the stream
// socket client moved from voice-engine, its behaviour unchanged. The first four
// describe blocks are the moved tests, with the call shape below; the last two are
// what the move adds.
//
// INVENTED: an adapter's `transcribeStream` takes `(call, callbacks)` and returns the
// open session. The call is `{ endpoint, provision, model, format, chunkMs?, session?,
// takeover? }`; the callbacks are those the socket client had (`onPartial`, `onFinal`,
// `onReady`, `onClosed`); the session has `sendAudio`, `setSending`, `finalize`,
// `close` and `isOpen`. deepgram.listen.live and openai.realtime share this shape.

import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test'
import * as stream from './fluid.stt.stream'
import { FakeWebSocket, installFakeWebSocket } from './test-support/fake-websocket'

const bare = { api: 'fluid.stt.stream' }

function open(over: Record<string, unknown> = {}) {
  const cb = { onPartial: mock(), onFinal: mock(), onReady: mock(), onClosed: mock() }
  const call = { endpoint: 'https://host:8767', provision: bare, model: 'test-model', format: 'opus', ...over }
  const session = stream.transcribeStream(call as never, cb as never)
  const ws = FakeWebSocket.instances.at(-1)!
  return { session, ws, cb }
}

function connect(over: Record<string, unknown> = {}) {
  const made = open(over)
  made.ws.open()
  return made
}

let restore: () => void

beforeEach(() => {
  restore = installFakeWebSocket()
  jest.useFakeTimers()
})

afterEach(() => {
  jest.useRealTimers()
  restore()
})

describe('connection', () => {
  it('[T2] asserts the model and format in the URL', () => {
    const { ws } = connect()
    expect(ws.url).toBe('wss://host:8767/v1/audio/stream?model=test-model&format=opus')
  })

  it('[T2] reports the server transcripts', () => {
    const { ws, cb } = connect()
    ws.deliver({ type: 'transcript', is_final: false, text: 'partial text' })
    ws.deliver({ type: 'transcript', is_final: true, text: 'settled text' })

    expect(cb.onPartial).toHaveBeenCalledWith('partial text')
    // No Finalize was sent, so there is no wait to report.
    expect(cb.onFinal).toHaveBeenCalledWith('settled text', null)
  })
})

describe('audio captured before the socket opens', () => {
  it('[T2] is sent once the socket is open, rather than dropped', () => {
    const { session, ws } = open()
    session.sendAudio(new ArrayBuffer(8))
    session.sendAudio(new ArrayBuffer(8))
    expect(ws.binaryFrames).toHaveLength(0)

    ws.open()

    // Capture starts before the handshake finishes; dropping here loses the
    // beginning of the first turn.
    expect(ws.binaryFrames).toHaveLength(2)
  })

  it('[T2] keeps the held frames ahead of what follows them', () => {
    const { session, ws } = open()
    const first = new ArrayBuffer(1)
    session.sendAudio(first)
    ws.open()
    session.sendAudio(new ArrayBuffer(2))

    expect(ws.binaryFrames[0]).toBe(first)
    expect(ws.binaryFrames).toHaveLength(2)
  })

  it('[T2] holds nothing while muted', () => {
    const { session, ws } = open()
    session.setSending(false)
    session.sendAudio(new ArrayBuffer(8))
    ws.open()

    expect(ws.binaryFrames).toHaveLength(0)
  })

  it('[T2] bounds what it holds, so a socket that never opens cannot grow it', () => {
    const { session, ws } = open()
    for (let i = 0; i < 200; i++) session.sendAudio(new ArrayBuffer(8))
    ws.open()

    expect(ws.binaryFrames.length).toBeLessThanOrEqual(24)
  })
})

describe('audio transmission', () => {
  it('[T2] sends captured frames while unmuted, stops while muted and resumes on unmute', () => {
    const { session, ws } = connect()
    session.sendAudio(new ArrayBuffer(8))
    session.setSending(false)
    session.sendAudio(new ArrayBuffer(8))
    session.setSending(true)
    session.sendAudio(new ArrayBuffer(8))

    expect(ws.binaryFrames).toHaveLength(2)
  })

  it('[T2] keeps sending KeepAlive while muted', () => {
    const { session, ws } = connect()
    session.setSending(false)
    jest.advanceTimersByTime(4000)

    expect(ws.textFrames).toContain(JSON.stringify({ type: 'KeepAlive' }))
  })
})

describe('turn end', () => {
  it('[T2] sends Finalize and leaves the socket open', () => {
    const { session, ws } = connect()
    session.finalize()

    expect(ws.textFrames).toEqual([JSON.stringify({ type: 'Finalize' })])
    expect(session.isOpen).toBe(true)
  })

  it('[T2] reports how long the settled transcript took to come back, and none for a final nobody asked for', () => {
    const { session, ws, cb } = connect()
    session.finalize()
    ws.deliver({ type: 'transcript', is_final: true, text: 'done' })
    ws.deliver({ type: 'transcript', is_final: true, text: 'second' })

    const [, waitMs] = cb.onFinal.mock.calls[0]
    expect(typeof waitMs).toBe('number')
    expect(waitMs).toBeGreaterThanOrEqual(0)
    // A final with no Finalize outstanding has no wait to report rather than one
    // measured from the previous turn.
    expect(cb.onFinal.mock.calls[1][1]).toBeNull()
  })
})

describe('a closed socket ends the session', () => {
  it('[T2] reports a dropped connection once', () => {
    const { ws, cb } = connect()
    ws.drop('going away')

    expect(cb.onClosed).toHaveBeenCalledTimes(1)
    expect(cb.onClosed.mock.calls[0][0]).toContain('going away')
  })

  it('[T2] reports an error frame by its own message, not the close that follows', () => {
    const { ws, cb } = connect()
    ws.deliver({ type: 'error', message: 'no model is loaded' })
    ws.drop()

    expect(cb.onClosed).toHaveBeenCalledTimes(1)
    expect(cb.onClosed.mock.calls[0][0]).toContain('no model is loaded')
  })

  it('[T2] reports once when a failed connection fires both error and close', () => {
    const { ws, cb } = connect()
    ;(ws.onerror as unknown as (() => void) | null)?.()
    ws.drop()

    expect(cb.onClosed).toHaveBeenCalledTimes(1)
  })

  it('[T2] stops the keepalive and the audio once the session ends', () => {
    const { session, ws } = connect()
    ws.drop()
    const after = ws.sent.length
    jest.advanceTimersByTime(20000)
    session.sendAudio(new ArrayBuffer(8))

    expect(ws.sent).toHaveLength(after)
  })

  it('[T2] sends CloseStream on a deliberate close and discards the reply', () => {
    const { session, ws, cb } = connect()
    session.close()
    ws.deliver({ type: 'transcript', is_final: true, text: 'too late' })

    expect(ws.textFrames).toContain(JSON.stringify({ type: 'CloseStream' }))
    expect(cb.onFinal).not.toHaveBeenCalled()
    expect(cb.onClosed).not.toHaveBeenCalled()
  })

  // A close in 4001-4010 carries the protocol's error code with no error frame
  // before it (`replaced` sends none at all).
  it('[T2] names the protocol error code of a 4001 to 4010 close, and none for any other', () => {
    const names = ['held', 'superseded', 'idle', 'model_not_loaded', 'model_mismatch', 'busy', 'bad_format', 'bad_audio', 'failed', 'replaced']
    names.forEach((name, i) => {
      const { ws, cb } = connect()
      ws.drop('closed', 4001 + i)
      expect(cb.onClosed.mock.calls[0][1]).toBe(name)
    })
    const { ws, cb } = connect()
    ws.drop('closed', 1006)
    expect(cb.onClosed.mock.calls[0][1]).toBeNull()
  })
})

describe('the claim on the server', () => {
  const params = (ws: FakeWebSocket) => new URL(ws.url).searchParams

  it('[T2] carries no session and no take-over unless the caller asks for them', () => {
    const { ws } = connect()
    expect(params(ws).has('session')).toBe(false)
    expect(params(ws).has('takeover')).toBe(false)
  })

  it('[T2] carries the session id, and take-over only when asked for it', () => {
    const named = connect({ session: 'sess-1' }).ws
    expect(params(named).get('session')).toBe('sess-1')
    expect(params(named).has('takeover')).toBe(false)

    const taking = connect({ session: 'sess-1', takeover: true }).ws
    expect(params(taking).get('session')).toBe('sess-1')
    expect(params(taking).get('takeover')).toBe('1')
  })

  // INVENTED: a provision that omits `parameter:session` does not implement it, so
  // the adapter sends neither field however the caller asks.
  it('[T2] sends neither when the provision omits the session parameter', () => {
    const { ws } = connect({ provision: { ...bare, omits: ['parameter:session'] }, session: 'sess-1', takeover: true })
    expect(params(ws).has('session')).toBe(false)
    expect(params(ws).has('takeover')).toBe(false)
  })
})

describe('the path', () => {
  it('[T2] is the spec\'s, prefixed by the provision\'s basePath and then by the path the endpoint carries', () => {
    const { ws } = connect({ endpoint: 'https://host:8767/relay/stt-a', provision: { ...bare, basePath: '/alt' } })
    expect(new URL(ws.url).pathname).toBe('/relay/stt-a/alt/v1/audio/stream')
  })
})
