import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api";
import { loadRegistry } from "../src/registry";
import { appendEvent } from "../src/events";
import { clearLocks } from "../src/lifecycle";
import type { Registry, Service } from "../../../shared/types";

let tmpDir: string;
let registryPath: string;
let eventsPath: string;
let registry: Registry;

const SEED: Registry = {
  version: 2,
  type: "control",
  hosts: [
    { id: "h1", name: "host1", hostname: "h1.ts.net", role: "control" },
    { id: "h2", name: "host2", hostname: "h2.ts.net", role: "worker" },
  ],
  capabilities: [
    { id: "cap1", name: "Capability One" },
    { id: "cap2", name: "Capability Two" },
  ],
  services: [
    {
      id: "svc1",
      capabilityId: "cap1",
      hostId: "h1",
      permissions: { enabled: true },
      runner: { type: "systemd", unit: "svc1", unitFile: "ops/systemd/svc1.service" },
      network: { port: 9001, healthPath: "/health" },
    },
    {
      id: "svc2",
      capabilityId: "cap1",
      hostId: "h2",
      permissions: { enabled: false },
      runner: { type: "systemd", unit: "svc2", unitFile: "ops/systemd/svc2.service" },
      network: { port: 9002, healthPath: "/health" },
    },
    {
      id: "svc-protected",
      capabilityId: "cap1",
      hostId: "h1",
      permissions: { enabled: true, protected: true },
      runner: { type: "systemd", unit: "svc-protected", unitFile: "ops/systemd/svc-protected.service" },
      network: { port: 9003, healthPath: "/health" },
    },
    {
      id: "svc-cap2",
      capabilityId: "cap2",
      hostId: "h2",
      permissions: { enabled: true },
      runner: { type: "external" },
      network: { port: 9004, healthPath: "/health" },
    },
  ],
};

