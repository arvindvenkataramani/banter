// The control plane's link to a shard: polling it, merging what it reports
// with the local registry, and forwarding requests for its services.
// Promises: docs/components/control-plane-api.md, "Shards".

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlPlaneApp } from "../control-plane/src/app";
import { startShardPollLoop } from "../control-plane/src/shard-poller";
import { appendEvent } from "../shared/src/events";
import { loadRegistry } from "../shared/src/registry";
import { clearLocks } from "../shared/src/lifecycle";
import { FakeShard, shardService, type Reply } from "./fixtures/fake-shard";
import type { Event, NodeRoster, Registry } from "../../shared/types";

type App = Awaited<ReturnType<typeof createControlPlaneApp>>;
type RunFn = (cmd: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

let tmpDir: string;
let registryPath: string;
let eventsPath: string;
let shard: FakeShard;
const stops: (() => void)[] = [];

const ok: RunFn = async () => ({ stdout: "", stderr: "", exitCode: 0 });

function registryDoc() {
  return {
    version: 2,
    type: "control",
    hosts: [
      { id: "home-server", name: "home-server", hostname: "home-server.example.ts.net", role: "control" },
      { id: "gpu-machine", name: "gpu-machine", hostname: "localhost", role: "worker" },
    ],
    capabilities: [
      { id: "control", name: "Control" },
      { id: "tts", name: "TTS" },
      { id: "stt", name: "STT" },
      { id: "llm", name: "LLM" },
    ],
    services: [
      {
        id: "local-tts",
        capabilityId: "tts",
        hostId: "home-server",
        permissions: { enabled: true },
        runner: { type: "systemd", unit: "local-tts", unitFile: "ops/systemd/local-tts.service" },
        network: { port: 9001, healthPath: "/health" },
      },
      {
        id: "local-llm",
        capabilityId: "llm",
        hostId: "home-server",
        permissions: { enabled: true },
        runner: { type: "external" },
        network: { port: 9002, healthPath: "/health" },
      },
    ],
    shards: [{ hostId: "gpu-machine", port: shard.port }],
  };
}

beforeEach(async () => {
  clearLocks();
  tmpDir = await mkdtemp(join(tmpdir(), "shard-link-"));
  registryPath = join(tmpDir, "registry.json");
  eventsPath = join(tmpDir, "events.jsonl");
  shard = new FakeShard();
  shard.services = [
    shardService("control-shard", { capabilityId: "control", health: "healthy" }),
    shardService("shard-tts", { health: "healthy" }),
    shardService("shard-stt", { capabilityId: "stt" }),
  ];
  await writeFile(registryPath, JSON.stringify(registryDoc()));
});

afterEach(async () => {
  for (const stop of stops) stop();
  stops.length = 0;
  shard.stop();
  await rm(tmpDir, { recursive: true, force: true });
});

async function until(check: () => boolean | Promise<boolean>, ms = 1000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise(r => setTimeout(r, 5));
  }
}

