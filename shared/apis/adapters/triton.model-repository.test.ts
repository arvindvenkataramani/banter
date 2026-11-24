// The triton.model-repository adapter (dev/specs/service-apis.md, section 8): the
// requests `loadModel` and `unloadModel` send, and how a failure reads.
//
// INVENTED: `loadModel` takes `{ endpoint, provision, model, mode?, variant? }` and
// `unloadModel` takes `{ endpoint, provision, model }`. Both resolve with nothing on a
// 200 and reject with an Error on anything else. The model is an opaque name.

import { afterEach, describe, expect, it } from 'bun:test'
import * as triton from './triton.model-repository'
import { startMockHttpServer, type MockHttpServer } from './test-support/mock-http-server'

let server: MockHttpServer

afterEach(() => { server?.stop() })

const slot = { api: 'triton.model-repository', extends: ['resident-slot'] }
const plain = { api: 'triton.model-repository' }

function serve(answer?: () => Response): MockHttpServer {
  server = startMockHttpServer(answer ?? (() => Response.json({})))
  return server
}

const base = () => ({ endpoint: server.endpoint, model: 'opaque-name' })

describe('loading', () => {
  it('[T2] posts to the model\'s load route under the endpoint\'s path and the basePath', async () => {
    serve()
    await triton.loadModel({ endpoint: `${server.endpoint}/relay/svc-3`, provision: { ...slot, basePath: '/alt' }, model: 'opaque-name' } as never)

    expect(server.requests[0].method).toBe('POST')
    expect(server.requests[0].url.pathname).toBe('/relay/svc-3/alt/v2/repository/models/opaque-name/load')
  })

  it('[T2] sends mode and variant as parameters when given, with resident-slot', async () => {
    serve()
    await triton.loadModel({ ...base(), provision: slot, mode: 'streaming', variant: '560ms' } as never)
    await triton.loadModel({ ...base(), provision: slot } as never)

    expect(server.requests[0].json()).toEqual({ parameters: { mode: 'streaming', variant: '560ms' } })
    expect(Object.keys((server.requests[1].json().parameters ?? {}) as object)).toEqual([])
  })

  it('[T2] sends neither parameter without resident-slot, whatever the caller gives', async () => {
    serve()
    await triton.loadModel({ ...base(), provision: plain, mode: 'streaming', variant: '560ms' } as never)

    const parameters = (server.requests[0].json().parameters ?? {}) as Record<string, unknown>
    expect(parameters.mode).toBeUndefined()
    expect(parameters.variant).toBeUndefined()
  })

  it('[T2] refuses with the server\'s own error text on a failure status', async () => {
    serve(() => Response.json({ error: 'a session holds the server' }, { status: 409 }))

    await expect(triton.loadModel({ ...base(), provision: slot } as never)).rejects.toThrow('a session holds the server')
  })
})

describe('unloading', () => {
  it('[T2] posts to the model\'s unload route, and refuses with the server\'s error text on a failure status', async () => {
    serve()
    await triton.unloadModel({ ...base(), provision: slot } as never)
    expect(server.requests[0].method).toBe('POST')
    expect(server.requests[0].url.pathname).toBe('/v2/repository/models/opaque-name/unload')
    server.stop()

    serve(() => Response.json({ error: 'the model is in use' }, { status: 409 }))
    await expect(triton.unloadModel({ ...base(), provision: slot } as never)).rejects.toThrow('the model is in use')
  })
})
