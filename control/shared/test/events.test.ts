import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, readEvents, deriveHealthMap, deriveHealth, deriveServiceHealth } from "../src/events";
import type { Event } from "../../../shared/types";

let tmpDir: string;
let eventsPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "events-test-"));
  eventsPath = join(tmpDir, "events.jsonl");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("Event log writer", () => {
  it("appends events with a unique id, a timestamp and the fields given, creating the file and its directory", async () => {
    const path = join(tmpDir, "subdir", "events.jsonl");
    const e1 = await appendEvent(path, { type: "service.up", subjectType: "service", subjectId: "svc1", data: { latencyMs: 3 }, actor: "user" });
    const e2 = await appendEvent(path, { type: "service.down", subjectType: "service", subjectId: "svc1", data: {}, actor: "system" });

    expect(e1).toMatchObject({ type: "service.up", subjectType: "service", subjectId: "svc1", data: { latencyMs: 3 }, actor: "user" });
    expect(Number.isNaN(Date.parse(e1.timestamp))).toBe(false);
    expect(e1.id).not.toBe(e2.id);
    expect((await readEvents(path)).map(e => e.id)).toEqual([e2.id, e1.id]);
  });
});

describe("Event log reader", () => {
  it("returns events newest-first", async () => {
    await appendEvent(eventsPath, { type: "service.up", subjectType: "service", subjectId: "svc1", data: { order: 1 }, actor: "system" });
    await appendEvent(eventsPath, { type: "service.down", subjectType: "service", subjectId: "svc1", data: { order: 2 }, actor: "system" });
    const events = await readEvents(eventsPath, {});
    expect((events[0].data as Record<string, unknown>).order).toBe(2);
    expect((events[1].data as Record<string, unknown>).order).toBe(1);
  });

  it("respects the limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      await appendEvent(eventsPath, { type: "service.up", subjectType: "service", subjectId: "svc1", data: {}, actor: "system" });
    }
    const events = await readEvents(eventsPath, { limit: 3 });
    expect(events).toHaveLength(3);
  });

  it("returns empty array for nonexistent file", async () => {
    const events = await readEvents(join(tmpDir, "nonexistent.jsonl"), {});
    expect(events).toHaveLength(0);
  });

  it("filters events by subjectId when requested", async () => {
    await appendEvent(eventsPath, { type: "service.up", subjectType: "service", subjectId: "svc1", data: {}, actor: "system" });
    await appendEvent(eventsPath, { type: "service.up", subjectType: "service", subjectId: "svc2", data: {}, actor: "system" });
    const events = await readEvents(eventsPath, { subjectId: "svc1" });
    expect(events).toHaveLength(1);
    expect(events[0].subjectId).toBe("svc1");
  });

  it("reads a log longer than one read chunk whole and in order", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 2000; i++) {
      lines.push(JSON.stringify({ id: `e${i}`, timestamp: "t", type: "service.up", subjectType: "service", subjectId: i % 2 ? "odd" : "even", data: { i, pad: "é".repeat(40) }, actor: "system" }));
    }
    await writeFile(eventsPath, lines.join("\n") + "\n");
    const all = await readEvents(eventsPath, { limit: Number.MAX_SAFE_INTEGER });
    expect(all.map(e => (e.data as { i: number }).i)).toEqual([...Array(2000).keys()].reverse());
    const odd = await readEvents(eventsPath, { subjectId: "odd", limit: 3 });
    expect(odd.map(e => (e.data as { i: number }).i)).toEqual([1999, 1997, 1995]);
  });
});

