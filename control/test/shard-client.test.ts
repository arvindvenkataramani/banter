import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { fetchShardServices, fetchShardService, fetchShardEvents, proxyShardAction, proxyShardPatch, proxyShardEnabledToggle, proxyShardCheck } from "../control-plane/src/shard-client";
import type { ServiceWithHealth, Event } from "../../shared/types";

let mockServer: ReturnType<typeof Bun.serve>;
let mockPort: number;
let mockBaseUrl: string;

beforeEach(() => {
  mockServer = Bun.serve({
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

      if (url.pathname === "/api/services" && req.method === "GET") {
        const services: ServiceWithHealth[] = [
          {
            id: "tts-mlx-audio",
            capabilityId: "tts",
            hostId: "gpu-machine",
            permissions: { enabled: true },
            network: { port: 8000, healthPath: "/health", endpoint: "http://localhost:8000" },
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
        ];
        return Response.json(services);
      }

      if (url.pathname === "/api/events" && req.method === "GET") {
        const limit = url.searchParams.get("limit");
        const subjectId = url.searchParams.get("subjectId");
        const events: Event[] = [
          {
            id: "evt1",
            timestamp: new Date().toISOString(),
            type: "service.up",
            subjectType: "service",
            subjectId: subjectId || "tts-mlx-audio",
            data: { latencyMs: 12 },
            actor: "system",
          },
        ];
        return Response.json(events.slice(0, parseInt(limit || "50")));
      }

      if (url.pathname.match(/^\/api\/services\/[\w-]+\/(start|stop|restart)$/) && req.method === "POST") {
        return Response.json({ success: true }, { status: 200 });
      }

      if (url.pathname.match(/^\/api\/services\/[\w-]+$/) && req.method === "PATCH") {
        return Response.json({ id: "tts-mlx-audio", enabled: true }, { status: 200 });
      }

      if (url.pathname.match(/^\/api\/services\/[\w-]+\/enabled$/) && req.method === "PATCH") {
        return Response.json({ id: "tts-mlx-audio", enabled: true }, { status: 200 });
      }

      return Response.json({ error: "not found" }, { status: 404 });
    },
  });

  mockPort = mockServer.port!;
  mockBaseUrl = `http://localhost:${mockPort}`;
});

afterEach(() => {
  mockServer.stop(true);
});

describe("shard-client: fetchShardServices", () => {
  it("returns parsed ServiceWithHealth array from shard GET /api/services", async () => {
    const result = await fetchShardServices(mockBaseUrl);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("tts-mlx-audio");
    expect(result[0].health).toBe("healthy");
  });

  it("throws when shard returns non-2xx status", async () => {
    const badServer = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error: "server error" }, { status: 500 }),
    });

    try {
      const badUrl = `http://localhost:${badServer.port}`;
      await expect(fetchShardServices(badUrl)).rejects.toThrow();
    } finally {
      badServer.stop(true);
    }
  });

  it("throws when shard is unreachable", async () => {
    const tmp = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const deadPort = tmp.port;
    tmp.stop(true);

    const deadUrl = `http://localhost:${deadPort}`;
    await expect(fetchShardServices(deadUrl)).rejects.toThrow();
  });
});

describe("shard-client: fetchShardEvents", () => {
  it("returns parsed Event array from shard GET /api/events", async () => {
    const result = await fetchShardEvents(mockBaseUrl);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("service.up");
  });

  it("passes limit query parameter when provided", async () => {
    let capturedLimit: string | null = null;
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url);
        capturedLimit = url.searchParams.get("limit");
        return Response.json([]);
      },
    });

    try {
      await fetchShardEvents(`http://localhost:${server.port}`, { limit: 10 });
      expect(capturedLimit as string | null).toBe("10");
    } finally {
      server.stop(true);
    }
  });

  it("passes subjectId query parameter when provided", async () => {
    let capturedSubjectId: string | null = null;
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url);
        capturedSubjectId = url.searchParams.get("subjectId");
        return Response.json([]);
      },
    });

    try {
      await fetchShardEvents(`http://localhost:${server.port}`, { subjectId: "test-svc" });
      expect(capturedSubjectId as string | null).toBe("test-svc");
    } finally {
      server.stop(true);
    }
  });
});

