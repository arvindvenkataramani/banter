// The REST API every node serves for its own registry: what it reports about a
// service, and which requests it refuses. The lifecycle commands behind start,
// stop and restart are tested in lifecycle.test.ts; registry writes in
// registry.test.ts.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api";
import { loadRegistry } from "../src/registry";
import { appendEvent, readEvents } from "../src/events";
import { clearLocks } from "../src/lifecycle";
import { submit, clearExecutor } from "../src/executor";
import type { Registry, Service } from "../../../shared/types";

type RunFn = (cmd: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
type CheckFn = (service: Service, eventsPath: string, opts?: { bypassThreshold?: boolean }) => Promise<void>;

let tmpDir: string;
let registryPath: string;
let eventsPath: string;
let registry: Registry;

const systemd = (unit: string) => ({ type: "systemd", unit, unitFile: `ops/systemd/${unit}.service` });

const SEED = {
  version: 2,
  type: "control",
  hosts: [{ id: "h1", name: "host1", hostname: "h1.ts.net", role: "control" }],
  capabilities: [{ id: "tts", name: "TTS" }, { id: "llm", name: "LLM" }],
  services: [
    { id: "svc", capabilityId: "tts", hostId: "h1", permissions: { enabled: true }, runner: systemd("svc"), network: { port: 9001, healthPath: "/health" } },
    { id: "off", capabilityId: "tts", hostId: "h1", permissions: { enabled: false }, runner: systemd("off"), network: { port: 9002, healthPath: "/health" } },
    { id: "guarded", capabilityId: "tts", hostId: "h1", permissions: { enabled: true, protected: true }, runner: systemd("guarded"), network: { port: 9003, healthPath: "/health" } },
    { id: "outside", capabilityId: "llm", hostId: "h1", permissions: { enabled: true }, runner: { type: "external" }, network: { port: 9004, healthPath: "/health" } },
  ],
};

beforeEach(async () => {
  clearLocks();
  clearExecutor();
  tmpDir = await mkdtemp(join(tmpdir(), "api-test-"));
  registryPath = join(tmpDir, "registry.json");
  eventsPath = join(tmpDir, "events.jsonl");
  await writeFile(registryPath, JSON.stringify(SEED, null, 2));
  registry = await loadRegistry(registryPath);
});

afterEach(async () => {
  clearExecutor();
  await rm(tmpDir, { recursive: true, force: true });
});

const ok: RunFn = async () => ({ stdout: "", stderr: "", exitCode: 0 });
const fails: RunFn = async () => ({ stdout: "", stderr: "unit failed", exitCode: 1 });

function makeApp(opts: { runFn?: RunFn; checkService?: CheckFn; registryPath?: string } = {}) {
  return createApp({
    registryState: registry,
    registryPath: opts.registryPath ?? registryPath,
    eventsPath,
    checkService: opts.checkService ?? (async () => {}),
    runFn: opts.runFn ?? ok,
    pollHealthFn: async () => true,
  });
}

async function call(app: ReturnType<typeof makeApp>, method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    ...(body !== undefined && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() as any };
}

const up = (subjectId: string) =>
  appendEvent(eventsPath, { type: "service.up", subjectType: "service", subjectId, data: {}, actor: "system" });

describe("reading services", () => {
  it("answers /api/health with ok", async () => {
    expect((await call(makeApp(), "GET", "/api/health")).body.status).toBe("ok");
  });

  it("reports each service with its derived health, last event and pending flag, in the list and alone", async () => {
    await up("svc");
    let finish!: () => void;
    const running = submit("svc", "start", () => new Promise<{ ok: boolean }>(r => { finish = () => r({ ok: true }); }));
    const app = makeApp();

    const list = (await call(app, "GET", "/api/services")).body as { id: string; health: string; lastEvent: unknown; pending: boolean }[];
    const svc = list.find(s => s.id === "svc")!;
    expect(svc).toMatchObject({ health: "healthy", pending: true });
    expect(svc.lastEvent).toMatchObject({ type: "service.up" });
    expect((await call(app, "GET", "/api/services/svc")).body).toMatchObject({ health: "healthy", pending: true });
    expect(list.find(s => s.id === "outside")!.pending).toBe(false);

    finish();
    await running;
  });

  it("reports a disabled service as disabled, whatever its events say", async () => {
    await up("off");
    expect((await call(makeApp(), "GET", "/api/services/off")).body.health).toBe("disabled");
  });

  it.each([
    ["tts", ["svc", "off", "guarded"]],
    ["llm", ["outside"]],
    ["none", []],
  ])("filters the list by ?capability=%s", async (capability, expected) => {
    const list = (await call(makeApp(), "GET", `/api/services?capability=${capability}`)).body as { id: string }[];
    expect(list.map(s => s.id)).toEqual(expected);
  });

  it("returns events newest first, fifty unless ?limit says otherwise, filtered by ?subjectId", async () => {
    for (let i = 0; i < 55; i++) await up(i % 5 === 0 ? "off" : "svc");
    const app = makeApp();
    const all = (await call(app, "GET", "/api/events")).body as { timestamp: string; subjectId: string }[];

    expect(all).toHaveLength(50);
    expect(all.map(e => e.timestamp)).toEqual(all.map(e => e.timestamp).sort().reverse());
    expect((await call(app, "GET", "/api/events?limit=3")).body).toHaveLength(3);
    const off = (await call(app, "GET", "/api/events?subjectId=off")).body as { subjectId: string }[];
    expect(off).toHaveLength(11);
    expect(off.every(e => e.subjectId === "off")).toBe(true);
  });

  it("checks a service at once, past the failure threshold, and answers with the health that results", async () => {
    let opts: { bypassThreshold?: boolean } | undefined;
    const app = makeApp({ checkService: async (svc, _path, o) => { opts = o; await up(svc.id); } });

    expect((await call(app, "POST", "/api/services/svc/check")).body.health).toBe("healthy");
    expect(opts?.bypassThreshold).toBe(true);
  });
});

describe("refusals", () => {
  it.each([
    ["GET", "/api/services/nope"],
    ["POST", "/api/services/nope/check"],
    ["POST", "/api/services/nope/start"],
    ["POST", "/api/services/nope/stop"],
    ["POST", "/api/services/nope/restart"],
    ["PATCH", "/api/services/nope"],
    ["PATCH", "/api/services/nope/enabled"],
  ])("%s %s is 404 for an unknown service", async (method, path) => {
    expect((await call(makeApp(), method, path, method === "PATCH" ? { enabled: true } : undefined)).status).toBe(404);
  });

  it.each([
    ["starting a disabled service", "POST", "/api/services/off/start", undefined, 400],
    ["starting an external service", "POST", "/api/services/outside/start", undefined, 400],
    ["stopping an external service", "POST", "/api/services/outside/stop", undefined, 400],
    ["restarting an external service", "POST", "/api/services/outside/restart", undefined, 400],
    ["stopping a protected service", "POST", "/api/services/guarded/stop", undefined, 403],
    ["disabling a protected service", "PATCH", "/api/services/guarded/enabled", { enabled: false }, 403],
    ["a patch with an unknown field", "PATCH", "/api/services/svc", { unknownField: 1 }, 400],
  ])("refuses %s", async (_, method, path, body, status) => {
    expect((await call(makeApp(), method, path, body)).status).toBe(status);
  });

  it("names the protection when refusing a protected service", async () => {
    expect((await call(makeApp(), "POST", "/api/services/guarded/stop")).body.error).toContain("protected");
  });

  it.each([
    ["start", "POST", "/api/services/guarded/start", undefined],
    ["restart", "POST", "/api/services/guarded/restart", undefined],
    ["enable", "PATCH", "/api/services/guarded/enabled", { enabled: true }],
  ])("lets a protected service %s", async (_, method, path, body) => {
    expect((await call(makeApp(), method, path, body)).status).toBe(200);
  });

  it.each(["start", "restart"])("is 500 with the error when %s fails", async (action) => {
    const res = await call(makeApp({ runFn: fails }), "POST", `/api/services/svc/${action}`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBeTruthy();
  });

  it("is 500, not 400, when a patch is valid but the registry cannot be written", async () => {
    const app = makeApp({ registryPath: join(tmpDir, "no-such-dir", "registry.json") });
    expect((await call(app, "PATCH", "/api/services/svc", { network: { port: 9999 } })).status).toBe(500);
  });
});

describe("writing", () => {
  it("answers a patch with the edited service and its health", async () => {
    const res = await call(makeApp(), "PATCH", "/api/services/svc", { network: { port: 9999 } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ network: { port: 9999, endpoint: "http://h1.ts.net:9999" }, health: "unknown" });
  });

  it.each([
    [false, "svc", "service.disabled"],
    [true, "off", "service.enabled"],
  ])("sets enabled to %s on disk and records %s by the user", async (enabled, id, type) => {
    expect((await call(makeApp(), "PATCH", `/api/services/${id}/enabled`, { enabled })).status).toBe(200);

    const onDisk = await loadRegistry(registryPath);
    expect(onDisk.services.find(s => s.id === id)!.permissions.enabled).toBe(enabled);
    const events = await readEvents(eventsPath);
    expect(events.find(e => e.type === type)).toMatchObject({ subjectId: id, actor: "user" });
  });
});
