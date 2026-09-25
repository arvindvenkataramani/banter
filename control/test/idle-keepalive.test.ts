import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startIdleLoop } from "../control-shard/src/idle";
import type { Service } from "../../shared/types";

// Keeping a demand-loaded service alive is a statement about activity: the
// caller pings while it is using the service, and the idle loop evicts on time
// since the last ping. `idleUnload` stays as declared — it is the policy, not a
// place to record that a session is in progress.

let tmpDir: string;
let eventsPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "idle-keepalive-"));
  eventsPath = join(tmpDir, "events.jsonl");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** A demand-loaded service, loaded ten seconds ago. */
function loadedService(id: string, idleTimeout: number): Service {
  return {
    id,
    capabilityId: "stt",
    hostId: "gpu-machine",
    permissions: { enabled: true },
    network: { port: 8767, healthPath: "/healthz" },
    lifecycle: { loadStrategy: "demand", idleUnload: true, idleTimeout },
    state: { loadTime: Date.now() - 10_000 },
  } as unknown as Service;
}

/** Mirrors the eviction in control-shard/src/index.ts, which clears loadTime
 * so an evicted service is no longer a candidate. Without that, a stopped
 * service is evicted again on every pass. */
function collectEvictions(into: string[]) {
  return async (svc: Service) => {
    into.push(svc.id);
    svc.state = { ...svc.state, loadTime: undefined };
  };
}

describe("idle keepalive", () => {
  it("evicts a loaded service once its idleTimeout passes with no ping", async () => {
    const evicted: string[] = [];
    const svc = loadedService("stt-fluid", 5_000);   // idle 10s, timeout 5s
    const loop = startIdleLoop([svc], new Map(), collectEvictions(evicted), eventsPath, 20);

    await new Promise(r => setTimeout(r, 80));
    loop.stop();

    expect(evicted).toEqual(["stt-fluid"]);
  });

  it("does not evict while pings keep arriving", async () => {
    const evicted: string[] = [];
    const pingMap = new Map<string, number>();
    const svc = loadedService("stt-fluid", 5_000);
    pingMap.set("stt-fluid", Date.now());
    const loop = startIdleLoop([svc], pingMap, collectEvictions(evicted), eventsPath, 20);
    const heartbeat = setInterval(() => pingMap.set("stt-fluid", Date.now()), 20);

    await new Promise(r => setTimeout(r, 120));
    clearInterval(heartbeat);
    loop.stop();

    expect(evicted).toEqual([]);
  });

  it("evicts once the pings stop", async () => {
    const evicted: string[] = [];
    const pingMap = new Map<string, number>();
    const svc = loadedService("stt-fluid", 50);
    pingMap.set("stt-fluid", Date.now());
    const loop = startIdleLoop([svc], pingMap, collectEvictions(evicted), eventsPath, 20);

    await new Promise(r => setTimeout(r, 40));
    expect(evicted).toEqual([]);                     // still held

    await new Promise(r => setTimeout(r, 140));      // heartbeat stopped
    loop.stop();

    expect(evicted).toEqual(["stt-fluid"]);
  });

  // The declared policy still decides. A service configured never to idle out
  // is not evictable whether or not anything is pinging it.
  it("leaves an idleUnload:false service alone regardless of pings", async () => {
    const evicted: string[] = [];
    const svc = loadedService("pinned", 5_000);
    svc.lifecycle!.idleUnload = false;
    const loop = startIdleLoop([svc], new Map(), collectEvictions(evicted), eventsPath, 20);

    await new Promise(r => setTimeout(r, 80));
    loop.stop();

    expect(evicted).toEqual([]);
  });
});
