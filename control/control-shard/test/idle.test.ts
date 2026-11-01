// Idle eviction on the shard: which loaded services the loop unloads, and the
// ping route that keeps a service in use.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvents } from "../../shared/src/events";
import { startIdleLoop } from "../src/idle";
import { createShardApp } from "../src/shard-api";
import type { Service } from "../../../shared/types";

let tmpDir: string;
let eventsPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "idle-test-"));
  eventsPath = join(tmpDir, "events.jsonl");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const TIMEOUT = 5000;

function service(id: string, loadedAgo: number | null, idleUnload: boolean | "unset" = true): Service {
  return {
    id,
    capabilityId: "cap",
    hostId: "host",
    permissions: { enabled: true },
    network: { port: 8080, healthPath: "/health", endpoint: "http://localhost:8080" },
    lifecycle: { ...(idleUnload !== "unset" && { idleUnload }), idleTimeout: TIMEOUT },
    ...(loadedAgo !== null && { state: { loadTime: Date.now() - loadedAgo } }),
  } as Service;
}

/** Runs the loop for a few ticks; eviction clears loadTime the way unloading does. */
async function runLoop(services: Service[], pings: Map<string, number>, ms = 50, stopFirst = false): Promise<string[]> {
  const evicted: string[] = [];
  const loop = startIdleLoop(services, pings, async (svc) => {
    evicted.push(svc.id);
    svc.state = { ...svc.state, loadTime: undefined };
  }, eventsPath, 10);
  if (stopFirst) await loop.stop();
  await new Promise(r => setTimeout(r, ms));
  await loop.stop();
  return evicted;
}

describe("the eviction loop", () => {
  it("unloads a loaded service idle past its timeout, counting from its last ping or, failing that, its load", async () => {
    const now = Date.now();
    const services = [
      service("pinged-long-ago", 20000),
      service("pinged-recently", 20000),
      service("never-pinged", 10000),
      service("pinged-before-this-load", 1000),
      service("not-loaded", null),
      service("idle-unload-off", 20000, false),
      service("idle-unload-unset", 20000, "unset"),
    ];
    const pings = new Map([
      ["pinged-long-ago", now - 10000],
      ["pinged-recently", now - 1000],
      ["pinged-before-this-load", now - 60000],
      ["idle-unload-off", now - 10000],
    ]);

    expect((await runLoop(services, pings)).sort()).toEqual(["never-pinged", "pinged-long-ago"]);
    const unloaded = (await readEvents(eventsPath)).filter(e => e.type === "service.unloaded");
    expect(unloaded.map(e => e.subjectId).sort()).toEqual(["never-pinged", "pinged-long-ago"]);
  });

  it("evicts nothing once stopped", async () => {
    expect(await runLoop([service("idle", 20000)], new Map(), 50, true)).toEqual([]);
  });
});

describe("POST /ping/:service", () => {
  it("answers 404 for an unknown service, and records a known one so the loop keeps it", async () => {
    const svc = service("svc1", 10000);
    const pings = new Map<string, number>();
    const app = createShardApp({
      registryState: { version: 2, type: "shard", hosts: [], capabilities: [], services: [svc] },
      eventsPath,
      getFreeMem: async () => 0,
      loadService: async () => ({ ok: true }),
      unloadService: async () => ({ ok: true }),
      pingMap: pings,
    } as any);

    expect((await app.fetch(new Request("http://localhost/ping/nope", { method: "POST" }))).status).toBe(404);
    expect((await app.fetch(new Request("http://localhost/ping/svc1", { method: "POST" }))).status).toBe(200);
    expect(await runLoop([svc], pings, 30)).toEqual([]);
  });
});
