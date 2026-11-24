// The openai.audio.transcriptions adapter (dev/specs/service-apis.md, section 8).
//
// INVENTED: `transcribe` takes `{ endpoint, provision, audio, model? }`, where `audio`
// is the recording's bytes, and resolves to the transcript text.

import { afterEach, describe, expect, it } from 'bun:test'
import * as transcriptions from './openai.audio.transcriptions'
import { startMockHttpServer, type MockHttpServer } from './test-support/mock-http-server'

let server: MockHttpServer

afterEach(() => { server?.stop() })

function serve(): MockHttpServer {
  server = startMockHttpServer(() => Response.json({ text: 'what was said' }))
  return server
}

const bare = { api: 'openai.audio.transcriptions' }
const recording = (): ArrayBuffer => new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]).buffer as ArrayBuffer

function call(over: Record<string, unknown> = {}): Parameters<typeof transcriptions.transcribe>[0] {
  return { endpoint: server.endpoint, provision: bare, audio: recording(), ...over } as never
}

describe('a transcription request', () => {
  it('[T2] is a multipart post of the recording as `file`, and resolves to the response\'s text', async () => {
    serve()
    const text = await transcriptions.transcribe(call())

    expect(text).toBe('what was said')
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0].method).toBe('POST')
    const file = server.requests[0].form?.get('file')
    expect(file).toBeInstanceOf(Blob)
    expect([...new Uint8Array(await (file as Blob).arrayBuffer())]).toEqual([82, 73, 70, 70, 1, 2, 3, 4])
  })

  it('[T2] carries `model` only when the caller names one', async () => {
    serve()
    await transcriptions.transcribe(call())
    await transcriptions.transcribe(call({ model: 'opaque-key' }))

    expect(server.requests[0].form?.has('model')).toBe(false)
    expect(server.requests[1].form?.get('model')).toBe('opaque-key')
  })

  it('[T2] is /v1/audio/transcriptions under the endpoint\'s own path, with basePath replacing /v1', async () => {
    serve()
    await transcriptions.transcribe(call({ endpoint: `${server.endpoint}/relay/speech/svc-2`, provision: { ...bare, basePath: '/alt' } }))
    await transcriptions.transcribe(call({ endpoint: `${server.endpoint}/relay/speech/svc-2` }))

    expect(server.requests[0].url.pathname).toBe('/relay/speech/svc-2/alt/audio/transcriptions')
    expect(server.requests[1].url.pathname).toBe('/relay/speech/svc-2/v1/audio/transcriptions')
  })
})
