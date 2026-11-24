// The openai.realtime adapter (docs/reference/design/service-apis.md, "Adapters"), for
// `transcribeStream`: how it opens a transcription session and how it turns Realtime's
// events into the guarantees of `transcribeStream`. The server here is a mock that
// answers the way the pinned references say: `session.updated` after a
// `session.update`, and an `input_audio_buffer.committed` carrying a new `item_id` after
// each commit.
//
// The call and callbacks are those of fluid.stt.stream's adapter (see its test).
// INVENTED: the model name goes in `session.audio.input.transcription.model`, where
// the transcription guide puts it. INVENTED: the caller's audio is already encoded as
// `format` says; the adapter accepts the engine's 16 kHz pcm16 frames and takes care of
// the 24 kHz the session asks for, so a pcm16 test pins only that audio is sent.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import * as realtime from './openai.realtime'
import { startMockSocketServer, type MockSocketServer } from './test-support/mock-socket-server'

const bare = { api: 'openai.realtime', only: ['mode:transcription'] }
const withOpus = { ...bare, extends: ['opus-input'] }

type Live = Record<string, (...args: unknown[]) => unknown>

let server: MockSocketServer
let live: Live | undefined

beforeEach(() => {
  let commits = 0
  server = startMockSocketServer(
    (message, send) => {
      if (message.type === 'session.update') send({ type: 'session.updated', session: {} })
      if (message.type === 'input_audio_buffer.commit') {
        commits += 1
        send({ type: 'input_audio_buffer.committed', item_id: `item_${commits}`, previous_item_id: commits > 1 ? `item_${commits - 1}` : null })
      }
    },
    (send) => { send({ type: 'session.created', session: {} }) },
  )
})

afterEach(() => {
  live?.close()
  live = undefined
  server.stop()
})

const callbacks = () => ({ onPartial: mock(), onFinal: mock(), onReady: mock(), onClosed: mock() })

async function open(over: Record<string, unknown> = {}) {
  const cb = callbacks()
  const call = { endpoint: server.endpoint, provision: bare, model: 'opaque-key', format: 'pcm16', ...over }
  live = realtime.transcribeStream(call as never, cb as never) as never as Live
  await server.waitFor(() => server.messages.some((m) => m.type === 'session.update'))
  return { live, cb }
}

const sessionUpdate = () => server.messages.find((m) => m.type === 'session.update') as { session: Record<string, any> }
const commits = () => server.messages.filter((m) => m.type === 'input_audio_buffer.commit')
const appends = () => server.messages.filter((m) => m.type === 'input_audio_buffer.append')
const frame = () => new Uint8Array(640).fill(7).buffer

const delta = (item_id: string, text: string) => ({ type: 'conversation.item.input_audio_transcription.delta', item_id, content_index: 0, delta: text })
const completed = (item_id: string, transcript: string) => ({ type: 'conversation.item.input_audio_transcription.completed', item_id, content_index: 0, transcript })

describe('opening the session', () => {
  it('[T3] opens the realtime route with intent=transcription under the endpoint\'s own path and the basePath', async () => {
    await open({ endpoint: `${server.endpoint}/relay/rt`, provision: { ...bare, basePath: '/alt' } })

    expect(server.requests[0].pathname).toBe('/relay/rt/alt/realtime')
    expect(server.requests[0].searchParams.get('intent')).toBe('transcription')
  })

  it('[T3] sends session.update for a transcription session with turn detection off, 24 kHz PCM input and the model named', async () => {
    await open()

    expect(sessionUpdate()).toMatchObject({
      type: 'session.update',
      session: { type: 'transcription', audio: { input: { format: { type: 'audio/pcm', rate: 24000 }, turn_detection: null } } },
    })
    expect(sessionUpdate().session.audio.input.transcription.model).toBe('opaque-key')
  })

  it('[T3] announces 48 kHz Opus input only with opus-input, and sends each packet base64-encoded as one append', async () => {
    const { live: session } = await open({ provision: withOpus, format: 'opus' })

    expect(sessionUpdate().session.audio.input.format).toEqual({ type: 'audio/opus', rate: 16000 })
    const packet = new Uint8Array([9, 8, 7, 6, 5])
    session.sendAudio(packet.buffer)
    await server.waitFor(() => appends().length === 1)
    expect(appends()[0].audio).toBe(Buffer.from(packet).toString('base64'))
  })

  // Spec section 8: the engine hands 16 kHz pcm16; this adapter resamples to the 24 kHz it declares.
  it('[T3] resamples 16 kHz pcm16 to 24 kHz before appending it', async () => {
    const { live: session } = await open()
    session.sendAudio(frame())

    await server.waitFor(() => appends().length > 0)
    const bytes = Buffer.from(appends()[0].audio as string, 'base64')
    expect(bytes.length).toBe(960)
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2)
    expect(samples[100]).toBe(0x0707)
    expect(samples[400]).toBe(0x0707)
  })
})

