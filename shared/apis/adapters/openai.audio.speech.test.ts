// The openai.audio.speech adapter (dev/specs/service-apis.md, section 8): what it
// sends for `synthesize`, read from the request a mock server received.
//
// INVENTED: the spec gives no call signature. An adapter module exports its
// operations by name. `synthesize` takes one object, `{ endpoint, provision, text,
// resolution, speed, progressive? }` (a resolution is section 11's), and resolves
// to an object whose `format` is the audio format it asked for.

import { afterEach, describe, expect, it } from 'bun:test'
import * as speech from './openai.audio.speech'
import { startMockHttpServer, type MockHttpServer } from './test-support/mock-http-server'

let server: MockHttpServer

afterEach(() => { server?.stop() })

function serve(): MockHttpServer {
  server = startMockHttpServer(() => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } }))
  return server
}

const bare = { api: 'openai.audio.speech' }

/** A synthesize call against the mock server, with the overrides applied. */
function call(over: Record<string, unknown> = {}): Parameters<typeof speech.synthesize>[0] {
  return {
    endpoint: server.endpoint,
    provision: bare,
    text: 'Hello there',
    resolution: { model: 'opaque-model', voice: { name: 'alloy' } },
    speed: 1.25,
    ...over,
  } as never
}

const sent = () => server.requests[0].json()

describe('the speech request body', () => {
  it('[T2] posts model, input, voice and speed from the call, and the format it will decode', async () => {
    serve()
    await speech.synthesize(call())

    expect(server.requests).toHaveLength(1)
    expect(server.requests[0].method).toBe('POST')
    expect(server.requests[0].headers.get('content-type')).toContain('application/json')
    expect(sent()).toMatchObject({ model: 'opaque-model', input: 'Hello there', voice: 'alloy', speed: 1.25, response_format: 'mp3' })
  })

  it('[T2] spreads the serving\'s requestParams first, so the adapter\'s own fields win and the rest pass through', async () => {
    serve()
    await speech.synthesize(call({
      provision: { ...bare, restricts: { response_format: ['wav'] } },
      resolution: { model: 'opaque-model', voice: { name: 'alloy' }, params: { response_format: 'mp3', speed: 9, input: 'overridden', streaming_interval: 4 } },
    }))

    expect(sent()).toMatchObject({ response_format: 'wav', speed: 1.25, input: 'Hello there', streaming_interval: 4 })
  })
})

describe('the audio format', () => {
  // The caller decodes mp3, aac and wav. The format is the first restricted value
  // it can decode, in the restriction's own order, or the first of mp3, aac, wav.
  it.each([
    { restricts: undefined, format: 'mp3' },
    { restricts: ['aac', 'wav', 'pcm'], format: 'aac' },
    { restricts: ['pcm', 'opus', 'wav'], format: 'wav' },
    { restricts: ['wav', 'mp3'], format: 'wav' },
  ])('[T2] response_format is always sent, and with restricts $restricts it is $format, which the adapter returns', async ({ restricts, format }) => {
    serve()
    const provision = restricts ? { ...bare, restricts: { response_format: restricts } } : bare
    const result = await speech.synthesize(call({ provision }))

    expect(sent().response_format).toBe(format)
    expect(result.format).toBe(format)
  })

  it('[T2] a restriction with no format the caller decodes is refused before any request, naming the formats the service accepts', async () => {
    serve()
    await expect(speech.synthesize(call({ provision: { ...bare, restricts: { response_format: ['pcm', 'opus'] } } }))).rejects.toThrow(/pcm.*opus|opus.*pcm/)
    expect(server.requests).toHaveLength(0)
  })
})

describe('a cloned voice', () => {
  const recording = { model: 'opaque-model', voice: { recording: '/refs/one.wav', transcript: 'the spoken words' } }

  it('[T2] goes as ref_audio and ref_text when the provision extends cloning-reference', async () => {
    serve()
    await speech.synthesize(call({ resolution: recording, provision: { ...bare, extends: ['cloning-reference'] } }))
    expect(sent()).toMatchObject({ ref_audio: '/refs/one.wav', ref_text: 'the spoken words' })

    await speech.synthesize(call({ resolution: { ...recording, voice: { recording: '/refs/one.wav' } }, provision: { ...bare, extends: ['cloning-reference'] } }))
    expect(server.requests[1].json().ref_text).toBeUndefined()
  })

  it('[T2] is refused before any request without the extension', async () => {
    serve()
    await expect(speech.synthesize(call({ resolution: recording }))).rejects.toBeDefined()
    expect(server.requests).toHaveLength(0)
  })
})

describe('progressive audio', () => {
  it.each([
    { extension: true, progressive: true, sends: true },
    { extension: true, progressive: false, sends: false },
    { extension: false, progressive: true, sends: false },
  ])('[T2] stream:true is sent: $sends, with stream-flag $extension and progressive audio wanted $progressive', async ({ extension, progressive, sends }) => {
    serve()
    const provision = extension ? { ...bare, extends: ['stream-flag'] } : bare
    await speech.synthesize(call({ provision, progressive }))

    expect(sent().stream === true).toBe(sends)
  })
})

describe('the path', () => {
  // Spec section 8, Paths: basePath replaces the /v1 of OpenAI's server address.
  it('[T2] is /v1/audio/speech under the endpoint\'s own path, with basePath replacing /v1', async () => {
    serve()
    await speech.synthesize(call({ endpoint: `${server.endpoint}/relay/speech/svc-1`, provision: { ...bare, basePath: '/alt' } }))
    await speech.synthesize(call({ endpoint: `${server.endpoint}/relay/speech/svc-1` }))

    expect(server.requests[0].url.pathname).toBe('/relay/speech/svc-1/alt/audio/speech')
    expect(server.requests[1].url.pathname).toBe('/relay/speech/svc-1/v1/audio/speech')
  })
})
