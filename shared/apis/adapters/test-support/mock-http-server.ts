// An HTTP server on a free port that records each request an adapter sends and
// answers with whatever the test chooses.

export interface RecordedRequest {
  method: string
  url: URL
  headers: Headers
  /** The body as text, for any content type but multipart. */
  text: string
  /** The parsed fields, for a multipart body; null otherwise. */
  form: FormData | null
  /** The body parsed as JSON; throws when it is not JSON. */
  json(): Record<string, unknown>
}

export interface MockHttpServer {
  /** http://127.0.0.1:<port>, the endpoint an adapter is given. */
  endpoint: string
  requests: RecordedRequest[]
  stop(): void
}

export function startMockHttpServer(
  answer: (request: RecordedRequest) => Response | Promise<Response> = () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
): MockHttpServer {
  const requests: RecordedRequest[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const type = req.headers.get('content-type') ?? ''
      const multipart = type.startsWith('multipart/form-data')
      const form = multipart ? await req.clone().formData() : null
      const text = multipart ? '' : await req.text()
      const recorded: RecordedRequest = {
        method: req.method,
        url: new URL(req.url),
        headers: req.headers,
        text,
        form,
        json: () => JSON.parse(text) as Record<string, unknown>,
      }
      requests.push(recorded)
      return answer(recorded)
    },
  })
  return { endpoint: `http://127.0.0.1:${server.port}`, requests, stop: () => { server.stop(true) } }
}