describe('ending a turn', () => {
  it('[T3] commits the audio sent since the last commit', async () => {
    const { live: session } = await open()
    session.sendAudio(frame())
    session.finalize()

    await server.waitFor(() => commits().length === 1)
  })

  it('[T3] answers a finalize with no audio since the last commit with an empty final and sends no commit', async () => {
    const { live: session, cb } = await open()

    session.finalize()
    expect(cb.onFinal).toHaveBeenCalledTimes(1)
    expect(cb.onFinal.mock.calls[0][0]).toBe('')

    // A turn with audio commits once. A finalize right after it, with nothing new
    // sent, commits nothing. Messages arrive in order, so once the last append is
    // in, any commit those finalizes made would be too.
    session.sendAudio(frame())
    session.finalize()
    session.finalize()
    session.sendAudio(frame())
    await server.waitFor(() => appends().length === 2)

    expect(commits()).toHaveLength(1)
  })

  it('[T3] holds an empty final behind the earlier turn still being transcribed, so finals keep the order of the finalizes', async () => {
    const { live: session, cb } = await open()
    session.sendAudio(frame())
    session.finalize()
    session.finalize()

    expect(cb.onFinal).not.toHaveBeenCalled()
    await server.waitFor(() => commits().length === 1)
    server.send(completed('item_1', 'first turn'))
    await server.waitFor(() => cb.onFinal.mock.calls.length === 2)

    expect(cb.onFinal.mock.calls.map((c) => c[0])).toEqual(['first turn', ''])
  })
})

describe('transcripts', () => {
  it('[T3] accumulates deltas into the text so far, per item_id, and settles on the completed transcript', async () => {
    const { live: session, cb } = await open()
    session.sendAudio(frame())
    session.finalize()
    session.sendAudio(frame())
    session.finalize()
    await server.waitFor(() => commits().length === 2)

    server.send(delta('item_1', 'a'))
    await server.waitFor(() => cb.onPartial.mock.calls.length === 1)
    server.send(delta('item_2', 'b'))
    await server.waitFor(() => cb.onPartial.mock.calls.length === 2)
    server.send(delta('item_1', 'c'))
    await server.waitFor(() => cb.onPartial.mock.calls.length === 3)

    const partials = cb.onPartial.mock.calls.map((c) => c[0])
    expect(partials).toContain('ac')
    expect(partials).not.toContain('abc')
    expect(partials).not.toContain('acb')
  })

  it('[T3] releases finals in commit order when the completions arrive out of order', async () => {
    const { live: session, cb } = await open()
    session.sendAudio(frame())
    session.finalize()
    session.sendAudio(frame())
    session.finalize()
    await server.waitFor(() => commits().length === 2)

    server.send(completed('item_2', 'second'))
    // A delta sent after it is handled after it: by then a final for the second turn would have fired.
    server.send(delta('item_1', 'x'))
    await server.waitFor(() => cb.onPartial.mock.calls.length > 0)
    expect(cb.onFinal).not.toHaveBeenCalled()

    server.send(completed('item_1', 'first'))
    await server.waitFor(() => cb.onFinal.mock.calls.length === 2)
    expect(cb.onFinal.mock.calls.map((c) => c[0])).toEqual(['first', 'second'])
  })
})
