import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createControlPlaneApp } from "../control-plane/src/app"
import { clearLocks } from "../shared/src/lifecycle"
import type { Registry } from "../../shared/types"

let tmpDir: string
let registryPath: string
let eventsPath: string

const REGISTRY: Registry = {
  version: 2,
  type: "control",
  hosts: [
    { id: "home-server", name: "home-server", hostname: "home-server.local", role: "control" },
  ],
  capabilities: [{ id: "tts", name: "TTS" }],
  services: [
    {
      id: "svc1",
      capabilityId: "tts",
      hostId: "home-server",
      permissions: { enabled: true },
      runner: { type: "systemd", unit: "svc1", unitFile: "ops/systemd/svc1.service" },
      network: { port: 3000, healthPath: "/api/health" },
    },
  ],
  shards: [],
}

async function makeApp(registry?: Registry) {
  return createControlPlaneApp({
    registryPath,
    registry,
    eventsPath,
    checkService: async () => {},
    runFn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    pollHealthFn: async () => true,
  })
}

beforeEach(async () => {
  clearLocks()
  tmpDir = await mkdtemp(join(tmpdir(), "registry-sharing-test-"))
  registryPath = join(tmpDir, "registry.json")
  eventsPath = join(tmpDir, "events.jsonl")
  await writeFile(registryPath, JSON.stringify(REGISTRY, null, 2))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

/**
 * The health loop and the API must read one registry object. `index.ts` owns it
 * and hands the same reference to both; the API's write paths mutate it in
 * place. If the app loaded its own copy instead, every write below would leave
 * the caller's object — the one the health loop iterates — stale until restart.
 */
describe("registry object sharing", () => {
  it("a disable through the API is visible on the caller's registry object", async () => {
    const registry: Registry = JSON.parse(JSON.stringify(REGISTRY))
    const app = await makeApp(registry)

    const res = await app.fetch(new Request("http://localhost/api/services/svc1/enabled", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    }))
    expect(res.status).toBe(200)

    // The health loop skips disabled services by reading this exact field.
    expect(registry.services[0].permissions.enabled).toBe(false)
  })

  it("a port change through the API is visible on the caller's registry object", async () => {
    const registry: Registry = JSON.parse(JSON.stringify(REGISTRY))
    const app = await makeApp(registry)

    const res = await app.fetch(new Request("http://localhost/api/services/svc1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ network: { port: 9999 } }),
    }))
    expect(res.status).toBe(200)

    // Health checks are addressed via the derived endpoint, so a stale copy
    // would keep polling the old port.
    expect(registry.services[0].network.port).toBe(9999)
    expect(registry.services[0].network.endpoint).toContain("9999")
  })

  it("still loads from disk when no registry is passed", async () => {
    const app = await makeApp()
    const res = await app.fetch(new Request("http://localhost/api/services"))
    expect(res.status).toBe(200)
    const services = await res.json() as Array<{ id: string }>
    expect(services.map(s => s.id)).toEqual(["svc1"])
  })
})
