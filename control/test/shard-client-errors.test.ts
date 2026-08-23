import { describe, it, expect } from "bun:test"
import { fetchShardServices } from "../control-plane/src/shard-client"

// A shard behind a TLS terminator answers a plaintext request with a bare 400.
// The status alone reads like the shard rejected the request; the body is what
// says the scheme is wrong. These tests pin that the body survives into the
// error, because the whole point is what shows up in the log.

async function withServer(
  handler: () => Response,
  run: (endpoint: string) => Promise<void>,
): Promise<void> {
  const server = Bun.serve({ port: 0, fetch: handler })
  try {
    await run(`http://localhost:${server.port}`)
  } finally {
    server.stop(true)
  }
}

describe("shard client: non-ok responses", () => {
  it("names the scheme mismatch when a TLS terminator answers a plaintext request", async () => {
    await withServer(
      () => new Response("Client sent an HTTP request to an HTTPS server.", { status: 400 }),
      async (endpoint) => {
        // Both halves matter: what is wrong, and the field that fixes it.
        await expect(fetchShardServices(endpoint)).rejects.toThrow(/answered TLS/i)
        await expect(fetchShardServices(endpoint)).rejects.toThrow(/"scheme": "https"/)
      },
    )
  })

  it("includes the endpoint, so a multi-shard log says which one", async () => {
    await withServer(
      () => new Response("Client sent an HTTP request to an HTTPS server.", { status: 400 }),
      async (endpoint) => {
        await expect(fetchShardServices(endpoint)).rejects.toThrow(endpoint)
      },
    )
  })

  it("carries the body through for an unrelated failure", async () => {
    await withServer(
      () => new Response("registry is locked", { status: 503 }),
      async (endpoint) => {
        await expect(fetchShardServices(endpoint)).rejects.toThrow(/503: registry is locked/)
      },
    )
  })

  it("does not offer the scheme hint for an unrelated failure", async () => {
    await withServer(
      () => new Response("registry is locked", { status: 503 }),
      async (endpoint) => {
        await expect(fetchShardServices(endpoint)).rejects.not.toThrow(/scheme/i)
      },
    )
  })

  it("still reports the status when the body is empty", async () => {
    await withServer(
      () => new Response(null, { status: 502 }),
      async (endpoint) => {
        await expect(fetchShardServices(endpoint)).rejects.toThrow(/Shard returned 502$/)
      },
    )
  })

  it("neutralises newlines so a body cannot forge a second log line", async () => {
    // The body is remote input printed straight into the poller's log. Left
    // alone, a shard could append convincing lines of its own.
    const forged = "denied\n[shard-poller] gpu-machine: 11 services, 0 events"
    await withServer(
      () => new Response(forged, { status: 400 }),
      async (endpoint) => {
        const err = (await fetchShardServices(endpoint).catch((e: Error) => e)) as Error
        expect(err.message).not.toContain("\n")
        expect(err.message).not.toContain("\r")
        // The text survives, only flattened — the diagnosis is still readable.
        expect(err.message).toContain("denied")
      },
    )
  })

  it("strips carriage returns and other control characters", async () => {
    await withServer(
      () => new Response("bad\r\nthing here\u001b[31m", { status: 500 }),
      async (endpoint) => {
        const err = (await fetchShardServices(endpoint).catch((e: Error) => e)) as Error
        expect(err.message).toMatch(/bad thing here/)
        expect(err.message).not.toMatch(/[\u0000-\u001f\u007f]/)
      },
    )
  })

  it("does not buffer a huge body into memory before truncating", async () => {
    // res.text() would pull the whole thing in first. The stream is read only
    // up to the snippet limit, so a hostile shard cannot balloon the heap on
    // every poll. 64MB is far past any legitimate error body.
    const huge = "x".repeat(64 * 1024 * 1024)
    await withServer(
      () => new Response(huge, { status: 500 }),
      async (endpoint) => {
        const err = (await fetchShardServices(endpoint).catch((e: Error) => e)) as Error
        expect(err).toBeInstanceOf(Error)
        expect(err.message.length).toBeLessThan(300)
      },
    )
  })

  it("truncates a long body rather than flooding the log", async () => {
    await withServer(
      () => new Response("x".repeat(5000), { status: 500 }),
      async (endpoint) => {
        const err = await fetchShardServices(endpoint).catch((e: Error) => e)
        expect(err).toBeInstanceOf(Error)
        expect((err as Error).message.length).toBeLessThan(300)
      },
    )
  })
})
