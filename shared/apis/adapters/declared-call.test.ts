// The declared-call adapter (dev/specs/service-apis.md, section 8): the generic
// `loadModel` and `unloadModel` for a service that declares its calls under
// `models.load` and `models.unload`.
//
// INVENTED: `loadModel` and `unloadModel` take `{ endpoint, call, model }`, where `call`
// is the DeclaredCall. The module has no provision, since a declared call is not a
// provision.

import { afterEach, describe, expect, it } from 'bun:test'
import * as declared from './declared-call'
import { startMockHttpServer, type MockHttpServer } from './test-support/mock-http-server'

let server: MockHttpServer

afterEach(() => { server?.stop() })

describe('a declared call', () => {
  it('[T2] substitutes {model} with the name given, in the path, the query and the body, and prefixes the endpoint\'s path', async () => {
    server = startMockHttpServer()
    const call = {
      method: 'PUT',
      path: '/admin/{model}/warm',
      query: { name: '{model}', mode: 'fixed' },
      body: { model: '{model}', note: 'kept' },
    }
    await declared.loadModel({ endpoint: `${server.endpoint}/relay/svc-4`, call, model: 'key-1' } as never)

    const request = server.requests[0]
    expect(request.method).toBe('PUT')
    expect(request.url.pathname).toBe('/relay/svc-4/admin/key-1/warm')
    expect(request.url.searchParams.get('name')).toBe('key-1')
    expect(request.url.searchParams.get('mode')).toBe('fixed')
    expect(request.json()).toEqual({ model: 'key-1', note: 'kept' })
  })

  it('[T2] sends the unload call it is given, with no body when it declares none', async () => {
    server = startMockHttpServer()
    await declared.unloadModel({ endpoint: server.endpoint, call: { method: 'DELETE', path: '/admin/models', query: { name: '{model}' } }, model: 'org/key 2' } as never)

    const request = server.requests[0]
    expect(request.method).toBe('DELETE')
    expect(request.url.pathname).toBe('/admin/models')
    expect(request.url.searchParams.get('name')).toBe('org/key 2')
    expect(request.text).toBe('')
  })

  // Spec section 8, Failures.
  it('[T2] refuses with the server\'s own text on a failure status, JSON or not', async () => {
    server = startMockHttpServer(() => Response.json({ error: 'no such model' }, { status: 400 }))
    const call = { method: 'POST', path: '/admin/warm', query: { name: '{model}' } }
    await expect(declared.loadModel({ endpoint: server.endpoint, call, model: 'key-1' } as never)).rejects.toThrow('no such model')
    server.stop()

    server = startMockHttpServer(() => new Response('out of memory', { status: 503 }))
    await expect(declared.loadModel({ endpoint: server.endpoint, call, model: 'key-1' } as never)).rejects.toThrow('out of memory')
  })
})
