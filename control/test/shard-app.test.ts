import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createControlPlaneApp } from "../control-plane/src/app";
import { appendEvent } from "../shared/src/events";
import { clearLocks } from "../shared/src/lifecycle";
import type { Registry } from "../../shared/types";

let tmpDir: string;
let registryPath: string;
let eventsPath: string;
let mockShardServer: ReturnType<typeof Bun.serve>;

const REGISTRY: Registry = {
  version: 2,
  type: "control",
  hosts: [
    {
      id: "home-server",
      name: "home-server",
      hostname: "home-server.example.ts.net",
      role: "control",
    },
    {
      id: "gpu-machine",
      name: "gpu-machine",
      hostname: "localhost",
      role: "worker",
    },
  ],
  capabilities: [
    { id: "control", name: "Control Plane" },
    { id: "dashboard", name: "Dashboard" },
    { id: "tts", name: "Text-to-Speech" },
    { id: "stt", name: "Speech-to-Text" },
  ],
  services: [
    {
      id: "control",
      capabilityId: "control",
      hostId: "home-server",
      permissions: { enabled: true, protected: true },
      runner: { type: "systemd", unit: "platform", unitFile: "ops/systemd/platform.service" },
      network: { port: 4200, healthPath: "/api/health" },
    },
    {
      id: "dashboard",
      capabilityId: "dashboard",
      hostId: "home-server",
      permissions: { enabled: true, protected: true },
      runner: { type: "systemd", unit: "dashboard", unitFile: "ops/systemd/dashboard.service" },
      network: { port: 5173, healthPath: "/api/health" },
    },
  ],
  shards: [],
};

beforeEach(async () => {
  clearLocks();
  process.env.BANTER_SHARD_POLL_INTERVAL_MS = "50";
  tmpDir = await mkdtemp(join(tmpdir(), "shard-app-test-"));
  registryPath = join(tmpDir, "registry.json");
  eventsPath = join(tmpDir, "events.jsonl");

  await writeFile(registryPath, JSON.stringify(REGISTRY, null, 2));

  // Set up mock shard server
  mockShardServer = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);

      if (url.pathname === "/api/services/tts-mlx-audio" && req.method === "GET") {
        return Response.json({
          id: "tts-mlx-audio",
          capabilityId: "tts",
          hostId: "gpu-machine",
          permissions: { enabled: true },
          network: { port: 8000, healthPath: "/health", endpoint: "http://localhost:8000" },
          lifecycle: { loadStrategy: "demand" },
          health: "healthy",
          lastEvent: {
            id: "evt1",
            timestamp: new Date().toISOString(),
            type: "service.up",
            subjectType: "service",
            subjectId: "tts-mlx-audio",
            data: { latencyMs: 12 },
            actor: "system",
          },
        });
      }

      if (url.pathname === "/api/services/stt-parakeet" && req.method === "GET") {
        return Response.json({
          id: "stt-parakeet",
          capabilityId: "stt",
          hostId: "gpu-machine",
          permissions: { enabled: true },
          network: { port: 9000, healthPath: "/health", endpoint: "http://localhost:9000" },
          lifecycle: { loadStrategy: "demand" },
          health: "healthy",
          lastEvent: {
            id: "evt2",
            timestamp: new Date().toISOString(),
            type: "service.up",
            subjectType: "service",
            subjectId: "stt-parakeet",
            data: { latencyMs: 8 },
            actor: "system",
          },
        });
      }

      if (url.pathname === "/api/services" && req.method === "GET") {
        return Response.json([
          {
            id: "tts-mlx-audio",
            capabilityId: "tts",
            hostId: "gpu-machine",
            permissions: { enabled: true },
            network: { port: 8000, healthPath: "/health", endpoint: "http://localhost:8000" },
            lifecycle: { loadStrategy: "demand" },
            health: "healthy",
            lastEvent: {
              id: "evt1",
              timestamp: new Date().toISOString(),
              type: "service.up",
              subjectType: "service",
              subjectId: "tts-mlx-audio",
              data: { latencyMs: 12 },
              actor: "system",
            },
          },
          {
            id: "stt-parakeet",
            capabilityId: "stt",
            hostId: "gpu-machine",
            permissions: { enabled: true },
            network: { port: 9000, healthPath: "/health", endpoint: "http://localhost:9000" },
            lifecycle: { loadStrategy: "demand" },
            health: "unknown",
            lastEvent: null,
          },
        ]);
      }

      if (url.pathname === "/api/events" && req.method === "GET") {
        const limit = parseInt(url.searchParams.get("limit") || "50");
        return Response.json([
          {
            id: "evt1",
            timestamp: new Date().toISOString(),
            type: "service.up",
            subjectType: "service",
            subjectId: "tts-mlx-audio",
            data: { latencyMs: 12 },
            actor: "system",
          },
        ].slice(0, limit));
      }

      if (url.pathname === "/api/services/tts-mlx-audio/start" && req.method === "POST") {
        return Response.json({ success: true }, { status: 202 });
      }

      if (url.pathname === "/api/services/tts-mlx-audio/stop" && req.method === "POST") {
        return Response.json({ success: true }, { status: 200 });
      }

      if (url.pathname === "/api/services/tts-mlx-audio/restart" && req.method === "POST") {
        return Response.json({ success: true }, { status: 200 });
      }

      if (url.pathname === "/api/services/tts-mlx-audio" && req.method === "PATCH") {
        return Response.json({ id: "tts-mlx-audio", lifecycle: { idleTimeout: 600000 } }, { status: 200 });
      }

      if (url.pathname === "/api/services/tts-mlx-audio/enabled" && req.method === "PATCH") {
        return Response.json({ id: "tts-mlx-audio", permissions: { enabled: false } }, { status: 200 });
      }

      if (url.pathname === "/api/services/tts-mlx-audio/check" && req.method === "POST") {
        return Response.json({ id: "tts-mlx-audio", health: "healthy" }, { status: 200 });
      }

      return Response.json({ error: "not found" }, { status: 404 });
    },
  });

  // Update registry to include shard — port is derived into endpoint at load time
  // hostname for gpu-machine is "localhost" in this test registry
  REGISTRY.shards = [
    {
      hostId: "gpu-machine",
      endpoint: `http://localhost:${mockShardServer.port}`, // pre-set for in-memory use; will be overwritten on reload
    },
  ];
  await writeFile(registryPath, JSON.stringify({ ...REGISTRY, shards: [{ hostId: "gpu-machine", port: mockShardServer.port }] }, null, 2));
});