describe("shard-client: proxyShardAction", () => {
  it("sends POST to /api/services/:id/start and returns response body", async () => {
    let capturedMethod = "";
    let capturedPath = "";
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        capturedMethod = req.method;
        capturedPath = new URL(req.url).pathname;
        return Response.json({ success: true });
      },
    });

    try {
      await proxyShardAction(`http://localhost:${server.port}`, "svc-1", "start");
      expect(capturedMethod).toBe("POST");
      expect(capturedPath).toBe("/api/services/svc-1/start");
    } finally {
      server.stop(true);
    }
  });

  it("sends POST to /api/services/:id/stop and returns response body", async () => {
    let capturedPath = "";
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        capturedPath = new URL(req.url).pathname;
        return Response.json({ success: true });
      },
    });

    try {
      await proxyShardAction(`http://localhost:${server.port}`, "svc-1", "stop");
      expect(capturedPath).toBe("/api/services/svc-1/stop");
    } finally {
      server.stop(true);
    }
  });

  it("sends POST to /api/services/:id/restart and returns response body", async () => {
    let capturedPath = "";
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        capturedPath = new URL(req.url).pathname;
        return Response.json({ success: true });
      },
    });

    try {
      await proxyShardAction(`http://localhost:${server.port}`, "svc-1", "restart");
      expect(capturedPath).toBe("/api/services/svc-1/restart");
    } finally {
      server.stop(true);
    }
  });

  it("returns ok: false with status when shard returns non-2xx", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error: "memory pressure" }, { status: 503 }),
    });

    try {
      const result = await proxyShardAction(`http://localhost:${server.port}`, "svc-1", "start");
      expect(result.ok).toBe(false);
      expect(result.status).toBe(503);
    } finally {
      server.stop(true);
    }
  });

  it("handles non-JSON response without crashing", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(null, { status: 502 }),
    });

    try {
      const result = await proxyShardAction(`http://localhost:${server.port}`, "svc-1", "start");
      expect(result.ok).toBe(false);
      expect(result.status).toBe(502);
      expect(result.error).toBe("shard returned 502");
    } finally {
      server.stop(true);
    }
  });

  it("returns ok: false when shard is unreachable", async () => {
    const tmp = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const deadPort = tmp.port;
    tmp.stop(true);

    const result = await proxyShardAction(`http://localhost:${deadPort}`, "svc-1", "start");
    expect(result.ok).toBe(false);
  });
});

describe("shard-client: proxyShardPatch", () => {
  it("sends PATCH to /api/services/:id with patch body and returns response", async () => {
    let capturedBody = "";
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        capturedBody = await req.text();
        return Response.json({ id: "svc-1", idleTimeout: 600000 });
      },
    });

    try {
      const result = await proxyShardPatch(`http://localhost:${server.port}`, "svc-1", { idleTimeout: 600000 });
      expect(result.ok).toBe(true);
      expect(capturedBody).toContain("idleTimeout");
    } finally {
      server.stop(true);
    }
  });

  it("returns ok: false when shard returns non-2xx", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error: "bad request" }, { status: 400 }),
    });

    try {
      const result = await proxyShardPatch(`http://localhost:${server.port}`, "svc-1", { idleTimeout: 0 });
      expect(result.ok).toBe(false);
      expect(result.status).toBe(400);
    } finally {
      server.stop(true);
    }
  });
});

describe("shard-client: proxyShardEnabledToggle", () => {
  it("sends PATCH to /api/services/:id/enabled with enabled body", async () => {
    let capturedBody = "";
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        capturedBody = await req.text();
        return Response.json({ id: "svc-1", enabled: true });
      },
    });

    try {
      const result = await proxyShardEnabledToggle(`http://localhost:${server.port}`, "svc-1", { enabled: true });
      expect(result.ok).toBe(true);
      expect(capturedBody).toContain("true");
    } finally {
      server.stop(true);
    }
  });

  it("returns ok: false when shard returns non-2xx", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error: "forbidden" }, { status: 403 }),
    });

    try {
      const result = await proxyShardEnabledToggle(`http://localhost:${server.port}`, "svc-1", { enabled: false });
      expect(result.ok).toBe(false);
      expect(result.status).toBe(403);
    } finally {
      server.stop(true);
    }
  });
});

describe("shard-client: fetchShardService", () => {
  it("returns a single ServiceWithHealth from shard GET /api/services/:id", async () => {
    const result = await fetchShardService(mockBaseUrl, "tts-mlx-audio");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("tts-mlx-audio");
    expect(result!.health).toBe("healthy");
  });

  it("returns null when shard returns 404", async () => {
    const result = await fetchShardService(mockBaseUrl, "nonexistent");
    expect(result).toBeNull();
  });

  it("throws when shard returns non-2xx (other than 404)", async () => {
    const badServer = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error: "server error" }, { status: 500 }),
    });

    try {
      await expect(fetchShardService(`http://localhost:${badServer.port}`, "svc-1")).rejects.toThrow();
    } finally {
      badServer.stop(true);
    }
  });

  it("throws when shard is unreachable", async () => {
    const tmp = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const deadPort = tmp.port;
    tmp.stop(true);

    await expect(fetchShardService(`http://localhost:${deadPort}`, "svc-1")).rejects.toThrow();
  });
});

describe("shard-client: proxyShardCheck", () => {
  it("sends POST to /api/services/:id/check and returns response", async () => {
    let capturedPath = "";
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        capturedPath = new URL(req.url).pathname;
        return Response.json({ id: "svc-1", health: "healthy" });
      },
    });

    try {
      const result = await proxyShardCheck(`http://localhost:${server.port}`, "svc-1");
      expect(result.ok).toBe(true);
      expect(capturedPath).toBe("/api/services/svc-1/check");
    } finally {
      server.stop(true);
    }
  });

  it("returns ok: false when shard returns non-2xx", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error: "service not found" }, { status: 404 }),
    });

    try {
      const result = await proxyShardCheck(`http://localhost:${server.port}`, "svc-1");
      expect(result.ok).toBe(false);
      expect(result.status).toBe(404);
    } finally {
      server.stop(true);
    }
  });
});
