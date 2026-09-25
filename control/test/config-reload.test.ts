import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createControlPlaneApp } from "../control-plane/src/app"
import { clearLocks } from "../shared/src/lifecycle"
import { clearFileLocks } from "../shared/src/atomic-write"
import type { NodeRoster, Registry } from "../../shared/types"
import type { PlatformConfig } from "../control-plane/src/gateway-config"

let tmpDir: string
let registryPath: string
let eventsPath: string
let configPath: string

function makeRegistry(opts?: { roster?: NodeRoster; shards?: Registry["shards"] }): Registry {
  return {
    version: 2,
    type: "control",
    hosts: [
      { id: "home-server", name: "home-server", hostname: "home-server.local", role: "control" },
      { id: "gpu-machine", name: "gpu-machine", hostname: "127.0.0.1", role: "worker" },
    ],
    capabilities: [{ id: "tts", name: "Text-to-Speech" }],
    services: [
      {
        id: "tts-a", name: "TTS A", capabilityId: "tts", hostId: "home-server",
        permissions: { enabled: true },
        runner: { type: "external" },
        network: { port: 8001, healthPath: "/health" },
      },
    ] as Registry["services"],
    shards: opts?.shards ?? [],
    ...(opts?.roster !== undefined && { roster: opts.roster }),
  }
}

const BASE_CONFIG: PlatformConfig = {
  version: 1,
  voice: {
    enabled: true,
    tts: {
      selection: { serviceId: "kokoro", model: "default", voice: "Original" },
    },
  },
}

async function makeApp(cfg: PlatformConfig = BASE_CONFIG, registry: Registry = makeRegistry()) {
  const cloned: PlatformConfig = JSON.parse(JSON.stringify(cfg))
  await writeFile(configPath, JSON.stringify(cloned, null, 2))
  await writeFile(registryPath, JSON.stringify(registry, null, 2))
  return createControlPlaneApp({
    registryPath,
    eventsPath,
    checkService: async () => {},
    runFn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    pollHealthFn: async () => true,
    config: cloned,
    configPath,
  } as any)
}

beforeEach(async () => {
  clearLocks()
  clearFileLocks()
  tmpDir = await mkdtemp(join(tmpdir(), "config-reload-test-"))
  registryPath = join(tmpDir, "registry.json")
  eventsPath = join(tmpDir, "events.jsonl")
  configPath = join(tmpDir, "config.json")
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe("POST /api/config/reload: config", () => {
  it("re-reads config from disk and propagates changes to /api/voice", async () => {
    const app = await makeApp()

    let res = await app.fetch(new Request("http://localhost/api/voice"))
    let body = await res.json()
    expect(body.tts.selection.voice).toBe("Original")

    const updated: PlatformConfig = {
      version: 2,
      voice: {
        enabled: true,
        tts: {
          selection: { serviceId: "kokoro", model: "default", voice: "Updated" },
        },
      },
    }
    await writeFile(configPath, JSON.stringify(updated, null, 2))

    res = await app.fetch(new Request("http://localhost/api/config/reload", { method: "POST" }))
    expect(res.status).toBe(200)
    body = await res.json()
    expect(body.config.ok).toBe(true)
    expect(body.registry.ok).toBe(true)
    expect(body.shards).toEqual({})
    expect(body.warnings).toEqual([])

    res = await app.fetch(new Request("http://localhost/api/voice"))
    body = await res.json()
    expect(body.tts.selection.voice).toBe("Updated")
  })

  it("answers 500 with config.ok: false when the config file is malformed, while registry still reloads", async () => {
    const app = await makeApp()
    await writeFile(configPath, "{ not valid json")

    const res = await app.fetch(new Request("http://localhost/api/config/reload", { method: "POST" }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.config.ok).toBe(false)
    expect(body.registry.ok).toBe(true)
  })
})

describe("POST /api/config/reload: registry", () => {
  it("editing a service in the file and reloading shows the change in GET /api/services", async () => {
    const registry = makeRegistry()
    const app = await makeApp(BASE_CONFIG, registry)

    const edited = {
      ...registry,
      services: [{ ...registry.services[0], notes: "reloaded" }],
    }
    await writeFile(registryPath, JSON.stringify(edited, null, 2))

    const res = await app.fetch(new Request("http://localhost/api/config/reload", { method: "POST" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.registry.ok).toBe(true)

    const servicesRes = await app.fetch(new Request("http://localhost/api/services"))
    const services = await servicesRes.json()
    expect(services.find((s: any) => s.id === "tts-a").notes).toBe("reloaded")
  })

  it("editing a roster section and reloading shows the change in GET /api/voice, with a warning naming that provider", async () => {
    const before: NodeRoster = {
      providers: { "tts-a": { ttsModels: [{ id: "model-a", name: "Model A", key: "model-a" }] } },
      voices: [],
    }
    const registry = makeRegistry({ roster: before })
    const app = await makeApp({ ...BASE_CONFIG, voice: { enabled: true, tts: {} } } as PlatformConfig, registry)

    const after: NodeRoster = {
      providers: { "tts-a": { ttsModels: [{ id: "model-a", name: "Model A v2", key: "model-a" }] } },
      voices: [],
    }
    await writeFile(registryPath, JSON.stringify({ ...registry, roster: after }, null, 2))

    const res = await app.fetch(new Request("http://localhost/api/config/reload", { method: "POST" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.warnings).toContainEqual(
      expect.objectContaining({ kind: "provider-changed", serviceId: "tts-a" })
    )

    const voiceRes = await app.fetch(new Request("http://localhost/api/voice"))
    const voice = await voiceRes.json()
    const provider = voice.tts.providers.find((p: any) => p.serviceId === "tts-a")
    expect(provider.models[0].name).toBe("Model A v2")
  })

  it("answers with the error for registry while config still reloads, on a malformed registry", async () => {
    const app = await makeApp()
    await writeFile(registryPath, "{ not valid json")

    const res = await app.fetch(new Request("http://localhost/api/config/reload", { method: "POST" }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.config.ok).toBe(true)
    expect(body.registry.ok).toBe(false)
    expect(typeof body.registry.error).toBe("string")
  })
})

describe("POST /api/config/reload: shards", () => {
  it("is an error for a shard that cannot be reached, and the rest succeed", async () => {
    const registry = makeRegistry({ shards: [{ hostId: "gpu-machine", port: 1, scheme: "http" }] })
    const app = await makeApp(BASE_CONFIG, registry)

    const res = await app.fetch(new Request("http://localhost/api/config/reload", { method: "POST" }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.config.ok).toBe(true)
    expect(body.registry.ok).toBe(true)
    expect(body.shards["gpu-machine"].ok).toBe(false)
    expect(typeof body.shards["gpu-machine"].error).toBe("string")
  })
})
