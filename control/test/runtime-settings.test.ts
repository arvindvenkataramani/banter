import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveRuntimeSettings } from "../control-plane/src/runtime-settings"
import type { Registry } from "../../shared/types"
import type { PlatformConfig } from "../control-plane/src/gateway-config"

// Runtime settings are the values the control plane needs at startup that are
// not service definitions: the port it listens on, the address it binds, where
// it writes its event log, and how often its periodic loops run.
//
// The contract from the design doc:
//   - the port comes from the registry's own control-plane service entry
//   - everything else comes from the config file
//   - every value keeps an environment override
//   - a normal run, pointed at valid files, needs no environment variables

let tmpDir: string

function makeRegistry(overrides: Partial<Registry> = {}): Registry {
  return {
    version: 2,
    type: "control",
    hosts: [{ id: "host-a", name: "host-a", hostname: "host-a.example.com", role: "control" }],
    capabilities: [{ id: "control", name: "Control Plane" }],
    services: [
      {
        id: "control",
        name: "Control Plane",
        capabilityId: "control",
        hostId: "host-a",
        permissions: { enabled: true, protected: true },
        runner: { type: "external" },
        network: { port: 5107, healthPath: "/api/health" },
        lifecycle: { loadStrategy: "startup", idleUnload: false },
      },
    ],
    shards: [],
    ...overrides,
  } as Registry
}

function makeConfig(runtime?: Record<string, unknown>): PlatformConfig {
  return { version: 2, ...(runtime ? { runtime } : {}) } as PlatformConfig
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "runtime-settings-"))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe("port resolution", () => {
  it("takes the listening port from the registry's control service entry", () => {
    const s = resolveRuntimeSettings(makeRegistry(), makeConfig(), {})
    expect(s.port).toBe(5107)
  })

  it("uses a different registry port when the registry declares one", () => {
    const reg = makeRegistry()
    reg.services[0]!.network.port = 6200
    const s = resolveRuntimeSettings(reg, makeConfig(), {})
    expect(s.port).toBe(6200)
  })

  it("prefers the BANTER_CONTROL_PORT environment override over the registry port", () => {
    const s = resolveRuntimeSettings(makeRegistry(), makeConfig(), { BANTER_CONTROL_PORT: "7300" })
    expect(s.port).toBe(7300)
  })

  it("throws a message naming the registry when no control service entry exists", () => {
    const reg = makeRegistry({ services: [] })
    expect(() => resolveRuntimeSettings(reg, makeConfig(), {})).toThrow(/control/i)
  })

  it("throws rather than silently defaulting when the control entry declares no port", () => {
    const reg = makeRegistry()
    delete (reg.services[0]!.network as Record<string, unknown>).port
    expect(() => resolveRuntimeSettings(reg, makeConfig(), {})).toThrow()
  })

  it("rejects a non-numeric BANTER_CONTROL_PORT override instead of binding port zero", () => {
    expect(() => resolveRuntimeSettings(makeRegistry(), makeConfig(), { BANTER_CONTROL_PORT: "not-a-port" })).toThrow()
  })
})

describe("bind address resolution", () => {
  it("binds loopback when neither config nor environment specifies an address", () => {
    const s = resolveRuntimeSettings(makeRegistry(), makeConfig(), {})
    expect(s.host).toBe("localhost")
  })

  it("takes the bind address from config when present", () => {
    const s = resolveRuntimeSettings(makeRegistry(), makeConfig({ host: "0.0.0.0" }), {})
    expect(s.host).toBe("0.0.0.0")
  })

  it("prefers the BANTER_CONTROL_HOST environment override over the config value", () => {
    const s = resolveRuntimeSettings(makeRegistry(), makeConfig({ host: "0.0.0.0" }), { BANTER_CONTROL_HOST: "127.0.0.1" })
    expect(s.host).toBe("127.0.0.1")
  })
})

