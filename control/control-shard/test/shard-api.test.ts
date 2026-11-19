// The routes only a shard serves: /status, demand-loaded start and stop, the
// roster, and registry reload. Promises: docs/reference/components/control-shard.md, "Additional
// HTTP endpoints". The ping route is tested with idle eviction in idle.test.ts.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShardApp } from "../src/shard-api";
import { loadRegistry } from "../../shared/src/registry";
import { appendEvent } from "../../shared/src/events";
import { clearFileLocks } from "../../shared/src/atomic-write";
import type { Registry, Service } from "../../../shared/types";

type Outcome = { ok: boolean; error?: string };

let tmpDir: string;
let registryPath: string;
let eventsPath: string;
let registry: Registry;

const service = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  capabilityId: "tts",
  hostId: "gpu-machine",
  permissions: { enabled: true },
  runner: { type: "process", main: ".venv/bin/server" },
  network: { port: 8000, healthPath: "/health" },
  lifecycle: { loadStrategy: "demand" },
  ...over,
});

function doc(modelName = "Model A") {
  return {
    version: 2,
    type: "shard",
    hosts: [{ id: "gpu-machine", name: "gpu-machine", hostname: "gpu-machine.example.ts.net", role: "worker" }],
    capabilities: [{ id: "tts", name: "TTS" }],
    services: [
      service("demand"),
      service("off", { permissions: { enabled: false } }),
      service("always", { lifecycle: { loadStrategy: "startup" } }),
    ],
    roster: { providers: { demand: { ttsModels: [{ id: "model-a", name: modelName, key: "model-a" }] } }, voices: [] },
  };
}

beforeEach(async () => {
  clearFileLocks();
  tmpDir = await mkdtemp(join(tmpdir(), "shard-api-"));
  registryPath = join(tmpDir, "registry.json");
  eventsPath = join(tmpDir, "events.jsonl");
  await writeFile(registryPath, JSON.stringify(doc()));
  registry = await loadRegistry(registryPath);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function shardApp(opts: {
  loadService?: (svc: Service) => Promise<Outcome>;
  unloadService?: (svc: Service) => Promise<Outcome>;
  pingMap?: Map<string, number>;
  registryPath?: string | "none";
  sharedLifecycle?: (req: Request) => Response | Promise<Response>;
} = {}) {
  return createShardApp({
    registryState: registry,
    eventsPath,
    getFreeMem: async () => 4096,
    loadService: opts.loadService ?? (async () => ({ ok: true })),
    unloadService: opts.unloadService ?? (async () => ({ ok: true })),
    sharedLifecycle: opts.sharedLifecycle ?? (async () => Response.json({ success: true })),
    pingMap: opts.pingMap,
    registryPath: opts.registryPath === "none" ? undefined : registryPath,
  });
}

async function call(app: ReturnType<typeof shardApp>, method: string, path: string) {
  const res = await app.fetch(new Request(`http://localhost${path}`, { method }));
  return { status: res.status, body: await res.json() as any };
}

describe("GET /status", () => {
  it("reports free memory, and each service's health and last ping, null until pinged", async () => {
    await appendEvent(eventsPath, { type: "service.up", subjectType: "service", subjectId: "demand", data: {}, actor: "system" });
    const app = shardApp({ pingMap: new Map([["demand", 1234]]) });

    expect((await call(app, "GET", "/status")).body).toEqual({
      freeMem: 4096,
      services: {
        demand: { health: "healthy", lastPing: 1234 },
        off: { health: "disabled", lastPing: null },
        always: { health: "unknown", lastPing: null },
      },
    });
  });
});

describe("starting and stopping", () => {
  it.each([
    ["start", "nope", 404],
    ["start", "off", 400],
    ["stop", "nope", 404],
  ])("refuses to %s %s with %i", async (action, id, status) => {
    let called = false;
    const touch = async () => { called = true; return { ok: true }; };
    const app = shardApp({ loadService: touch, unloadService: touch, sharedLifecycle: async () => { called = true; return Response.json({}); } });

    expect((await call(app, "POST", `/api/services/${id}/${action}`)).status).toBe(status);
    expect(called).toBe(false);
  });

  it.each(["start", "stop"])("hands a %s of a service that is not demand-loaded to the shared lifecycle", async (action) => {
    const seen: string[] = [];
    let demandCalled = false;
    const touch = async () => { demandCalled = true; return { ok: true }; };
    const app = shardApp({
      loadService: touch,
      unloadService: touch,
      sharedLifecycle: async (req) => { seen.push(new URL(req.url).pathname); return Response.json({ success: true }); },
    });

    const res = await call(app, "POST", `/api/services/always/${action}`);
    expect(res).toEqual({ status: 200, body: { success: true } });
    expect(seen).toEqual([`/api/services/always/${action}`]);
    expect(demandCalled).toBe(false);
  });

  it("answers a start with 202 as soon as the load begins, whatever the load later does", async () => {
    let fail!: (err: Error) => void;
    const loading: string[] = [];
    const app = shardApp({ loadService: svc => { loading.push(svc.id); return new Promise((_, reject) => { fail = reject; }); } });

    expect((await call(app, "POST", "/api/services/demand/start")).status).toBe(202);
    expect(loading).toEqual(["demand"]);
    fail(new Error("load failed"));
  });

  it.each([
    [{ ok: true }, 200],
    [{ ok: false, error: "unload failed" }, 500],
  ] as [Outcome, number][])("waits for the unload and answers a stop that ends %j with %i", async (outcome, status) => {
    const app = shardApp({ unloadService: async () => outcome });
    const res = await call(app, "POST", "/api/services/demand/stop");
    expect(res.status).toBe(status);
    if (outcome.error) expect(res.body.error).toBe(outcome.error);
  });
});

describe("the roster and reload", () => {
  it("serves the roster as reloaded, with a warning naming the provider that changed", async () => {
    const app = shardApp();
    await writeFile(registryPath, JSON.stringify(doc("Model A v2")));

    const reload = await call(app, "POST", "/api/config/reload");
    expect(reload.status).toBe(200);
    expect(reload.body.registry).toEqual({ ok: true });
    expect(reload.body.warnings).toContainEqual(expect.objectContaining({ kind: "provider-changed", serviceId: "demand" }));
    expect((await call(app, "GET", "/api/roster")).body.providers.demand.ttsModels[0].name).toBe("Model A v2");
  });

  it.each([
    ["a file that is not JSON", "{ not json", undefined],
    ["no registry path", undefined, "none"],
  ] as [string, string | undefined, "none" | undefined][])("answers 500 with the error for %s", async (_, contents, path) => {
    if (contents !== undefined) await writeFile(registryPath, contents);
    const res = await call(shardApp({ registryPath: path }), "POST", "/api/config/reload");

    expect(res.status).toBe(500);
    expect(res.body.registry.ok).toBe(false);
    expect(res.body.registry.error).toBeTruthy();
  });
});
