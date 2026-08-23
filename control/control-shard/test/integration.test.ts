import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry } from "../../shared/src/registry";
import { appendEvent } from "../../shared/src/events";
import type { Registry } from "../../../shared/types";

let tmpDir: string;
let registryPath: string;
let eventsPath: string;
let registry: Registry;

const SEED: Registry = {
  version: 2,
  type: "shard",
  hosts: [{ id: "gpu-machine", name: "gpu-machine", hostname: "gpu-machine.example.ts.net", role: "worker" }],
  capabilities: [{ id: "tts", name: "Text to Speech" }],
  services: [
    {
      id: "voxtral",
      capabilityId: "tts",
      hostId: "gpu-machine",
      permissions: { enabled: true },
      runner: { type: "process", main: ".venv/bin/uvicorn server:app --port 8000" },
      network: { port: 8000, healthPath: "/health" },
      lifecycle: { loadStrategy: "demand" },
    },
    {
      id: "parakeet",
      capabilityId: "tts",
      hostId: "gpu-machine",
      permissions: { enabled: true },
      runner: { type: "process", main: ".venv/bin/parakeet-server --port 8001" },
      network: { port: 8001, healthPath: "/health" },
      lifecycle: { loadStrategy: "demand" },
    },
  ],
};

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "integration-test-"));
  registryPath = join(tmpDir, "registry.json");
  eventsPath = join(tmpDir, "events.jsonl");
  await writeFile(registryPath, JSON.stringify(SEED, null, 2));
  registry = await loadRegistry(registryPath);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Control plane polling the shard", () => {
  it("GET /api/services on the shard returns services with health and lastEvent fields", async () => {
    const { createShardApp } = await import("../src/shard-api");
    const app = createShardApp({
      registryState: registry,
      eventsPath,
      // inject no-op implementations
      getFreeMem: async () => 8 * 1024 * 1024 * 1024,
      checkMemoryBudget: async () => ({ ok: true }),
      loadService: async () => ({ ok: true }),
      unloadService: async () => ({ ok: true }),
    });

    const res = await app.request("/api/services");
    expect(res.status).toBe(200);
    const services = await res.json() as Array<{ id: string; health: string; lastEvent: unknown }>;
    expect(services.length).toBeGreaterThan(0);
    for (const svc of services) {
      expect("health" in svc).toBe(true);
      expect("lastEvent" in svc).toBe(true);
    }
  });

  it("GET /api/events on the shard returns events in newest-first order", async () => {
    // Append some events to the log
    await appendEvent(eventsPath, {
      type: "service.up",
      subjectType: "service",
      subjectId: "voxtral",
      data: { latencyMs: 10 },
      actor: "system",
    });
    await appendEvent(eventsPath, {
      type: "service.down",
      subjectType: "service",
      subjectId: "voxtral",
      data: {},
      actor: "system",
    });

    const { createShardApp } = await import("../src/shard-api");
    const app = createShardApp({
      registryState: registry,
      eventsPath,
      getFreeMem: async () => 8 * 1024 * 1024 * 1024,
      checkMemoryBudget: async () => ({ ok: true }),
      loadService: async () => ({ ok: true }),
      unloadService: async () => ({ ok: true }),
    });

    const res = await app.request("/api/events");
    expect(res.status).toBe(200);
    const events = await res.json() as Array<{ type: string }>;
    expect(events.length).toBeGreaterThan(0);
    // Most recent event should be first
    expect(events[0].type).toBe("service.down");
    expect(events[1].type).toBe("service.up");
  });

  it("GET /api/health returns ok even with no services loaded", async () => {
    const { createShardApp } = await import("../src/shard-api");
    const app = createShardApp({
      registryState: registry,
      eventsPath,
      getFreeMem: async () => 8 * 1024 * 1024 * 1024,
      checkMemoryBudget: async () => ({ ok: true }),
      loadService: async () => ({ ok: true }),
      unloadService: async () => ({ ok: true }),
    });

    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("ok");
  });

  it("shard services appear in GET /api/services with their current health state", async () => {
    // Append a health event for voxtral
    await appendEvent(eventsPath, {
      type: "service.up",
      subjectType: "service",
      subjectId: "voxtral",
      data: { latencyMs: 5 },
      actor: "system",
    });

    const { createShardApp } = await import("../src/shard-api");
    const app = createShardApp({
      registryState: registry,
      eventsPath,
      getFreeMem: async () => 8 * 1024 * 1024 * 1024,
      checkMemoryBudget: async () => ({ ok: true }),
      loadService: async () => ({ ok: true }),
      unloadService: async () => ({ ok: true }),
    });

    const res = await app.request("/api/services");
    const services = await res.json() as Array<{ id: string; health: string }>;
    const voxtral = services.find(s => s.id === "voxtral");
    expect(voxtral?.health).toBe("healthy");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Lifecycle proxying", () => {
  it("POST /api/services/:id/start returns 202 when memory budget passes for demand services", async () => {
    const checkMemoryBudget = async () => ({ ok: true });
    const demandService = registry.services.find(s => s.lifecycle?.loadStrategy === "demand");
    if (!demandService) throw new Error("No demand service in test registry");

    const { createShardApp } = await import("../src/shard-api");
    const app = createShardApp({
      registryState: registry,
      eventsPath,
      getFreeMem: async () => 8 * 1024 * 1024 * 1024,
      checkMemoryBudget,
      loadService: async () => ({ ok: true }),
      unloadService: async () => ({ ok: true }),
    });

    const res = await app.request(`/api/services/${demandService.id}/start`, { method: "POST" });
    expect(res.status).toBe(202);
  });

  it("POST /api/services/:id/start returns 503 when memory budget fails for demand services", async () => {
    const checkMemoryBudget = async () => ({
      ok: false,
      error: "memory pressure",
    });
    const demandService = registry.services.find(s => s.lifecycle?.loadStrategy === "demand");
    if (!demandService) throw new Error("No demand service in test registry");

    const { createShardApp } = await import("../src/shard-api");
    const app = createShardApp({
      registryState: registry,
      eventsPath,
      getFreeMem: async () => 8 * 1024 * 1024 * 1024,
      checkMemoryBudget,
      loadService: async () => ({ ok: true }),
      unloadService: async () => ({ ok: true }),
    });

    const res = await app.request(`/api/services/${demandService.id}/start`, { method: "POST" });
    expect(res.status).toBe(503);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Shard unavailability contract", () => {
  it("a fetch to a closed port throws a network error (caller must handle graceful degradation)", async () => {
    // Attempting to fetch from a non-existent server
    let error: Error | null = null;
    try {
      await fetch("http://127.0.0.1:0/api/services", { signal: AbortSignal.timeout(100) });
    } catch (e) {
      error = e as Error;
    }

    expect(error).not.toBeNull();
    // The error should be a network error, not a 500 response
    // Bun uses "Unable to connect" message
    expect(error?.message).toMatch(/Unable to connect|Connection refused|ECONNREFUSED|typo in the url or port/i);
  });

  it("the shared createApp health endpoint at /api/health returns 200 even with no services loaded", async () => {
    const { createApp } = await import("../../shared/src/api");
    const app = createApp({
      registryState: registry,
      registryPath,
      eventsPath,
      checkService: async () => {},
      runFn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      pollHealthFn: async () => true,
    });

    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("ok");
  });
});
