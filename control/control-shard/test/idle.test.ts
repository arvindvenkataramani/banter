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

describe("POST /ping/:service — effect on idle clock", () => {
  it("returns 200 for a known service id", async () => {
    const { createPingEndpoint } = await import("../src/idle");
    const svc = makeService({ id: "svc1" });
    const pingMap = new Map<string, number>();
    const pingHandler = createPingEndpoint([svc], pingMap);

    const result = await pingHandler("svc1");
    expect(result.status).toBe(200);
  });

  it("returns 404 for an unknown service id", async () => {
    const { createPingEndpoint } = await import("../src/idle");
    const svc = makeService({ id: "svc1" });
    const pingMap = new Map<string, number>();
    const pingHandler = createPingEndpoint([svc], pingMap);

    const result = await pingHandler("unknown-svc");
    expect(result.status).toBe(404);
  });

  it("a ping prevents eviction on the next tick (resets the idle clock)", async () => {
    const evictMock = mock(() => Promise.resolve());
    const now = Date.now();
    const svc = makeService({ id: "svc1", lifecycle: { idleTimeout: 5000, idleUnload: true } });
    const pingMap = new Map([["svc1", now - 10000]]); // old ping

    const { startIdleLoop, createPingEndpoint } = await import("../src/idle");
    const loop = startIdleLoop([svc], pingMap, evictMock, eventsPath, 10);
    const pingHandler = createPingEndpoint([svc], pingMap);

    // Let the first eviction happen
    await new Promise(r => setTimeout(r, 20));
    const countAfterFirstRun = evictMock.mock.calls.length;

    // Now ping the service to reset the clock
    pingMap.set("svc1", Date.now());

    // Wait for the next loop iteration
    await new Promise(r => setTimeout(r, 30));
    const countAfterPing = evictMock.mock.calls.length;

    loop.stop();

    // The eviction count should not increase after the ping
    expect(countAfterPing).toBe(countAfterFirstRun);
  });
});
