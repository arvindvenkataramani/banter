// What the adapters send and accept when a provision omits parts (docs/reference/design/service-apis.md, "Adapters"):
// optional parameters it omits are not sent, and an omitted value or parameter accepts no values.

import { afterEach, describe, expect, it, jest, mock } from 'bun:test'
import { partHolds } from '../parts'
import * as speech from './openai.audio.speech'
import * as transcriptions from './openai.audio.transcriptions'
import * as stream from './fluid.stt.stream'
import * as listen from './deepgram.listen.live'
import { FakeWebSocket, installFakeWebSocket } from './test-support/fake-websocket'
import { startMockHttpServer, type MockHttpServer } from './test-support/mock-http-server'

let server: MockHttpServer | undefined
afterEach(() => { server?.stop(); server = undefined })

describe('values an omitted part removes', () => {
  it('[P1] an omitted parameter holds none of its values, and an omitted value is just that one', () => {
    const provision = { api: 'openai.audio.speech', omits: ['parameter:speed', 'value:response_format=mp3'] } as never
    expect(partHolds(provision, 'value:speed=1')).toBe(false)
    expect(partHolds(provision, 'value:response_format=mp3')).toBe(false)
    expect(partHolds(provision, 'value:response_format=aac')).toBe(true)
  })
})

describe('the speech adapter', () => {
  const call = (provision: unknown) => ({ endpoint: server!.endpoint, provision, text: 'hi', resolution: { model: 'm', voice: { name: 'v' } }, speed: 1.5 }) as never

  it('[P1] never picks a format its provision omits', async () => {
    server = startMockHttpServer(() => new Response(new Uint8Array([1])))
    const result = await speech.synthesize(call({ api: 'openai.audio.speech', omits: ['value:response_format=mp3'] }))
    expect(result.format).toBe('aac')
  })

  it('[P1] sends neither speed nor voice to a provision that omits them', async () => {
    server = startMockHttpServer(() => new Response(new Uint8Array([1])))
    await speech.synthesize(call({ api: 'openai.audio.speech', omits: ['parameter:speed', 'parameter:voice'] }))
    const body = server.requests[0].json()
    expect(body).not.toHaveProperty('speed')
    expect(body).not.toHaveProperty('voice')
  })
})

describe('the transcription adapter', () => {
  const call = (provision: unknown) => ({ endpoint: server!.endpoint, provision, audio: new Uint8Array([1]).buffer }) as never

  it('[P1] always sends the first of json and verbose_json its provision accepts', async () => {
    server = startMockHttpServer(() => Response.json({ text: 'ok' }))
    await transcriptions.transcribe(call({ api: 'openai.audio.transcriptions' }))
    await transcriptions.transcribe(call({ api: 'openai.audio.transcriptions', restricts: { response_format: ['text', 'verbose_json'] } }))
    expect(server.requests.map((r) => r.form?.get('response_format'))).toEqual(['json', 'verbose_json'])
  })

  it('[P1] refuses before any request when it accepts neither', async () => {
    server = startMockHttpServer()
    await expect(transcriptions.transcribe(call({ api: 'openai.audio.transcriptions', restricts: { response_format: ['text'] } }))).rejects.toThrow(/json/)
    expect(server.requests).toHaveLength(0)
  })
})

describe('the stream adapters', () => {
  it('[P1] send chunkMs and model only to a provision that does not omit them', () => {
    const restore = installFakeWebSocket()
    try {
      const cb = { onPartial: mock(), onFinal: mock(), onReady: mock(), onClosed: mock() }
      stream.transcribeStream({ endpoint: 'https://h:1', provision: { api: 'fluid.stt.stream', omits: ['parameter:chunkMs'] }, model: 'm', format: 'pcm16', chunkMs: 560 } as never, cb as never)
      expect(new URL(FakeWebSocket.instances.at(-1)!.url).searchParams.has('chunkMs')).toBe(false)

      listen.transcribeStream({ endpoint: 'https://h:1', provision: { api: 'deepgram.listen.live', omits: ['parameter:model'] }, model: 'm', format: 'pcm16' } as never, cb as never)
      expect(new URL(FakeWebSocket.instances.at(-1)!.url).searchParams.has('model')).toBe(false)
    } finally {
      jest.useRealTimers()
      restore()
    }
  })
})
