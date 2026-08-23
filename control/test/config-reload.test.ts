import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createControlPlaneApp } from "../control-plane/src/app"
import { clearLocks } from "../shared/src/lifecycle"
import type { Registry } from "../../shared/types"
import type { PlatformConfig } from "../control-plane/src/gateway-config"

let tmpDir: string
let registryPath: string
let eventsPath: string
let configPath: string

const REGISTRY: Registry = {
  version: 2,
  type: "control",
  hosts: [
    { id: "home-server", name: "home-server", hostname: "home-server.local", role: "control" },
  ],
  capabilities: [],
  services: [],
  shards: [],
}

const BASE_CONFIG: PlatformConfig = {
  version: 1,
  voice: {
    enabled: true,
    tts: {
      providers: [],
      selection: { serviceId: "kokoro", model: "default", voice: "Original" },
    },
  },
}

async function makeApp(cfg: PlatformConfig = BASE_CONFIG) {
  const cloned: PlatformConfig = JSON.parse(JSON.stringify(cfg))
  await writeFile(configPath, JSON.stringify(cloned, null, 2))
  return createControlPlaneApp({
    registryPath,
    eventsPath,
    checkService: async () => {},
    runFn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    pollHealthFn: async () => true,
    config: cloned,
    configPath,
  })
}

beforeEach(async () => {
  clearLocks()
  tmpDir = await mkdtemp(join(tmpdir(), "config-reload-test-"))
  registryPath = join(tmpDir, "registry.json")
  eventsPath = join(tmpDir, "events.jsonl")
  configPath = join(tmpDir, "config.json")
  await writeFile(registryPath, JSON.stringify(REGISTRY, null, 2))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe("POST /api/config/reload", () => {
  it("re-reads config from disk and propagates changes to /api/voice", async () => {
    const app = await makeApp()

    // Sanity: initial values
    let res = await app.fetch(new Request("http://localhost/api/voice"))
    let body = await res.json()
    expect(body.tts.selection.voice).toBe("Original")

    // Mutate the config file on disk
    const updated: PlatformConfig = {
      version: 2,
      voice: {
        enabled: true,
        tts: {
          providers: [],
          selection: { serviceId: "kokoro", model: "default", voice: "Updated" },
        },
      },
    }
    await writeFile(configPath, JSON.stringify(updated, null, 2))

    // Reload
    res = await app.fetch(new Request("http://localhost/api/config/reload", { method: "POST" }))
    expect(res.status).toBe(200)
    body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.version).toBe(2)

    // /api/voice reflects the new values immediately
    res = await app.fetch(new Request("http://localhost/api/voice"))
    body = await res.json()
    expect(body.tts.selection.voice).toBe("Updated")
  })

  it("returns 500 when config file is malformed", async () => {
    const app = await makeApp()
    await writeFile(configPath, "{ not valid json")
    const res = await app.fetch(new Request("http://localhost/api/config/reload", { method: "POST" }))
    expect(res.status).toBe(500)
  })
})