describe("Health map derivation", () => {
  it("deriveHealthMap returns a map of subjectId → most recent event", async () => {
    await appendEvent(eventsPath, { type: "service.up", subjectType: "service", subjectId: "svc1", data: {}, actor: "system" });
    await appendEvent(eventsPath, { type: "service.down", subjectType: "service", subjectId: "svc1", data: {}, actor: "system" });
    const map = await deriveHealthMap(eventsPath);
    expect(map.get("svc1")?.type).toBe("service.down");
  });

  it("deriveHealthMap includes all services in the file", async () => {
    await appendEvent(eventsPath, { type: "service.up", subjectType: "service", subjectId: "svc1", data: {}, actor: "system" });
    await appendEvent(eventsPath, { type: "service.up", subjectType: "service", subjectId: "svc2", data: {}, actor: "system" });
    const map = await deriveHealthMap(eventsPath);
    expect(map.size).toBe(2);
  });

  it("an install is a record, not a health signal: a stopped service stays down after one", async () => {
    await appendEvent(eventsPath, { type: "service.stopped", subjectType: "service", subjectId: "svc1", data: {}, actor: "system" });
    await appendEvent(eventsPath, { type: "service.installed", subjectType: "service", subjectId: "svc1", data: { commit: "abc" }, actor: "user" });
    const map = await deriveHealthMap(eventsPath);
    expect(map.get("svc1")?.type).toBe("service.stopped");
  });

  it("an event after an install still decides health", async () => {
    await appendEvent(eventsPath, { type: "service.installed", subjectType: "service", subjectId: "svc1", data: { commit: "abc" }, actor: "user" });
    await appendEvent(eventsPath, { type: "service.up", subjectType: "service", subjectId: "svc1", data: {}, actor: "system" });
    const map = await deriveHealthMap(eventsPath);
    expect(map.get("svc1")?.type).toBe("service.up");
  });

  it("deriveHealthMap returns an empty map for nonexistent file", async () => {
    const map = await deriveHealthMap(join(tmpDir, "nonexistent.jsonl"));
    expect(map.size).toBe(0);
  });

  it("sees events appended after an earlier derivation", async () => {
    await appendEvent(eventsPath, { type: "service.up", subjectType: "service", subjectId: "svc1", data: {}, actor: "system" });
    await deriveHealthMap(eventsPath);
    await appendEvent(eventsPath, { type: "service.down", subjectType: "service", subjectId: "svc1", data: {}, actor: "system" });
    await appendEvent(eventsPath, { type: "service.up", subjectType: "service", subjectId: "svc2", data: {}, actor: "system" });
    const map = await deriveHealthMap(eventsPath);
    expect(map.get("svc1")?.type).toBe("service.down");
    expect(map.get("svc2")?.type).toBe("service.up");
  });

  it("forgets what a replaced or truncated file no longer holds", async () => {
    await appendEvent(eventsPath, { type: "service.down", subjectType: "service", subjectId: "svc1", data: {}, actor: "system" });
    await appendEvent(eventsPath, { type: "service.down", subjectType: "service", subjectId: "svc2", data: {}, actor: "system" });
    await deriveHealthMap(eventsPath);
    await writeFile(eventsPath, "");
    await appendEvent(eventsPath, { type: "service.up", subjectType: "service", subjectId: "svc1", data: {}, actor: "system" });
    const map = await deriveHealthMap(eventsPath);
    expect(map.get("svc1")?.type).toBe("service.up");
    expect(map.has("svc2")).toBe(false);
  });
});

describe("State derivation", () => {
  const event = (type: Event["type"]): Event => ({
    id: "test", timestamp: new Date().toISOString(), type, subjectType: "service", subjectId: "svc1", data: {}, actor: "system"
  });

  it.each([
    ["service.up", "healthy"],
    ["service.degraded", "degraded"],
    ["service.down", "down"],
    ["service.stopped", "down"],
    ["service.unloaded", "down"],
    ["service.uninstalled", "down"],
    ["memory.pressure", "down"],
    ["service.timed_out", "timed_out"],
    ["service.disabled", "disabled"],
    ["service.enabled", "unknown"],
    ["service.started", "unknown"],
    ["service.restarted", "unknown"],
    ["service.installed", "unknown"],
    ["tailscale.serve_failed", "unknown"],
  ] as [Event["type"], string][])("derives %s as %s", (type, health) => {
    expect<string>(deriveHealth(event(type))).toBe(health);
  });

  it("derives unknown for a service with no events", () => {
    expect(deriveHealth(null)).toBe("unknown");
  });

  it("takes each service's most recent event, independently of the others", async () => {
    for (const [subjectId, type] of [["svcA", "service.up"], ["svcA", "service.down"], ["svcB", "service.down"], ["svcB", "service.up"]] as const) {
      await appendEvent(eventsPath, { type, subjectType: "service", subjectId, data: {}, actor: "system" });
    }
    const map = await deriveHealthMap(eventsPath);
    expect(deriveHealth(map.get("svcA") ?? null)).toBe("down");
    expect(deriveHealth(map.get("svcB") ?? null)).toBe("healthy");
  });
});

describe("Service health as reported", () => {
  const svc = (overrides: Record<string, unknown> = {}) => ({
    id: "s1", capabilityId: "c", hostId: "h", permissions: { enabled: true },
    network: { port: 1, healthPath: "/h" }, ...overrides,
  }) as never;
  const demand = { lifecycle: { loadStrategy: "demand" } };
  const add = (type: "service.started" | "service.stopped" | "service.down" | "service.up") =>
    appendEvent(eventsPath, { type, subjectType: "service", subjectId: "s1", data: {}, actor: "system" });
  const healthNow = async (overrides: Record<string, unknown> = {}) =>
    (await deriveServiceHealth(eventsPath))(svc(overrides)).health;

  it("reads a demand service that was never started as off", async () => {
    expect(await healthNow(demand)).toBe("off");
  });

  it("reads a started service that stopped answering as down, and a stopped one as off", async () => {
    await add("service.started");
    await add("service.down");
    expect(await healthNow(demand)).toBe("down");
    await add("service.stopped");
    expect(await healthNow(demand)).toBe("off");
    expect(await healthNow()).toBe("off");
  });

  it("reads an always-on service with no run intent from its last health event", async () => {
    await add("service.up");
    expect(await healthNow()).toBe("healthy");
  });

  it("shows a demand service found answering without a recorded start as what it is", async () => {
    await add("service.up");
    expect(await healthNow(demand)).toBe("healthy");
  });

  it("reads a disabled service as disabled whatever its log says", async () => {
    await add("service.started");
    expect(await healthNow({ permissions: { enabled: false } })).toBe("disabled");
  });
});