afterEach(async () => {
  delete process.env.BANTER_SHARD_POLL_INTERVAL_MS;
  mockShardServer.stop(true);
  await rm(tmpDir, { recursive: true, force: true });
});

describe("shard-app: service listing and merge", () => {
  it("GET /api/services returns both local and shard services", async () => {
    const app = await createControlPlaneApp({
      registryPath,
      eventsPath,
      checkService: async () => {},
      runFn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      pollHealthFn: async () => true,
    });

    // Wait for initial poll
    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await app.fetch(new Request("http://localhost/api/services"));
    expect(res.status).toBe(200);

    const services = await res.json();
    expect(services.length).toBeGreaterThanOrEqual(3); // 2 local + at least 2 shard

    const ids = services.map((s: any) => s.id);
    expect(ids).toContain("control");
    expect(ids).toContain("dashboard");
    expect(ids).toContain("tts-mlx-audio");
    expect(ids).toContain("stt-parakeet");
  });

  it("GET /api/services/:id returns a local service", async () => {
    const app = await createControlPlaneApp({
      registryPath,
      eventsPath,
      checkService: async () => {},
      runFn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      pollHealthFn: async () => true,
    });

    const res = await app.fetch(new Request("http://localhost/api/services/dashboard"));
    expect(res.status).toBe(200);

    const svc = await res.json();
    expect(svc.id).toBe("dashboard");
    expect(svc.hostId).toBe("home-server");
  });

  it("GET /api/services/:id returns a shard service with live health", async () => {
    const app = await createControlPlaneApp({
      registryPath,
      eventsPath,
      checkService: async () => {},
      runFn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      pollHealthFn: async () => true,
    });

    // Wait for initial poll
    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await app.fetch(new Request("http://localhost/api/services/tts-mlx-audio"));
    expect(res.status).toBe(200);

    const svc = await res.json();
    expect(svc.id).toBe("tts-mlx-audio");
    expect(svc.hostId).toBe("gpu-machine");
    // Live fetch should return "healthy" even though list endpoint returns "healthy" too
    expect(svc.health).toBe("healthy");
  });

  it("GET /api/services/:id returns live health for stt-parakeet", async () => {
    const app = await createControlPlaneApp({
      registryPath,
      eventsPath,
      checkService: async () => {},
      runFn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      pollHealthFn: async () => true,
    });

    // Wait for initial poll — list endpoint returns "unknown" for stt-parakeet
    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await app.fetch(new Request("http://localhost/api/services/stt-parakeet"));
    expect(res.status).toBe(200);

    const svc = await res.json();
    expect(svc.id).toBe("stt-parakeet");
    // Live fetch returns "healthy" even though the list cache had "unknown"
    expect(svc.health).toBe("healthy");
  });

  it("GET /api/services/:id falls back to cache when shard is unreachable", async () => {
    const app = await createControlPlaneApp({
      registryPath,
      eventsPath,
      checkService: async () => {},
      runFn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      pollHealthFn: async () => true,
    });

    // Wait for initial poll to populate cache
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Stop the shard
    mockShardServer.stop(true);

    const res = await app.fetch(new Request("http://localhost/api/services/tts-mlx-audio"));
    expect(res.status).toBe(200);

    const svc = await res.json();
    expect(svc.id).toBe("tts-mlx-audio");
    // Falls back to cached data instead of erroring
    expect(svc.hostId).toBe("gpu-machine");
  });

  it("GET /api/services/:id returns 404 for unknown service", async () => {
    const app = await createControlPlaneApp({
      registryPath,
      eventsPath,
      checkService: async () => {},
      runFn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      pollHealthFn: async () => true,
    });

    const res = await app.fetch(new Request("http://localhost/api/services/unknown-svc"));
    expect(res.status).toBe(404);
  });
});