async function call(app: App, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await app.fetch(new Request(`http://localhost${path}`, {
    method,
    ...(body !== undefined && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  }));
  return { status: res.status, body: await res.json() };
}

/** A control plane whose first poll of the shard has finished. No interval poll fires during a test. */
async function plane(opts: { registry?: Registry; runFn?: RunFn } = {}): Promise<App> {
  const app = await createControlPlaneApp({
    registryPath,
    registry: opts.registry,
    eventsPath,
    shardPollIntervalMs: 3_600_000,
    checkService: async () => {},
    runFn: opts.runFn ?? ok,
    pollHealthFn: async () => true,
  });
  stops.push(() => app.stopShardPoll?.());
  await until(async () => (await call(app, "GET", "/api/shards")).body[0].lastPoll > 0);
  return app;
}

async function goOffline(app: App): Promise<void> {
  shard.stop();
  await call(app, "POST", "/api/shards/gpu-machine/poll");
}

const ids = (list: { id: string }[]) => list.map(s => s.id);
const healthOf = async (app: App, id: string) =>
  ((await call(app, "GET", "/api/services")).body as { id: string; health: string }[]).find(s => s.id === id)?.health;

describe("polling a shard", () => {
  it("lists the shard's services after the local ones and reports the shard online", async () => {
    const app = await plane();

    expect(ids((await call(app, "GET", "/api/services")).body)).toEqual(["local-tts", "local-llm", "control-shard", "shard-tts", "shard-stt"]);
    const [status] = (await call(app, "GET", "/api/shards")).body;
    expect(status).toMatchObject({ hostId: "gpu-machine", endpoint: shard.endpoint, online: true });
    expect(status.lastPoll).toBeGreaterThan(0);
  });

  it("marks a shard offline when a poll fails, keeping its services and turning only its own control service unknown", async () => {
    const app = await plane();
    await goOffline(app);

    expect((await call(app, "GET", "/api/shards")).body[0].online).toBe(false);
    expect(await healthOf(app, "control-shard")).toBe("unknown");
    expect(await healthOf(app, "shard-tts")).toBe("healthy");
  });

  it("refuses an on-demand poll of a host with no shard", async () => {
    const app = await plane();
    expect((await call(app, "POST", "/api/shards/nowhere/poll")).status).toBe(404);
  });

  it("reports a shard with no roster route as unsupported, and keeps a roster once served through a later 404 or malformed answer", async () => {
    shard.roster = { status: 404 };
    const poller = startShardPollLoop([{ hostId: "gpu-machine", port: shard.port, endpoint: shard.endpoint }], 3_600_000);
    stops.push(poller.stop);
    await until(() => poller.getLastPoll("gpu-machine") > 0);
    expect(poller.getShardRoster("gpu-machine")).toBeNull();
    expect(poller.isRosterUnsupported("gpu-machine")).toBe(true);

    const roster = { providers: { "shard-tts": {} }, voices: [] } as unknown as NodeRoster;
    for (const served of [roster, { status: 404 }, { status: 200, body: { unrelated: true } }]) {
      shard.roster = served;
      await poller.pollShard("gpu-machine");
      expect(poller.getShardRoster("gpu-machine")).toEqual(roster);
      expect(poller.isRosterUnsupported("gpu-machine")).toBe(false);
    }
  });
});

describe("reading a shard service", () => {
  it("applies ?capability= to shard services as well as local ones", async () => {
    const app = await plane();
    expect(ids((await call(app, "GET", "/api/services?capability=tts")).body)).toEqual(["local-tts", "shard-tts"]);
  });

  it("asks the shard at the time of the request, and the list then shows the answer", async () => {
    const app = await plane();
    shard.services[1] = shardService("shard-tts", { health: "down", pending: true });

    expect((await call(app, "GET", "/api/services/shard-tts")).body).toMatchObject({ health: "down", pending: true });
    expect(await healthOf(app, "shard-tts")).toBe("down");
  });

  it("is 503 when the shard cannot be reached, though the service is cached", async () => {
    const app = await plane();
    shard.stop();
    expect((await call(app, "GET", "/api/services/shard-tts")).status).toBe(503);
  });

  it("is 404 when the shard no longer holds the service", async () => {
    const app = await plane();
    shard.services = shard.services.filter(s => s.id !== "shard-tts");
    expect((await call(app, "GET", "/api/services/shard-tts")).status).toBe(404);
  });

  it.each([
    ["GET", "/api/services/nope"],
    ["POST", "/api/services/nope/start"],
    ["PATCH", "/api/services/nope"],
    ["POST", "/api/services/nope/ping"],
  ])("is 404 for an id neither local nor on a shard: %s %s", async (method, path) => {
    const app = await plane();
    expect((await call(app, method, path, method === "PATCH" ? {} : undefined)).status).toBe(404);
  });

  // Banter swaps a loopback service's host for the shard's, where platform
  // routes it through the shard's /svc route (dev/design/platform-divergence.md,
  // "Decided": Banter leaves out platform's origin rule).
  it("hands out a loopback service's endpoint on the shard's host, and leaves a tailnet endpoint alone", async () => {
    shard.services.push(shardService("shard-loop", { network: { port: 9000, healthPath: "/health", endpoint: "http://127.0.0.1:9000" } }));
    const app = await plane();
    const endpointOf = async (id: string) =>
      ((await call(app, "GET", "/api/services")).body as { id: string; network: { endpoint: string } }[]).find(s => s.id === id)!.network.endpoint;
    const shardHost = new URL(shard.endpoint).hostname;

    expect(await endpointOf("shard-loop")).toBe(`http://${shardHost}:9000/`);
    expect((await call(app, "GET", "/api/services/shard-loop")).body.network.endpoint).toBe(`http://${shardHost}:9000/`);
    expect(await endpointOf("shard-tts")).toBe("https://gpu-machine.example.ts.net:8000");
  });

  it("merges local and shard events newest first, with subjectId applied to both and limit to the merge", async () => {
    const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
    const event = (id: string, subjectId: string, timestamp: string) =>
      ({ id, timestamp, type: "service.up", subjectType: "service", subjectId, data: {}, actor: "system" }) as Event;
    shard.events = [event("shard-new", "shard-tts", at(3_600_000)), event("shard-old", "shard-stt", at(-3_600_000))];
    await appendEvent(eventsPath, { type: "service.up", subjectType: "service", subjectId: "local-tts", data: {}, actor: "system" });
    const app = await plane();
    const order = async (query: string) =>
      ((await call(app, "GET", `/api/events${query}`)).body as Event[]).map(e => e.subjectId === "local-tts" ? "local" : e.id);

    expect(await order("")).toEqual(["shard-new", "local", "shard-old"]);
    expect(await order("?limit=2")).toEqual(["shard-new", "local"]);
    expect(await order("?subjectId=shard-stt")).toEqual(["shard-old"]);
  });
});

const FORWARDED: [string, string, string, string, unknown][] = [
  ["start", "POST", "/api/services/shard-tts/start", "/api/services/shard-tts/start", undefined],
  ["stop", "POST", "/api/services/shard-tts/stop", "/api/services/shard-tts/stop", undefined],
  ["restart", "POST", "/api/services/shard-tts/restart", "/api/services/shard-tts/restart", undefined],
  ["check", "POST", "/api/services/shard-tts/check", "/api/services/shard-tts/check", undefined],
  ["info", "GET", "/api/services/shard-tts/info", "/api/services/shard-tts/info", undefined],
  ["a patch", "PATCH", "/api/services/shard-tts", "/api/services/shard-tts", { notes: "edited" }],
  ["the enabled toggle", "PATCH", "/api/services/shard-tts/enabled", "/api/services/shard-tts/enabled", { enabled: false }],
  ["a ping", "POST", "/api/services/shard-tts/ping", "/ping/shard-tts", undefined],
];

describe("forwarding to a shard", () => {
  it.each(FORWARDED)("sends %s to the shard and returns its status and body unchanged", async (_, method, path, shardPath, body) => {
    shard.reply(method, shardPath, { status: 202, body: { from: "shard" } });
    const app = await plane();

    expect(await call(app, method, path, body)).toEqual({ status: 202, body: { from: "shard" } });
    const received = shard.received(method, shardPath);
    expect(received).toHaveLength(1);
    if (body !== undefined) expect(JSON.parse(received[0].body)).toEqual(body);
  });

  it.each(FORWARDED)("is 503 for %s while the shard is offline", async (_, method, path, _shardPath, body) => {
    const app = await plane();
    await goOffline(app);
    expect((await call(app, method, path, body)).status).toBe(503);
  });

  it.each([
    ["a refusal, as sent", { status: 409, body: { error: "busy" } }, { error: "busy" }],
    ["an answer with no JSON body, as an error naming its status", { status: 502, text: "Bad Gateway" }, { error: "shard returned 502" }],
  ] as [string, Reply, unknown][])("passes back %s", async (_, reply, expected) => {
    shard.reply("POST", "/api/services/shard-tts/start", reply);
    const app = await plane();
    expect(await call(app, "POST", "/api/services/shard-tts/start")).toEqual({ status: reply.status, body: expected });
  });

  it("polls the shard again after an action succeeds, so the list catches up", async () => {
    shard.reply("POST", "/api/services/shard-tts/start", { status: 202, body: { success: true } });
    const app = await plane();
    shard.services[1] = shardService("shard-tts", { health: "down" });
    expect(await healthOf(app, "shard-tts")).toBe("healthy");

    await call(app, "POST", "/api/services/shard-tts/start");
    await until(async () => (await healthOf(app, "shard-tts")) === "down");
  });
});

describe("a local service", () => {
  it("is started on this node, and nothing reaches the shard", async () => {
    const cmds: string[][] = [];
    const app = await plane({ runFn: async cmd => { cmds.push(cmd); return ok(cmd); } });

    expect((await call(app, "POST", "/api/services/local-tts/start")).status).toBe(200);
    expect(cmds.some(c => c.includes("local-tts.service"))).toBe(true);
    expect(shard.requests.filter(r => r.method !== "GET")).toEqual([]);
  });

  it("answers a ping without doing anything, as it is never evicted", async () => {
    const app = await plane();
    expect(await call(app, "POST", "/api/services/local-tts/ping")).toEqual({ status: 200, body: { ok: true, evictable: false } });
    expect(shard.requests.filter(r => r.method !== "GET")).toEqual([]);
  });

  it("is edited on the registry object the caller passed in, which the health loop also reads", async () => {
    const registry = await loadRegistry(registryPath);
    const app = await plane({ registry });

    await call(app, "PATCH", "/api/services/local-tts", { network: { port: 9999 } });
    await call(app, "PATCH", "/api/services/local-tts/enabled", { enabled: false });

    expect(registry.services[0].network.endpoint).toBe("http://home-server.example.ts.net:9999");
    expect(registry.services[0].permissions.enabled).toBe(false);
  });
});
