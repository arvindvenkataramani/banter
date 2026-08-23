import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry } from "../../shared/src/registry";
import { appendEvent, readEvents } from "../../shared/src/events";
import type { Registry, Service } from "../../../shared/types";

type CheckMemoryBudgetFn = (
  freeMem: number,
  requestedMem: number,
  footprintMap: Map<string, number>
) => Promise<{ ok: boolean; error?: string }>;
type LoadServiceFn = (service: Service) => Promise<{ ok: boolean; error?: string }>;
type UnloadServiceFn = (service: Service) => Promise<{ ok: boolean; error?: string }>;

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
      lifecycle: { loadStrategy: "demand", idleUnload: true, idleTimeout: 300000 },
    },
    {
      id: "parakeet",
      capabilityId: "tts",
      hostId: "gpu-machine",
      permissions: { enabled: true },
      runner: { type: "process", main: ".venv/bin/parakeet-server --port 8001" },
      network: { port: 8001, healthPath: "/health" },
      lifecycle: { loadStrategy: "demand", idleUnload: false },
    },
    {
      id: "disabled-svc",
      capabilityId: "tts",
      hostId: "gpu-machine",
      permissions: { enabled: false },
      runner: { type: "process", main: "start.sh" },
      network: { port: 8002, healthPath: "/health" },
      lifecycle: { loadStrategy: "demand", idleUnload: false },
    },
  ],
};

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "shard-api-test-"));
  registryPath = join(tmpDir, "registry.json");
  eventsPath = join(tmpDir, "events.jsonl");
  await writeFile(registryPath, JSON.stringify(SEED, null, 2));
  registry = await loadRegistry(registryPath);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function makeShardApp(opts: {
  getFreeMem?: () => Promise<number>;
  checkMemoryBudget?: CheckMemoryBudgetFn;
  loadService?: LoadServiceFn;
  unloadService?: UnloadServiceFn;
} = {}) {
  const { createShardApp } = await import("../src/shard-api");

  const getFreeMem = opts.getFreeMem ?? (async () => 8 * 1024 * 1024 * 1024); // 8 GB
  const checkMemoryBudgetOpts = opts.checkMemoryBudget ?? (async () => ({ ok: true }));
  const loadService = opts.loadService ?? (async () => ({ ok: true }));
  const unloadService = opts.unloadService ?? (async () => ({ ok: true }));

  // Wrap 3-arg checkMemoryBudget into the 0-arg form expected by createShardApp
  const checkMemoryBudget = async () => {
    const freeMem = await getFreeMem();
    return checkMemoryBudgetOpts(freeMem, 0, new Map());
  };

  return createShardApp({
    registryState: registry,
    eventsPath,
    getFreeMem,
    checkMemoryBudget,
    loadService,
    unloadService,
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe("GET /status", () => {
  it("returns freeMem as a number", async () => {
    const getFreeMem = async () => 5 * 1024 * 1024 * 1024; // 5 GB
    const app = await makeShardApp({ getFreeMem });
    const res = await app.request("/status");
    expect(res.status).toBe(200);
    const body = await res.json() as { freeMem: number };
    expect(typeof body.freeMem).toBe("number");
    expect(body.freeMem).toBe(5 * 1024 * 1024 * 1024);
  });

  it("includes all service ids present in the registry", async () => {
    const app = await makeShardApp();
    const res = await app.request("/status");
    expect(res.status).toBe(200);
    const body = await res.json() as { services: Record<string, unknown> };
    expect("voxtral" in body.services).toBe(true);
    expect("parakeet" in body.services).toBe(true);
  });

  it("each service entry includes health and lastPing fields", async () => {
    const app = await makeShardApp();
    const res = await app.request("/status");
    const body = await res.json() as { services: Record<string, any> };
    const svc = body.services.voxtral;
    expect("health" in svc).toBe(true);
    expect("lastPing" in svc).toBe(true);
  });

  it("lastPing is null for a service that has never been pinged", async () => {
    const app = await makeShardApp();
    const res = await app.request("/status");
    const body = await res.json() as { services: Record<string, any> };
    expect(body.services.voxtral.lastPing).toBeNull();
  });

  it("lastPing is a number (milliseconds) for a service that has been pinged", async () => {
    const app = await makeShardApp();
    // First, ping the service
    await app.request("/ping/voxtral", { method: "POST" });
    // Then, check status
    const res = await app.request("/status");
    const body = await res.json() as { services: Record<string, any> };
    expect(typeof body.services.voxtral.lastPing).toBe("number");
    expect(body.services.voxtral.lastPing).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("POST /ping/:service", () => {
  it("returns 200 for a known service id", async () => {
    const app = await makeShardApp();
    const res = await app.request("/ping/voxtral", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("returns 404 for an unknown service id", async () => {
    const app = await makeShardApp();
    const res = await app.request("/ping/unknown-svc", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("updates the lastPing value returned by the next GET /status call", async () => {
    const app = await makeShardApp();

    const status1 = await app.request("/status");
    const body1 = await status1.json() as { services: Record<string, any> };
    const before = body1.services.voxtral.lastPing;

    await app.request("/ping/voxtral", { method: "POST" });

    const status2 = await app.request("/status");
    const body2 = await status2.json() as { services: Record<string, any> };
    const after = body2.services.voxtral.lastPing;

    expect(after).not.toBe(before);
    expect(typeof after).toBe("number");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/services/:id/start (demand services)", () => {
  it("calls checkMemoryBudget before calling loadService", async () => {
    const order: string[] = [];
    const checkMemoryBudget = async () => {
      order.push("check");
      return { ok: true };
    };
    const loadService = async () => {
      order.push("load");
      return { ok: true };
    };
    const app = await makeShardApp({ checkMemoryBudget, loadService });

    await app.request("/api/services/voxtral/start", { method: "POST" });

    expect(order.indexOf("check")).toBeLessThan(order.indexOf("load"));
  });

  it("returns 503 when checkMemoryBudget fails", async () => {
    const checkMemoryBudget = async () => ({
      ok: false,
      error: "memory pressure",
    });
    const app = await makeShardApp({ checkMemoryBudget });

    const res = await app.request("/api/services/voxtral/start", { method: "POST" });
    expect(res.status).toBe(503);
  });

  it("emits memory.pressure event in the response when checkMemoryBudget fails", async () => {
    const checkMemoryBudget = async () => ({
      ok: false,
      error: "memory pressure",
    });
    const app = await makeShardApp({ checkMemoryBudget });

    await app.request("/api/services/voxtral/start", { method: "POST" });

    const events = await readEvents(eventsPath);
    expect(events.some(e => e.type === "memory.pressure")).toBe(true);
  });

  it("calls loadService when checkMemoryBudget passes", async () => {
    let loadCalled = false;
    const loadService = async () => {
      loadCalled = true;
      return { ok: true };
    };
    const app = await makeShardApp({ loadService });

    await app.request("/api/services/voxtral/start", { method: "POST" });

    expect(loadCalled).toBe(true);
  });

  it("returns 202 when load is initiated successfully", async () => {
    const app = await makeShardApp();
    const res = await app.request("/api/services/voxtral/start", { method: "POST" });
    expect(res.status).toBe(202);
  });

  it("returns 404 for an unknown service id", async () => {
    const app = await makeShardApp();
    const res = await app.request("/api/services/unknown-svc/start", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("returns 400 for a disabled service", async () => {
    const app = await makeShardApp();
    const res = await app.request("/api/services/disabled-svc/start", { method: "POST" });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("service is disabled");
  });

  it("returns 202 even when loadService will fail (fire-and-forget)", async () => {
    const loadService = async () => ({
      ok: false,
      error: "process failed to start",
    });
    const app = await makeShardApp({ loadService });

    const res = await app.request("/api/services/voxtral/start", { method: "POST" });
    expect(res.status).toBe(202);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/services/:id/stop (demand services)", () => {
  it("calls unloadService for the named service", async () => {
    let capturedSvcId: string | null = null;
    const unloadService = async (svc: Service) => {
      capturedSvcId = svc.id;
      return { ok: true };
    };
    const app = await makeShardApp({ unloadService });

    await app.request("/api/services/voxtral/stop", { method: "POST" });

    expect(capturedSvcId as string | null).toBe("voxtral");
  });

  it("returns 200 on success", async () => {
    const app = await makeShardApp();
    const res = await app.request("/api/services/voxtral/stop", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("returns 404 for an unknown service id", async () => {
    const app = await makeShardApp();
    const res = await app.request("/api/services/unknown-svc/stop", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("returns 500 when unloadService returns an error", async () => {
    const unloadService = async () => ({
      ok: false,
      error: "process failed to stop",
    });
    const app = await makeShardApp({ unloadService });

    const res = await app.request("/api/services/voxtral/stop", { method: "POST" });
    expect(res.status).toBe(500);
  });
});