describe("event log path resolution", () => {
  it("takes the event log path from config when present", () => {
    const s = resolveRuntimeSettings(makeRegistry(), makeConfig({ eventsPath: "/var/log/banter/events.jsonl" }), {})
    expect(s.eventsPath).toBe("/var/log/banter/events.jsonl")
  })

  it("prefers the BANTER_EVENTS_PATH environment override over the config value", () => {
    const s = resolveRuntimeSettings(
      makeRegistry(),
      makeConfig({ eventsPath: "/from/config.jsonl" }),
      { BANTER_EVENTS_PATH: "/from/env.jsonl" },
    )
    expect(s.eventsPath).toBe("/from/env.jsonl")
  })

  it("defaults the event log inside the deployment rather than another system's directory", () => {
    const s = resolveRuntimeSettings(makeRegistry(), makeConfig(), {})
    expect(s.eventsPath).not.toContain("services/platform")
    expect(s.eventsPath.endsWith(".jsonl")).toBe(true)
  })

  it("expands a leading ~ in a configured event log path to the home directory", () => {
    const s = resolveRuntimeSettings(makeRegistry(), makeConfig({ eventsPath: "~/banter/events.jsonl" }), {})
    expect(s.eventsPath.startsWith("~")).toBe(false)
    expect(s.eventsPath.endsWith("/banter/events.jsonl")).toBe(true)
  })
})

describe("interval resolution", () => {
  it("takes the health check interval from config when present", () => {
    const s = resolveRuntimeSettings(makeRegistry(), makeConfig({ healthIntervalMs: 60000 }), {})
    expect(s.healthIntervalMs).toBe(60000)
  })

  it("takes the shard poll interval from config when present", () => {
    const s = resolveRuntimeSettings(makeRegistry(), makeConfig({ shardPollIntervalMs: 45000 }), {})
    expect(s.shardPollIntervalMs).toBe(45000)
  })

  it("prefers the BANTER_HEALTH_INTERVAL_MS environment override over the config value", () => {
    const s = resolveRuntimeSettings(makeRegistry(), makeConfig({ healthIntervalMs: 60000 }), { BANTER_HEALTH_INTERVAL_MS: "1000" })
    expect(s.healthIntervalMs).toBe(1000)
  })

  it("supplies positive interval defaults when config omits them", () => {
    const s = resolveRuntimeSettings(makeRegistry(), makeConfig(), {})
    expect(s.healthIntervalMs).toBeGreaterThan(0)
    expect(s.shardPollIntervalMs).toBeGreaterThan(0)
  })

  it("rejects a zero interval rather than spinning a loop with no delay", () => {
    expect(() => resolveRuntimeSettings(makeRegistry(), makeConfig({ healthIntervalMs: 0 }), {})).toThrow()
  })

  it("rejects a negative interval", () => {
    expect(() => resolveRuntimeSettings(makeRegistry(), makeConfig({ shardPollIntervalMs: -1 }), {})).toThrow()
  })
})

describe("the no-environment guarantee", () => {
  it("resolves every runtime setting from files alone, with an empty environment", () => {
    const s = resolveRuntimeSettings(makeRegistry(), makeConfig(), {})
    expect(s.port).toBe(5107)
    expect(typeof s.host).toBe("string")
    expect(typeof s.eventsPath).toBe("string")
    expect(s.healthIntervalMs).toBeGreaterThan(0)
    expect(s.shardPollIntervalMs).toBeGreaterThan(0)
  })

  it("resolves identically whether the environment is empty or absent of relevant keys", () => {
    const fromEmpty = resolveRuntimeSettings(makeRegistry(), makeConfig(), {})
    const fromUnrelated = resolveRuntimeSettings(makeRegistry(), makeConfig(), { PATH: "/usr/bin", HOME: "/home/someone" })
    expect(fromUnrelated).toEqual(fromEmpty)
  })

  it("reads a registry and config written to disk without any environment variables", async () => {
    const registryPath = join(tmpDir, "registry.json")
    const configPath = join(tmpDir, "config.json")
    await writeFile(registryPath, JSON.stringify(makeRegistry()))
    await writeFile(configPath, JSON.stringify(makeConfig({ eventsPath: join(tmpDir, "events.jsonl") })))

    const registry = JSON.parse(await Bun.file(registryPath).text()) as Registry
    const config = JSON.parse(await Bun.file(configPath).text()) as PlatformConfig
    const s = resolveRuntimeSettings(registry, config, {})

    expect(s.port).toBe(5107)
    expect(s.eventsPath).toBe(join(tmpDir, "events.jsonl"))
  })
})