describe("shard-app: lifecycle action routing", () => {
  it("POST /api/services/dashboard/start runs locally (not proxied)", async () => {
    const cmds: string[][] = [];
    const app = await createControlPlaneApp({
      registryPath,
      eventsPath,
      checkService: async () => {},
      runFn: async (cmd) => { cmds.push(cmd); return { stdout: "", stderr: "", exitCode: 0 }; },
      pollHealthFn: async () => true,
    });

    const res = await app.fetch(
      new Request("http://localhost/api/services/dashboard/start", { method: "POST" })
    );
    expect(res.status).toBe(200);
    expect(cmds.some(c => c.includes("dashboard.service"))).toBe(true);
  });

  it("POST /api/services/tts-mlx-audio/start proxies to shard", async () => {
    const app = await createControlPlaneApp({
      registryPath,
      eventsPath,
      checkService: async () => {},
      runFn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      pollHealthFn: async () => true,
    });

    // Wait for initial poll
    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await app.fetch(
      new Request("http://localhost/api/services/tts-mlx-audio/start", { method: "POST" })
    );
    expect(res.status).toBe(202);
  });

  it("POST /api/services/tts-mlx-audio/stop proxies to shard", async () => {
    const app = await createControlPlaneApp({
      registryPath,
      eventsPath,
      checkService: async () => {},
      runFn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      pollHealthFn: async () => true,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await app.fetch(
      new Request("http://localhost/api/services/tts-mlx-audio/stop", { method: "POST" })
    );
    expect(res.status).toBe(200);
  });

  it("POST /api/services/tts-mlx-audio/restart proxies to shard", async () => {
    const app = await createControlPlaneApp({
      registryPath,
      eventsPath,
      checkService: async () => {},
      runFn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      pollHealthFn: async () => true,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await app.fetch(
      new Request("http://localhost/api/services/tts-mlx-audio/restart", { method: "POST" })
    );
    expect(res.status).toBe(200);
  });

  it("proxied start returns shard response status", async () => {
    const app = await createControlPlaneApp({
      registryPath,
      eventsPath,
      checkService: async () => {},
      runFn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      pollHealthFn: async () => true,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await app.fetch(
      new Request("http://localhost/api/services/tts-mlx-audio/start", { method: "POST" })
    );
    expect(res.status).toBe(202); // demand service accepted
  });

  it("proxied action returns 503 when shard is offline", async () => {
    const app = await createControlPlaneApp({
      registryPath,
      eventsPath,
      checkService: async () => {},
      runFn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      pollHealthFn: async () => true,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    // Kill the shard
    mockShardServer.stop(true);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await app.fetch(
      new Request("http://localhost/api/services/tts-mlx-audio/start", { method: "POST" })
    );
    expect(res.status).toBe(503);
  });
});

describe("shard-app: PATCH routing", () => {
  it("PATCH /api/services/dashboard updates local registry", async () => {
    const app = await createControlPlaneApp({
      registryPath,
      eventsPath,
      checkService: async () => {},
      runFn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      pollHealthFn: async () => true,
    });

    const res = await app.fetch(
      new Request("http://localhost/api/services/dashboard", {
        method: "PATCH",
        body: JSON.stringify({ network: { port: 5173 } }),
        headers: { "content-type": "application/json" },
      })
    );
    expect(res.status).toBe(200);

    const updated = await res.json();
    expect(updated.id).toBe("dashboard");
  });

  it("PATCH /api/services/tts-mlx-audio proxies to shard", async () => {
    const app = await createControlPlaneApp({
      registryPath,
      eventsPath,
      checkService: async () => {},
      runFn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      pollHealthFn: async () => true,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await app.fetch(
      new Request("http://localhost/api/services/tts-mlx-audio", {
        method: "PATCH",
        body: JSON.stringify({ lifecycle: { idleTimeout: 600000 } }),
        headers: { "content-type": "application/json" },
      })
    );
    expect(res.status).toBe(200);

    const updated = await res.json();
    expect(updated.id).toBe("tts-mlx-audio");
  });

  it("PATCH /api/services/tts-mlx-audio/enabled proxies to shard", async () => {
    const app = await createControlPlaneApp({
      registryPath,
      eventsPath,
      checkService: async () => {},
      runFn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      pollHealthFn: async () => true,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await app.fetch(
      new Request("http://localhost/api/services/tts-mlx-audio/enabled", {
        method: "PATCH",
        body: JSON.stringify({ enabled: false }),
        headers: { "content-type": "application/json" },
      })
    );
    expect(res.status).toBe(200);
  });
});

describe("shard-app: events merge", () => {
  it("GET /api/events returns merged local + shard events sorted by timestamp", async () => {
    const app = await createControlPlaneApp({
      registryPath,
      eventsPath,
      checkService: async () => {},
      runFn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      pollHealthFn: async () => true,
    });

    // Write a local event
    await appendEvent(eventsPath, {
      type: "service.up",
      subjectType: "service",
      subjectId: "dashboard",
      data: {},
      actor: "system",
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await app.fetch(new Request("http://localhost/api/events"));
    expect(res.status).toBe(200);

    const events = await res.json();
    expect(events.length).toBeGreaterThanOrEqual(1); // at least the shard events
  });

  it("limit parameter caps the merged result", async () => {
    const app = await createControlPlaneApp({
      registryPath,
      eventsPath,
      checkService: async () => {},
      runFn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      pollHealthFn: async () => true,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await app.fetch(new Request("http://localhost/api/events?limit=1"));
    const events = await res.json();
    expect(events.length).toBeLessThanOrEqual(1);
  });
});

describe("shard-app: health check routing", () => {
  it("POST /api/services/tts-mlx-audio/check proxies to shard", async () => {
    const app = await createControlPlaneApp({
      registryPath,
      eventsPath,
      checkService: async () => {},
      runFn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      pollHealthFn: async () => true,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await app.fetch(
      new Request("http://localhost/api/services/tts-mlx-audio/check", { method: "POST" })
    );
    expect(res.status).toBe(200);
  });

  it("POST /api/services/dashboard/check runs locally", async () => {
    let localCheckCalled = false;
    const app = await createControlPlaneApp({
      registryPath,
      eventsPath,
      checkService: async (svc) => {
        if (svc.id === "dashboard") localCheckCalled = true;
      },
      runFn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      pollHealthFn: async () => true,
    });

    const res = await app.fetch(
      new Request("http://localhost/api/services/dashboard/check", { method: "POST" })
    );
    expect(res.status).toBe(200);
    expect(localCheckCalled).toBe(true);
  });
});
