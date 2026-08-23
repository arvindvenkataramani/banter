import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadRegistry } from "../shared/src/registry"

// A service's endpoint is derived at load time from its host, port, and scheme.
//
// `scheme` is the only thing that decides the protocol, defaulting to http.
// Anything can be https — a reverse proxy, a self-signed cert, any TLS
// terminator — so nothing else gets to infer it. In particular `tailscaleServe`
// does not: it says "register with Tailscale Serve on start", which is a
// lifecycle concern, not a statement about the wire protocol. Letting it imply
// https would bake a Tailscale assumption into a platform that does not need
// one.
//
// `listenAddress` answers "which address", not "which scheme". The two were
// previously conflated: setting listenAddress was the only way to get http,
// which meant a service without it got an https endpoint nothing could answer.

let tmpDir: string
let registryPath: string

function makeRegistry(network: Record<string, unknown>) {
  return {
    version: 2,
    type: "control",
    hosts: [{ id: "h", name: "h", hostname: "box.example.com", role: "control" }],
    capabilities: [{ id: "tts", name: "TTS" }],
    services: [
      {
        id: "svc",
        name: "Service",
        capabilityId: "tts",
        hostId: "h",
        permissions: { enabled: true, protected: false },
        runner: { type: "external" },
        network: { healthPath: "/health", ...network },
      },
    ],
    shards: [],
  }
}

async function endpointFor(network: Record<string, unknown>): Promise<string | undefined> {
  await writeFile(registryPath, JSON.stringify(makeRegistry(network)))
  const registry = await loadRegistry(registryPath)
  return registry.services[0]!.network.endpoint
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "endpoint-derivation-"))
  registryPath = join(tmpDir, "registry.json")
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe("scheme defaults to http", () => {
  it("derives an http endpoint when no scheme is given", async () => {
    expect(await endpointFor({ port: 9004 })).toBe("http://box.example.com:9004")
  })

  it("uses listenAddress as the host when one is given", async () => {
    expect(await endpointFor({ port: 9005, listenAddress: "127.0.0.1" }))
      .toBe("http://127.0.0.1:9005")
  })
})

describe("tailscaleServe does not decide the scheme", () => {
  it("stays http when tailscaleServe is true but no scheme is set", async () => {
    // tailscaleServe is a lifecycle flag: register with Serve on start. Someone
    // running a tailnet sets scheme https once in the registry's defaults block.
    expect(await endpointFor({ port: 9001, tailscaleServe: true })).toBe("http://box.example.com:9001")
  })

  it("is https when scheme says so, regardless of tailscaleServe", async () => {
    expect(await endpointFor({ port: 9002, tailscaleServe: false, scheme: "https" }))
      .toBe("https://box.example.com:9002")
  })
})

describe("explicit scheme", () => {
  it("honours https for a service behind any TLS terminator", async () => {
    // A reverse proxy, a self-signed cert, an ingress — none of it is Tailscale.
    expect(await endpointFor({ port: 9006, scheme: "https" }))
      .toBe("https://box.example.com:9006")
  })

  it("honours http on a tailscale-exposed service", async () => {
    expect(await endpointFor({ port: 9007, tailscaleServe: true, scheme: "http" }))
      .toBe("http://box.example.com:9007")
  })

  it("rejects a scheme that is neither http nor https", async () => {
    await writeFile(registryPath, JSON.stringify(makeRegistry({ port: 9008, scheme: "ftp" })))
    await expect(loadRegistry(registryPath)).rejects.toThrow(/scheme/i)
  })
})

describe("managed runners", () => {
  it("derives no endpoint even when a port is declared", async () => {
    // A managed runner has no HTTP surface — health comes from its healthCmd.
    // Synthesizing an endpoint would wrongly imply one exists.
    await writeFile(registryPath, JSON.stringify({
      version: 2,
      type: "control",
      hosts: [{ id: "h", name: "h", hostname: "box.example.com", role: "control" }],
      capabilities: [{ id: "tts", name: "TTS" }],
      services: [{
        id: "svc", name: "Service", capabilityId: "tts", hostId: "h",
        permissions: { enabled: true, protected: false },
        runner: { type: "managed", startCmd: ["true"], stopCmd: ["true"], healthCmd: ["true"] },
        network: { port: 9009, healthPath: "/health", tailscaleServe: true },
      }],
      shards: [],
    }))
    const registry = await loadRegistry(registryPath)
    expect(registry.services[0]!.network.endpoint).toBeUndefined()
  })
})

describe("shard endpoints", () => {
  async function shardEndpoint(hostname: string, shard: Record<string, unknown> = {}) {
    await writeFile(registryPath, JSON.stringify({
      version: 2,
      type: "control",
      hosts: [
        { id: "c", name: "c", hostname: "control.example.com", role: "control" },
        { id: "w", name: "w", hostname, role: "worker" },
      ],
      capabilities: [],
      services: [],
      shards: [{ hostId: "w", port: 4200, ...shard }],
    }))
    const registry = await loadRegistry(registryPath)
    return registry.shards![0]!.endpoint
  }

  it("uses http for a shard reached over a plain network", async () => {
    // A shard on a LAN is the ordinary case for anyone not running a tailnet.
    // Forcing https here made Tailscale mandatory for the two-machine setup.
    expect(await shardEndpoint("gpu.local")).toBe("http://gpu.local:4200")
  })

  it("uses http for a shard addressed by IP", async () => {
    expect(await shardEndpoint("192.168.1.50")).toBe("http://192.168.1.50:4200")
  })

  it("uses http for a shard on localhost", async () => {
    expect(await shardEndpoint("localhost")).toBe("http://localhost:4200")
  })

  it("stays http when the shard declares tailscaleServe but no scheme", async () => {
    expect(await shardEndpoint("worker.ts.net", { tailscaleServe: true }))
      .toBe("http://worker.ts.net:4200")
  })

  it("honours an explicit scheme on a shard", async () => {
    expect(await shardEndpoint("gpu.local", { scheme: "https" }))
      .toBe("https://gpu.local:4200")
  })
})
