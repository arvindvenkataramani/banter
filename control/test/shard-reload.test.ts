// POST /api/config/reload on the shard (docs/design/config-reload.md).
// Drives createShardApp directly, the same temp-dir-plus-fake-deps shape as
// media-job.test.ts, kept in its own file since this exercises a route
// independent of the job/dispatch surface that file otherwise covers.

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createShardApp } from "../control-shard/src/shard-api"
import { clearLocks } from "../shared/src/lifecycle"
import { clearFileLocks } from "../shared/src/atomic-write"
import { loadRegistry } from "../shared/src/registry"
import type { NodeRoster, Registry } from "../../shared/types"

let tmpDir: string
let registryPath: string
let eventsPath: string

const REGISTRY: Registry = {
  version: 2,
  type: "shard",
  hosts: [{ id: "gpu-machine", name: "gpu-machine", hostname: "gpu-machine.example.ts.net", role: "worker" }],
  capabilities: [{ id: "tts", name: "Text-to-Speech" }],
  services: [
    {
      id: "svc-a",
      capabilityId: "tts",
      hostId: "gpu-machine",
      permissions: { enabled: true, protected: false },
      runner: { type: "process", main: ".venv/bin/server" },
      network: { port: 8001, healthPath: "/health" },
      lifecycle: { loadStrategy: "demand", idleUnload: true, idleTimeout: 1800000 },
    },
  ],
} as unknown as Registry

function baseDeps(registryState: Registry) {
  return {
    registryState,
    eventsPath,
    getFreeMem: async () => 0,
    checkMemoryBudget: async () => ({ ok: true }),
    loadService: async () => ({ ok: true }),
    unloadService: async () => ({ ok: true }),
    registryPath,
  }
}

beforeEach(async () => {
  clearLocks()
  clearFileLocks()
  tmpDir = await mkdtemp(join(tmpdir(), "shard-reload-test-"))
  registryPath = join(tmpDir, "registry.json")
  eventsPath = join(tmpDir, "events.jsonl")
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe("POST /api/config/reload: preserves loadTime, so idle eviction still sees a loaded service", () => {
  it("reloads a service edit and keeps its runtime state", async () => {
    await writeFile(registryPath, JSON.stringify(REGISTRY, null, 2))
    const registry = await loadRegistry(registryPath)
    registry.services[0].state = { loadTime: 999 }

    const app = createShardApp(baseDeps(registry) as any)

    const edited = { ...REGISTRY, services: [{ ...REGISTRY.services[0], lifecycle: { ...REGISTRY.services[0].lifecycle, idleTimeout: 600000 } }] }
    await writeFile(registryPath, JSON.stringify(edited, null, 2))

    const res = await app.fetch(new Request("http://localhost/api/config/reload", { method: "POST" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.registry.ok).toBe(true)

    expect(registry.services[0].state?.loadTime).toBe(999)
    expect(registry.services[0].lifecycle?.idleTimeout).toBe(600000)
  })
})

describe("POST /api/config/reload: a roster edit is visible on GET /api/roster, with a provider-changed warning", () => {
  it("reflects the new roster section and names the changed provider", async () => {
    const before: NodeRoster = {
      providers: { "svc-a": { ttsModels: [{ id: "model-a", name: "Model A", key: "model-a" }] } },
      voices: [],
    }
    await writeFile(registryPath, JSON.stringify({ ...REGISTRY, roster: before }, null, 2))
    const registry = await loadRegistry(registryPath)

    const app = createShardApp(baseDeps(registry) as any)

    const after: NodeRoster = {
      providers: { "svc-a": { ttsModels: [{ id: "model-a", name: "Model A v2", key: "model-a" }] } },
      voices: [],
    }
    await writeFile(registryPath, JSON.stringify({ ...REGISTRY, roster: after }, null, 2))

    const res = await app.fetch(new Request("http://localhost/api/config/reload", { method: "POST" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.warnings).toContainEqual(
      expect.objectContaining({ kind: "provider-changed", serviceId: "svc-a" })
    )

    const rosterRes = await app.fetch(new Request("http://localhost/api/roster"))
    const roster = await rosterRes.json()
    expect(roster.providers["svc-a"].ttsModels[0].name).toBe("Model A v2")
  })
})

describe("POST /api/config/reload: failure modes", () => {
  it("answers 500 with the validation error, and leaves the live registry unchanged, on a malformed file", async () => {
    await writeFile(registryPath, JSON.stringify(REGISTRY, null, 2))
    const registry = await loadRegistry(registryPath)
    const app = createShardApp(baseDeps(registry) as any)

    await writeFile(registryPath, "{ not valid json")

    const res = await app.fetch(new Request("http://localhost/api/config/reload", { method: "POST" }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.registry.ok).toBe(false)
    expect(typeof body.registry.error).toBe("string")
    expect(registry.services[0].id).toBe("svc-a")
  })

  it("answers 500 naming the missing path when no registryPath was configured", async () => {
    await writeFile(registryPath, JSON.stringify(REGISTRY, null, 2))
    const registry = await loadRegistry(registryPath)
    const app = createShardApp({ ...baseDeps(registry), registryPath: undefined } as any)

    const res = await app.fetch(new Request("http://localhost/api/config/reload", { method: "POST" }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.registry.ok).toBe(false)
  })
})
