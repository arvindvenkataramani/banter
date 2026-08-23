import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { startShardPollLoop } from "../control-plane/src/shard-poller";
import type { ServiceWithHealth, Event, Shard } from "../../shared/types";

let mockServer: ReturnType<typeof Bun.serve>;
let shards: Shard[];

beforeEach(() => {
  mockServer = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);

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
        const events: Event[] = [
          {
            id: "evt1",
            timestamp: new Date().toISOString(),
            type: "service.up",
            subjectType: "service",
            subjectId: "tts-mlx-audio",
            data: { latencyMs: 12 },
            actor: "system",
          },
        ];
        return Response.json(events);
      }

      return Response.json({ error: "not found" }, { status: 404 });
    },
  });

  shards = [
    {
      hostId: "gpu-machine",
      endpoint: `http://localhost:${mockServer.port}`,
    },
  ];
});

afterEach(async () => {
  mockServer.stop(true);
});

describe("shard-poller: initialization and cache", () => {
  it("cache is populated after first successful poll", async () => {
    const poller = startShardPollLoop(shards, 50);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const services = poller.getShardServices("gpu-machine");
    expect(services).toHaveLength(1);
    expect(services[0].id).toBe("tts-mlx-audio");
    expect(services[0].health).toBe("healthy");

    poller.stop();
  });

  it("getShardServices returns empty array for unknown hostId", async () => {
    const poller = startShardPollLoop(shards, 50);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const services = poller.getShardServices("unknown-host");
    expect(services).toHaveLength(0);

    poller.stop();
  });

  it("getShardEvents returns cached events", async () => {
    const poller = startShardPollLoop(shards, 50);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const events = poller.getShardEvents("gpu-machine");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("service.up");

    poller.stop();
  });
});

describe("shard-poller: online status tracking", () => {
  it("isShardOnline returns true after successful poll", async () => {
    const poller = startShardPollLoop(shards, 50);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(poller.isShardOnline("gpu-machine")).toBe(true);

    poller.stop();
  });

  it("isShardOnline returns false when shard becomes unreachable", async () => {
    const poller = startShardPollLoop(shards, 50);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(poller.isShardOnline("gpu-machine")).toBe(true);

    mockServer.stop(true);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(poller.isShardOnline("gpu-machine")).toBe(false);

    poller.stop();
  });
});

describe("shard-poller: stale cache retention", () => {
  it("services from last successful poll are retained when shard goes offline", async () => {
    const poller = startShardPollLoop(shards, 50);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(poller.getShardServices("gpu-machine")).toHaveLength(1);

    mockServer.stop(true);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(poller.getShardServices("gpu-machine")).toHaveLength(1);
    expect(poller.getShardServices("gpu-machine")[0].id).toBe("tts-mlx-audio");

    poller.stop();
  });

  it("isShardOnline flips to false but getShardServices still returns stale data", async () => {
    const poller = startShardPollLoop(shards, 50);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(poller.isShardOnline("gpu-machine")).toBe(true);
    expect(poller.getShardServices("gpu-machine")).toHaveLength(1);

    mockServer.stop(true);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(poller.isShardOnline("gpu-machine")).toBe(false);
    expect(poller.getShardServices("gpu-machine")).toHaveLength(1);

    poller.stop();
  });
});

describe("shard-poller: polling loop control", () => {
  it("stop() halts the polling loop", async () => {
    let requestCount = 0;
    const countingServer = Bun.serve({
      port: 0,
      fetch: async (req) => {
        if (req.url.includes("/api/services")) requestCount++;
        return Response.json([]);
      },
    });

    try {
      const testShards: Shard[] = [{ hostId: "test-shard", endpoint: `http://localhost:${countingServer.port}` }];
      const poller = startShardPollLoop(testShards, 50);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const countAfterRunning = requestCount;

      poller.stop();
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(requestCount).toBe(countAfterRunning);
    } finally {
      countingServer.stop(true);
    }
  });
});
