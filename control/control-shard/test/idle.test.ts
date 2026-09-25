import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, readEvents } from "../../shared/src/events";
import type { Service } from "../../../shared/types";

let tmpDir: string;
let eventsPath: string;

beforeEach!(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "idle-test-"));
  eventsPath = join(tmpDir, "events.jsonl");
});

afterEach!(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeService(overrides: Partial<Service> = {}): Service {
  const { permissions, network, lifecycle, ...rest } = overrides;
  return {
    id: "test-svc",
    capabilityId: "cap",
    hostId: "host",
    permissions: { enabled: true, ...permissions },
    network: { port: 8080, healthPath: "/health", endpoint: "http://localhost:8080", ...network },
    lifecycle: { idleUnload: true, idleTimeout: 60000, ...lifecycle },
    ...rest,
  };
}


function makeDeps(services: Service[], pingMap: Map<string, number>) {
  return {
    registryState: {
      version: 2,
      type: "shard",
      servicesRoot: tmpDir,
      hosts: [],
      capabilities: [],
      services,
    },
    eventsPath,
    getFreeMem: async () => 8 * 1024 * 1024 * 1024,
    checkMemoryBudget: async () => ({ ok: true }),
    loadService: async () => ({ ok: true }),
    unloadService: async () => ({ ok: true }),
    pingMap,
  } as any;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("startIdleLoop() — eviction decisions", () => {
  it("calls evictFn for a service whose last ping is older than idleTimeout", async () => {
    const evictMock = mock(() => Promise.resolve());
    const now = Date.now();
    const svc = makeService({ id: "svc1", lifecycle: { idleTimeout: 5000, idleUnload: true } });
    svc.state = { loadTime: now - 20000 };
    const pingMap = new Map([["svc1", now - 10000]]); // pinged 10 seconds ago, timeout is 5 seconds

    const { startIdleLoop } = await import("../src/idle");
    const loop = startIdleLoop([svc], pingMap, evictMock, eventsPath, 10); // 10ms interval

    await new Promise(r => setTimeout(r, 50)); // wait 50ms for loop to run
    loop.stop();

    expect(evictMock).toHaveBeenCalled();
  });

  it("does not call evictFn for a service pinged recently (within idleTimeout)", async () => {
    const evictMock = mock(() => Promise.resolve());
    const now = Date.now();
    const svc = makeService({ id: "svc1", lifecycle: { idleTimeout: 5000, idleUnload: true } });
    const pingMap = new Map([["svc1", now - 1000]]); // pinged 1 second ago, timeout is 5 seconds

    const { startIdleLoop } = await import("../src/idle");
    const loop = startIdleLoop([svc], pingMap, evictMock, eventsPath, 10);

    await new Promise(r => setTimeout(r, 50));
    loop.stop();

    expect(evictMock).not.toHaveBeenCalled();
  });

  it("does not call evictFn for a service with idleUnload:false even after timeout", async () => {
    const evictMock = mock(() => Promise.resolve());
    const now = Date.now();
    const svc = makeService({ id: "svc1", lifecycle: { idleUnload: false, idleTimeout: 5000 } });
    const pingMap = new Map([["svc1", now - 10000]]); // old ping, but not eligible for eviction

    const { startIdleLoop } = await import("../src/idle");
    const loop = startIdleLoop([svc], pingMap, evictMock, eventsPath, 10);

    await new Promise(r => setTimeout(r, 50));
    loop.stop();

    expect(evictMock).not.toHaveBeenCalled();
  });

  it("does not call evictFn for a service with idleUnload:undefined", async () => {
    const evictMock = mock(() => Promise.resolve());
    const now = Date.now();
    const svc = makeService({ id: "svc1", lifecycle: { idleUnload: undefined, idleTimeout: 5000 } });
    const pingMap = new Map([["svc1", now - 10000]]);

    const { startIdleLoop } = await import("../src/idle");
    const loop = startIdleLoop([svc], pingMap, evictMock, eventsPath, 10);

    await new Promise(r => setTimeout(r, 50));
    loop.stop();

    expect(evictMock).not.toHaveBeenCalled();
  });

  it("uses service load time as baseline for a service with no ping entry yet", async () => {
    const evictMock = mock(() => Promise.resolve());
    const svc = makeService({ id: "svc1", lifecycle: { idleTimeout: 5000, idleUnload: true } });
    svc.state = { loadTime: Date.now() - 10000 }; // loaded 10 seconds ago
    const pingMap = new Map<string, number>(); // no entry for svc1

    const { startIdleLoop } = await import("../src/idle");
    const loop = startIdleLoop([svc], pingMap, evictMock, eventsPath, 10);

    await new Promise(r => setTimeout(r, 50));
    loop.stop();

    expect(evictMock).toHaveBeenCalled();
  });

  it("does not let a ping from before the current load evict a freshly loaded service", async () => {
    // The ping map outlives an unload. A service pinged, evicted, then loaded
    // again carries the old ping, which reads as long idle on the first tick.
    const evictMock = mock(() => Promise.resolve());
    const now = Date.now();
    const svc = makeService({ id: "svc1", lifecycle: { idleTimeout: 5000, idleUnload: true } });
    svc.state = { loadTime: now - 1000 }; // loaded 1 second ago
    const pingMap = new Map([["svc1", now - 60000]]); // pinged during an earlier load

    const { startIdleLoop } = await import("../src/idle");
    const loop = startIdleLoop([svc], pingMap, evictMock, eventsPath, 10);

    await new Promise(r => setTimeout(r, 50));
    loop.stop();

    expect(evictMock).not.toHaveBeenCalled();
  });

  it("evicts only timed-out services when multiple services are registered and only some have expired", async () => {
    const evictMock = mock((svc: Service) => { svc.state = { ...svc.state, loadTime: undefined }; return Promise.resolve(); });
    const now = Date.now();
    const svc1 = makeService({ id: "svc1", lifecycle: { idleTimeout: 5000, idleUnload: true } });
    svc1.state = { loadTime: now - 20000 };
    const svc2 = makeService({ id: "svc2", lifecycle: { idleTimeout: 5000, idleUnload: true } });
    svc2.state = { loadTime: now - 20000 };
    const svc3 = makeService({ id: "svc3", lifecycle: { idleTimeout: 5000, idleUnload: true } });
    svc3.state = { loadTime: now - 20000 };
    const pingMap = new Map([
      ["svc1", now - 10000], // old, should evict
      ["svc2", now - 1000],  // fresh, should not evict
      ["svc3", now - 10000], // old, should evict
    ]);

    const { startIdleLoop } = await import("../src/idle");
    const loop = startIdleLoop([svc1, svc2, svc3], pingMap, evictMock, eventsPath, 10);

    await new Promise(r => setTimeout(r, 50));
    loop.stop();

    expect(evictMock).toHaveBeenCalledTimes(2);
    const calls = evictMock.mock.calls;
    expect(calls.some(c => c[0].id === "svc1")).toBe(true);
    expect(calls.some(c => c[0].id === "svc3")).toBe(true);
    expect(calls.some(c => c[0].id === "svc2")).toBe(false);
  });

  it("emits service.unloaded event when eviction is called", async () => {
    const evictMock = mock(() => Promise.resolve());
    const now = Date.now();
    const svc = makeService({ id: "svc1", lifecycle: { idleTimeout: 5000, idleUnload: true } });
    svc.state = { loadTime: now - 20000 };
    const pingMap = new Map([["svc1", now - 10000]]);

    const { startIdleLoop } = await import("../src/idle");
    const loop = startIdleLoop([svc], pingMap, evictMock, eventsPath, 10);

    await new Promise(r => setTimeout(r, 50));
    loop.stop();

    const events = await readEvents(eventsPath);
    expect(events.some(e => e.type === "service.unloaded")).toBe(true);
  });

  it("stop() halts the loop — no further evictions after stop is called", async () => {
    const evictMock = mock(() => Promise.resolve());
    const now = Date.now();
    const svc = makeService({ id: "svc1", lifecycle: { idleTimeout: 1000, idleUnload: true } });
    const pingMap = new Map([["svc1", now - 10000]]);

    const { startIdleLoop } = await import("../src/idle");
    const loop = startIdleLoop([svc], pingMap, evictMock, eventsPath, 5);

    await new Promise(r => setTimeout(r, 20));
    const countAfterFirstRun = evictMock.mock.calls.length;

    loop.stop();
    await new Promise(r => setTimeout(r, 30));
    const countAfterStop = evictMock.mock.calls.length;

    expect(countAfterStop).toBe(countAfterFirstRun); // no new calls after stop
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("POST /ping/:service — status codes", () => {
  it("returns 200 for a known service id", async () => {
    const { createShardApp } = await import("../src/shard-api");
    const svc = makeService({ id: "svc1" });
    const app = createShardApp(makeDeps([svc], new Map()));

    const res = await app.fetch(new Request("http://localhost/ping/svc1", { method: "POST" }));
    expect(res.status).toBe(200);
  });

  it("returns 404 for an unknown service id", async () => {
    const { createShardApp } = await import("../src/shard-api");
    const svc = makeService({ id: "svc1" });
    const app = createShardApp(makeDeps([svc], new Map()));

    const res = await app.fetch(new Request("http://localhost/ping/nope", { method: "POST" }));
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("POST /ping/:service — reaches the eviction loop", () => {
  // The endpoint and the eviction loop have to share one ping map. They used
  // not to: createShardApp built its own, so pings landed in a map the loop
  // never read and eviction ran off loadTime regardless of activity.
  it("a ping through the endpoint prevents the next eviction tick", async () => {
    const { createShardApp } = await import("../src/shard-api");
    const { startIdleLoop } = await import("../src/idle");

    const evictMock = mock(() => Promise.resolve());
    const svc = makeService({
      id: "svc1",
      lifecycle: { idleTimeout: 5000, idleUnload: true },
      state: { loadTime: Date.now() - 10000 },
    } as any);
    const pingMap = new Map<string, number>();

    const app = createShardApp(makeDeps([svc], pingMap));

    // Ping first: the service is well past its idle timeout on loadTime alone,
    // so only a ping the loop can see keeps it alive.
    await app.fetch(new Request("http://localhost/ping/svc1", { method: "POST" }));

    const loop = startIdleLoop([svc], pingMap, evictMock, eventsPath, 10);
    await new Promise(r => setTimeout(r, 30));
    loop.stop();

    expect(evictMock).not.toHaveBeenCalled();
  });
});