beforeEach(async () => {
  clearLocks();
  tmpDir = await mkdtemp(join(tmpdir(), "api-test-"));
  registryPath = join(tmpDir, "registry.json");
  eventsPath = join(tmpDir, "events.jsonl");
  await writeFile(registryPath, JSON.stringify(SEED, null, 2));
  registry = await loadRegistry(registryPath);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

type CheckFn = (service: Service, eventsPath: string, opts?: { bypassThreshold?: boolean }) => Promise<void>;
type RunFn = (cmd: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
type PollHealthFn = (url: string, timeoutMs: number) => Promise<boolean>;

function makeApp(opts: {
  checkService?: CheckFn;
  runFn?: RunFn;
  pollHealthFn?: PollHealthFn;
} = {}) {
  return createApp({
    registryState: registry,
    registryPath,
    eventsPath,
    checkService: opts.checkService ?? (async () => {}),
    runFn: opts.runFn ?? (async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    pollHealthFn: opts.pollHealthFn ?? (async () => true),
  });
}

function json(body: unknown, method = "POST") {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

// ---------------------------------------------------------------------------

describe("GET /api/health", () => {
  it("returns 200 with status ok and numeric uptime", async () => {
    const app = makeApp();
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; uptime: number };
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
  });
});

// ---------------------------------------------------------------------------

describe("GET /api/services", () => {
  it("returns all services with health and lastEvent fields", async () => {
    const app = makeApp();
    const res = await app.request("/api/services");
    expect(res.status).toBe(200);
    const services = await res.json() as Array<{ id: string; health: string; lastEvent: unknown }>;
    expect(services).toHaveLength(4);
    for (const svc of services) {
      expect("health" in svc).toBe(true);
      expect("lastEvent" in svc).toBe(true);
    }
  });

  it("disabled service appears with health 'disabled' regardless of event log", async () => {
    await appendEvent(eventsPath, {
      type: "service.up", subjectType: "service", subjectId: "svc2", data: {}, actor: "system",
    });
    const app = makeApp();
    const res = await app.request("/api/services");
    const services = await res.json() as Array<{ id: string; health: string }>;
    const svc2 = services.find(s => s.id === "svc2");
    expect(svc2?.health).toBe("disabled");
  });

  it("enabled service with no events appears with health 'unknown'", async () => {
    const app = makeApp();
    const res = await app.request("/api/services");
    const services = await res.json() as Array<{ id: string; health: string; lastEvent: unknown }>;
    const svc1 = services.find(s => s.id === "svc1");
    expect(svc1?.health).toBe("unknown");
    expect(svc1?.lastEvent).toBeNull();
  });

  it("enabled service with a service.up event appears with health 'healthy'", async () => {
    await appendEvent(eventsPath, {
      type: "service.up", subjectType: "service", subjectId: "svc1", data: { latencyMs: 10 }, actor: "system",
    });
    const app = makeApp();
    const res = await app.request("/api/services");
    const services = await res.json() as Array<{ id: string; health: string; lastEvent: unknown }>;
    const svc1 = services.find(s => s.id === "svc1");
    expect(svc1?.health).toBe("healthy");
    expect(svc1?.lastEvent).not.toBeNull();
  });

  it("?capability= filter returns only services with matching capabilityId", async () => {
    const app = makeApp();
    const res = await app.request("/api/services?capability=cap1");
    expect(res.status).toBe(200);
    const services = await res.json() as Array<{ id: string; capabilityId: string }>;
    expect(services.every(s => s.capabilityId === "cap1")).toBe(true);
    expect(services.map(s => s.id).sort()).toEqual(["svc-protected", "svc1", "svc2"]);
  });

  it("?capability= filter for cap2 returns only the cap2 service", async () => {
    const app = makeApp();
    const res = await app.request("/api/services?capability=cap2");
    expect(res.status).toBe(200);
    const services = await res.json() as Array<{ id: string }>;
    expect(services).toHaveLength(1);
    expect(services[0].id).toBe("svc-cap2");
  });

  it("?capability= filter for nonexistent capability returns empty array", async () => {
    const app = makeApp();
    const res = await app.request("/api/services?capability=does-not-exist");
    expect(res.status).toBe(200);
    const services = await res.json() as Array<unknown>;
    expect(services).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("GET /api/services/:id", () => {
  it("returns single service enriched with health and lastEvent", async () => {
    const app = makeApp();
    const res = await app.request("/api/services/svc1");
    expect(res.status).toBe(200);
    const svc = await res.json() as { id: string; health: string; lastEvent: unknown };
    expect(svc.id).toBe("svc1");
    expect("health" in svc).toBe(true);
    expect("lastEvent" in svc).toBe(true);
  });

  it("returns 404 with error message for nonexistent service ID", async () => {
    const app = makeApp();
    const res = await app.request("/api/services/does-not-exist");
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(typeof body.error).toBe("string");
  });
});

// ---------------------------------------------------------------------------

describe("GET /api/hosts", () => {
  it("returns all hosts from registry", async () => {
    const app = makeApp();
    const res = await app.request("/api/hosts");
    expect(res.status).toBe(200);
    const hosts = await res.json() as Array<{ id: string }>;
    expect(hosts).toHaveLength(2);
    expect(hosts.map(h => h.id).sort()).toEqual(["h1", "h2"]);
  });
});

// ---------------------------------------------------------------------------

describe("GET /api/capabilities", () => {
  it("returns all capabilities from registry", async () => {
    const app = makeApp();
    const res = await app.request("/api/capabilities");
    expect(res.status).toBe(200);
    const caps = await res.json() as Array<{ id: string }>;
    expect(caps).toHaveLength(2);
    expect(caps[0].id).toBe("cap1");
  });
});

// ---------------------------------------------------------------------------

describe("GET /api/events", () => {
  it("returns events newest-first", async () => {
    await appendEvent(eventsPath, { type: "service.up", subjectType: "service", subjectId: "svc1", data: {}, actor: "system" });
    await appendEvent(eventsPath, { type: "service.down", subjectType: "service", subjectId: "svc1", data: {}, actor: "system" });
    const app = makeApp();
    const res = await app.request("/api/events");
    const events = await res.json() as Array<{ type: string }>;
    expect(events[0].type).toBe("service.down");
    expect(events[1].type).toBe("service.up");
  });

  it("respects ?limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      await appendEvent(eventsPath, { type: "service.up", subjectType: "service", subjectId: "svc1", data: {}, actor: "system" });
    }
    const app = makeApp();
    const res = await app.request("/api/events?limit=3");
    const events = await res.json() as unknown[];
    expect(events).toHaveLength(3);
  });

  it("defaults to 50 when limit is not specified", async () => {
    for (let i = 0; i < 55; i++) {
      await appendEvent(eventsPath, { type: "service.up", subjectType: "service", subjectId: "svc1", data: {}, actor: "system" });
    }
    const app = makeApp();
    const res = await app.request("/api/events");
    const events = await res.json() as unknown[];
    expect(events).toHaveLength(50);
  });

  it("filters by ?subjectId when provided", async () => {
    await appendEvent(eventsPath, { type: "service.up", subjectType: "service", subjectId: "svc1", data: {}, actor: "system" });
    await appendEvent(eventsPath, { type: "service.up", subjectType: "service", subjectId: "svc2", data: {}, actor: "system" });
    const app = makeApp();
    const res = await app.request("/api/events?subjectId=svc1");
    const events = await res.json() as Array<{ subjectId: string }>;
    expect(events).toHaveLength(1);
    expect(events[0].subjectId).toBe("svc1");
  });
});

// ---------------------------------------------------------------------------

describe("POST /api/services/:id/check", () => {
  it("calls checkService with bypassThreshold:true and returns updated service with health", async () => {
    let capturedOpts: { bypassThreshold?: boolean } | undefined;
    const mockCheck: CheckFn = async (svc, path, opts) => {
      capturedOpts = opts;
      await appendEvent(path, { type: "service.up", subjectType: "service", subjectId: svc.id, data: { latencyMs: 5 }, actor: "system" });
    };
    const app = makeApp({ checkService: mockCheck });
    const res = await app.request("/api/services/svc1/check", { method: "POST" });
    expect(res.status).toBe(200);
    expect(capturedOpts?.bypassThreshold).toBe(true);
    const svc = await res.json() as { id: string; health: string };
    expect(svc.id).toBe("svc1");
    expect(svc.health).toBe("healthy");
  });

  it("returns 404 for nonexistent service", async () => {
    const app = makeApp();
    const res = await app.request("/api/services/does-not-exist/check", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------

describe("PATCH /api/services/:id", () => {
  it("updates service port and returns the updated service with re-derived endpoint", async () => {
    const app = makeApp();
    const res = await app.request("/api/services/svc1", json({ network: { port: 9999 } }, "PATCH"));
    expect(res.status).toBe(200);
    const svc = await res.json() as { id: string; network: { port: number; endpoint: string } };
    expect(svc.id).toBe("svc1");
    expect(svc.network.port).toBe(9999);
  });

  it("persists updated port to registry.json on disk and endpoint is re-derived on reload", async () => {
    const app = makeApp();
    await app.request("/api/services/svc1", json({ network: { port: 8080 } }, "PATCH"));
    const reloaded = await loadRegistry(registryPath);
    const svc = reloaded.services.find(s => s.id === "svc1");
    expect(svc?.network.port).toBe(8080);
    expect(svc?.network.endpoint).toBe("http://h1.ts.net:8080");
  });

  it("returns 404 for nonexistent service", async () => {
    const app = makeApp();
    const res = await app.request("/api/services/does-not-exist", json({ network: { port: 1234 } }, "PATCH"));
    expect(res.status).toBe(404);
  });

  it("returns 400 when patch contains unknown fields", async () => {
    const app = makeApp();
    const res = await app.request("/api/services/svc1", json({ unknownField: "bad" }, "PATCH"));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(typeof body.error).toBe("string");
  });
});

// ---------------------------------------------------------------------------

describe("PATCH /api/services/:id/enabled", () => {
  it("disables an enabled service and persists to registry.json", async () => {
    const app = makeApp();
    const res = await app.request("/api/services/svc1/enabled", json({ enabled: false }, "PATCH"));
    expect(res.status).toBe(200);
    const reloaded = await loadRegistry(registryPath);
    expect(reloaded.services.find(s => s.id === "svc1")?.permissions.enabled).toBe(false);
  });

  it("enables a disabled service and persists to registry.json", async () => {
    const app = makeApp();
    const res = await app.request("/api/services/svc2/enabled", json({ enabled: true }, "PATCH"));
    expect(res.status).toBe(200);
    const reloaded = await loadRegistry(registryPath);
    expect(reloaded.services.find(s => s.id === "svc2")?.permissions.enabled).toBe(true);
  });

  it("emits service.disabled event with actor:user when disabling", async () => {
    const app = makeApp();
    await app.request("/api/services/svc1/enabled", json({ enabled: false }, "PATCH"));
    const events = await import("../src/events").then(m => m.readEvents(eventsPath, { subjectId: "svc1" }));
    expect(events[0].type).toBe("service.disabled");
    expect(events[0].actor).toBe("user");
  });

  it("emits service.enabled event with actor:user when enabling", async () => {
    const app = makeApp();
    await app.request("/api/services/svc2/enabled", json({ enabled: true }, "PATCH"));
    const events = await import("../src/events").then(m => m.readEvents(eventsPath, { subjectId: "svc2" }));
    expect(events[0].type).toBe("service.enabled");
    expect(events[0].actor).toBe("user");
  });

  it("calls systemctl disable when disabling a systemd service", async () => {
    const cmds: string[][] = [];
    const app = makeApp({ runFn: async (cmd) => { cmds.push(cmd); return { stdout: "", stderr: "", exitCode: 0 }; } });
    await app.request("/api/services/svc1/enabled", json({ enabled: false }, "PATCH"));
    expect(cmds.some(c => c.includes("disable") && c.includes("svc1.service"))).toBe(true);
  });

  it("calls systemctl enable when enabling a systemd service", async () => {
    const cmds: string[][] = [];
    const app = makeApp({ runFn: async (cmd) => { cmds.push(cmd); return { stdout: "", stderr: "", exitCode: 0 }; } });
    await app.request("/api/services/svc2/enabled", json({ enabled: true }, "PATCH"));
    expect(cmds.some(c => c.includes("enable") && c.includes("svc2.service"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("POST /api/services/:id/start", () => {
  it("starts a systemd service by calling systemctl start", async () => {
    const cmds: string[][] = [];
    const app = makeApp({ runFn: async (cmd) => { cmds.push(cmd); return { stdout: "", stderr: "", exitCode: 0 }; } });
    const res = await app.request("/api/services/svc1/start", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);
    expect(cmds.some(c => c.includes("start") && c.includes("svc1.service"))).toBe(true);
  });

  it("returns 400 for a disabled service", async () => {
    const app = makeApp();
    const res = await app.request("/api/services/svc2/start", { method: "POST" });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("service is disabled");
  });

  it("returns 400 for an external service", async () => {
    const app = makeApp();
    const res = await app.request("/api/services/svc-cap2/start", { method: "POST" });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(typeof body.error).toBe("string");
  });

  it("returns 500 when start command fails", async () => {
    const app = makeApp({ runFn: async () => ({ stdout: "", stderr: "systemctl failed", exitCode: 1 }) });
    const res = await app.request("/api/services/svc1/start", { method: "POST" });
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(typeof body.error).toBe("string");
  });
});

describe("POST /api/services/:id/stop", () => {
  it("stops a systemd service by calling systemctl stop", async () => {
    const cmds: string[][] = [];
    const app = makeApp({ runFn: async (cmd) => { cmds.push(cmd); return { stdout: "", stderr: "", exitCode: 0 }; } });
    const res = await app.request("/api/services/svc1/stop", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);
    expect(cmds.some(c => c.includes("stop") && c.includes("svc1.service"))).toBe(true);
  });

  it("returns 400 for an external service", async () => {
    const app = makeApp();
    const res = await app.request("/api/services/svc-cap2/stop", { method: "POST" });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(typeof body.error).toBe("string");
  });

  it("completes stop even when the stop command exits non-zero (idempotent)", async () => {
    // stopService doesn't propagate runStopCmd failures — it's best-effort
    const app = makeApp({ runFn: async () => ({ stdout: "", stderr: "already stopped", exitCode: 1 }) });
    const res = await app.request("/api/services/svc1/stop", { method: "POST" });
    expect(res.status).toBe(200);
  });
});

describe("POST /api/services/:id/restart", () => {
  it("restarts a systemd service by calling systemctl restart", async () => {
    const cmds: string[][] = [];
    const app = makeApp({ runFn: async (cmd) => { cmds.push(cmd); return { stdout: "", stderr: "", exitCode: 0 }; } });
    const res = await app.request("/api/services/svc1/restart", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);
    expect(cmds.some(c => c.includes("restart") && c.includes("svc1.service"))).toBe(true);
  });

  it("returns 400 for an external service", async () => {
    const app = makeApp();
    const res = await app.request("/api/services/svc-cap2/restart", { method: "POST" });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(typeof body.error).toBe("string");
  });

  it("returns 500 when restart command fails", async () => {
    const app = makeApp({ runFn: async () => ({ stdout: "", stderr: "systemctl failed", exitCode: 1 }) });
    const res = await app.request("/api/services/svc1/restart", { method: "POST" });
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(typeof body.error).toBe("string");
  });
});

// ---------------------------------------------------------------------------

describe("Protected services", () => {
  it("POST /stop returns 403 for a protected service", async () => {
    const app = makeApp();
    const res = await app.request("/api/services/svc-protected/stop", { method: "POST" });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(typeof body.error).toBe("string");
  });

  it("PATCH /enabled with enabled:false returns 403 for a protected service", async () => {
    const app = makeApp();
    const res = await app.request("/api/services/svc-protected/enabled", json({ enabled: false }, "PATCH"));
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(typeof body.error).toBe("string");
  });

  it("POST /start succeeds for a protected service", async () => {
    const app = makeApp();
    const res = await app.request("/api/services/svc-protected/start", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("POST /restart succeeds for a protected service", async () => {
    const app = makeApp();
    const res = await app.request("/api/services/svc-protected/restart", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("PATCH /enabled with enabled:true succeeds for a protected service", async () => {
    const app = makeApp();
    const res = await app.request("/api/services/svc-protected/enabled", json({ enabled: true }, "PATCH"));
    expect(res.status).toBe(200);
  });

  it("POST /stop on a non-protected service still works normally", async () => {
    const app = makeApp();
    const res = await app.request("/api/services/svc1/stop", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("403 response body names the constraint", async () => {
    const app = makeApp();
    const res = await app.request("/api/services/svc-protected/stop", { method: "POST" });
    const body = await res.json() as { error: string };
    expect(body.error.toLowerCase()).toContain("protected");
  });
});
