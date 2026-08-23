import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, readEvents, deriveHealthMap, deriveHealth } from "../src/events";
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
  it("appends an event to an empty file", async () => {
    const evt = await appendEvent(eventsPath, { type: "service.up", subjectType: "service", subjectId: "svc1", data: {}, actor: "system" });
    expect(evt.id).toBeTruthy();
    expect(evt.timestamp).toBeTruthy();
    expect(evt.type).toBe("service.up");
  });

  it("appends multiple events and all are retrievable", async () => {
    await appendEvent(eventsPath, { type: "service.up", subjectType: "service", subjectId: "svc1", data: {}, actor: "system" });
    await appendEvent(eventsPath, { type: "service.down", subjectType: "service", subjectId: "svc1", data: {}, actor: "system" });
    const events = await readEvents(eventsPath, {});
    expect(events).toHaveLength(2);
  });

  it("creates the events file if it does not exist", async () => {
    const nonExistentPath = join(tmpDir, "subdir", "events.jsonl");
    await appendEvent(nonExistentPath, { type: "service.up", subjectType: "service", subjectId: "svc1", data: {}, actor: "system" });
    const events = await readEvents(nonExistentPath, {});
    expect(events).toHaveLength(1);
  });

  it("each event gets a unique ID and timestamp", async () => {
    const e1 = await appendEvent(eventsPath, { type: "service.up", subjectType: "service", subjectId: "svc1", data: {}, actor: "system" });
    const e2 = await appendEvent(eventsPath, { type: "service.up", subjectType: "service", subjectId: "svc1", data: {}, actor: "system" });
    expect(e1.id).not.toBe(e2.id);
  });

  it("event includes subjectType, subjectId, and actor fields", async () => {
    const evt = await appendEvent(eventsPath, { type: "service.up", subjectType: "service", subjectId: "svc1", data: {}, actor: "user" });
    expect(evt.subjectType).toBe("service");
    expect(evt.subjectId).toBe("svc1");
    expect(evt.actor).toBe("user");
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

  it("deriveHealthMap returns an empty map for nonexistent file", async () => {
    const map = await deriveHealthMap(join(tmpDir, "nonexistent.jsonl"));
    expect(map.size).toBe(0);
  });
});

describe("State derivation", () => {
  const makeEvent = (type: Event["type"]): Event => ({
    id: "test", timestamp: new Date().toISOString(), type, subjectType: "service", subjectId: "svc1", data: {}, actor: "system"
  });

  it("derives \"healthy\" when most recent event for a service is service.up", () => {
    expect(deriveHealth(makeEvent("service.up"))).toBe("healthy");
  });

  it("derives \"down\" when most recent event is service.down", () => {
    expect(deriveHealth(makeEvent("service.down"))).toBe("down");
  });

  it("derives \"timed_out\" when most recent event is service.timed_out", () => {
    expect(deriveHealth(makeEvent("service.timed_out"))).toBe("timed_out");
  });

  it("derives \"disabled\" when most recent event is service.disabled", () => {
    expect(deriveHealth(makeEvent("service.disabled"))).toBe("disabled");
  });

  it("returns \"unknown\" for a service with no events", () => {
    expect(deriveHealth(null)).toBe("unknown");
  });

  it("derives \"unknown\" when most recent event is service.enabled", () => {
    expect(deriveHealth(makeEvent("service.enabled"))).toBe("unknown");
  });

  it("derives \"unknown\" when most recent event is service.restarted", () => {
    expect(deriveHealth(makeEvent("service.restarted"))).toBe("unknown");
  });

  it("derives \"unknown\" when most recent event is service.started", () => {
    expect(deriveHealth(makeEvent("service.started"))).toBe("unknown");
  });

  it("derives \"down\" when most recent event is service.stopped", () => {
    expect(deriveHealth(makeEvent("service.stopped"))).toBe("down");
  });

  it("derives \"unknown\" when most recent event is service.installed", () => {
    expect(deriveHealth(makeEvent("service.installed"))).toBe("unknown");
  });

  it("derives \"down\" when most recent event is service.uninstalled", () => {
    expect(deriveHealth(makeEvent("service.uninstalled"))).toBe("down");
  });

  it("ignores older events — only the most recent matters", async () => {
    await appendEvent(eventsPath, { type: "service.down", subjectType: "service", subjectId: "svc1", data: {}, actor: "system" });
    await appendEvent(eventsPath, { type: "service.up", subjectType: "service", subjectId: "svc1", data: {}, actor: "system" });
    const map = await deriveHealthMap(eventsPath);
    expect(deriveHealth(map.get("svc1") ?? null)).toBe("healthy");
  });

  it("derives state independently per service (service A down doesn't affect service B)", async () => {
    await appendEvent(eventsPath, { type: "service.down", subjectType: "service", subjectId: "svcA", data: {}, actor: "system" });
    await appendEvent(eventsPath, { type: "service.up", subjectType: "service", subjectId: "svcB", data: {}, actor: "system" });
    const map = await deriveHealthMap(eventsPath);
    expect(deriveHealth(map.get("svcA") ?? null)).toBe("down");
    expect(deriveHealth(map.get("svcB") ?? null)).toBe("healthy");
  });
});
