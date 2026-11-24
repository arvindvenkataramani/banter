// The selection check where Banter differs from a deployment that always has a shard
// (docs/reference/design/service-apis.md, "Selections"): a control plane with no shard
// checks the stored selections at startup over its own services, a shard poll re-checks
// only where a shard is configured, and nothing the check throws fails startup, a
// selection save, a reload or a poll. The shipped templates pass the check.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlPlaneApp } from "../control-plane/src/app";
import { storedSelectionErrors } from "../control-plane/src/selection-check";
import { loadRegistry } from "../shared/src/registry";
import { clearLocks } from "../shared/src/lifecycle";
import { clearFileLocks } from "../shared/src/atomic-write";
import { FakeShard, shardService } from "./fixtures/fake-shard";

const SPEECH = [{ api: "openai.audio.speech" }];
const TRANSCRIBE = [{ api: "openai.audio.transcriptions" }];
// An entry the check cannot read: it throws on the API of a provision that is not an object.
const UNREADABLE = [null];

const repo = join(import.meta.dir, "..", "..");

const local = (id: string, capabilityId: string, port: number, provides?: unknown[]) => ({
  id, name: id, capabilityId, hostId: "airavatha",
  permissions: { enabled: true },
  runner: { type: "external" },
  network: { port, healthPath: "/health" },
  ...(provides !== undefined && { provides }),
});

let tmpDir: string;
let logged: string[];
let originalWarn: typeof console.warn;
let configPath: string;
let registryPath: string;
let shard: FakeShard | undefined;
const stops: (() => void)[] = [];

beforeEach(async () => {
  logged = [];
  originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  clearLocks();
  clearFileLocks();
  tmpDir = await mkdtemp(join(tmpdir(), "selection-check-banter-"));
  configPath = join(tmpDir, "config.json");
  registryPath = join(tmpDir, "registry.json");
  shard = undefined;
});

afterEach(async () => {
  console.warn = originalWarn;
  for (const stop of stops) stop();
  stops.length = 0;
  shard?.stop();
  await rm(tmpDir, { recursive: true, force: true });
});

interface PlaneOptions {
  tts: string;
  stt: string;
  sttModel?: string;
  services: unknown[];
  /** A shard to configure; its roster and services are the fake's own. */
  withShard?: boolean;
  /** Give the plane its registry already loaded, with this service's `provides` made unreadable to the check, which the registry file would not allow. */
  unreadable?: string;
}

async function plane(opts: PlaneOptions) {
  const config = {
    version: 4,
    voice: {
      enabled: true,
      tts: { selection: { serviceId: opts.tts, model: "pocket-tts", voice: "nicole", speed: 1 } },
      stt: { serviceId: opts.stt, ...(opts.sttModel && { model: opts.sttModel }) },
    },
  };
  if (opts.withShard) shard = new FakeShard();
  await writeFile(registryPath, JSON.stringify({
    version: 4,
    type: "control",
    hosts: [
      { id: "airavatha", name: "airavatha", hostname: "airavatha.example.ts.net", role: "control" },
      { id: "chintamani", name: "chintamani", hostname: "localhost", role: "worker" },
    ],
    capabilities: [{ id: "tts", name: "TTS" }, { id: "stt", name: "STT" }],
    services: opts.services,
    shards: shard ? [{ hostId: "chintamani", port: shard.port, scheme: "http" }] : [],
  }));
  await writeFile(configPath, JSON.stringify(config));
  let registry: any;
  if (opts.unreadable) {
    registry = await loadRegistry(registryPath);
    registry.services.find((s: any) => s.id === opts.unreadable).provides = UNREADABLE;
  }
  const app = await createControlPlaneApp({
    registryPath,
    registry,
    eventsPath: join(tmpDir, "events.jsonl"),
    mediaPath: join(tmpDir, "media"),
    shardPollIntervalMs: 3_600_000,
    checkService: async () => {},
    runFn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    pollHealthFn: async () => true,
    config,
    configPath,
  } as any);
  stops.push(() => app.stopShardPoll?.());
  return app;
}
type App = Awaited<ReturnType<typeof plane>>;

const getVoice = async (app: App) => (await app.fetch(new Request("http://localhost/api/voice"))).json() as Promise<any>;
const reload = (app: App) => app.fetch(new Request("http://localhost/api/config/reload", { method: "POST" }));
const patch = async (app: App, body: unknown) => {
  const res = await app.fetch(new Request("http://localhost/api/voice/selection", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() as any };
};
const selectionLog = () => logged.filter(line => line.startsWith("selection:"));
const settle = () => new Promise(r => setTimeout(r, 100));

describe("a control plane with no shard", () => {
  it("[T2] checks the stored selections at startup over its own services, serving and logging a failure before any reload or poll", async () => {
    const app = await plane({
      tts: "tts-local", stt: "stt-bare",
      services: [local("tts-local", "tts", 9301, SPEECH), local("stt-bare", "stt", 9302)],
    });

    const body = await getVoice(app);
    expect(body.tts.selection).not.toHaveProperty("selectionError");
    expect(body.stt.selectionError).toContain("stt-bare cannot");
    expect(selectionLog()).toHaveLength(1);
    expect(selectionLog()[0]).toContain("the stored STT selection fails");
  });

  it("[T2] refuses nothing at startup when its own services pass, and writes no warning", async () => {
    const app = await plane({
      tts: "tts-local", stt: "stt-local",
      services: [local("tts-local", "tts", 9301, SPEECH), local("stt-local", "stt", 9302, TRANSCRIBE)],
    });
    const body = await getVoice(app);
    expect(body.tts.selection).not.toHaveProperty("selectionError");
    expect(body.stt).not.toHaveProperty("selectionError");
    expect(selectionLog()).toEqual([]);
  });

  it("[T2] reports a stored service that is in no registry as not a registered service, since no host is waiting to be polled", async () => {
    const app = await plane({ tts: "tts-ghost", stt: "stt-local", services: [local("stt-local", "stt", 9302, TRANSCRIBE)] });
    expect((await getVoice(app)).tts.selection.selectionError).toBe("tts-ghost is not a registered service");
  });

  it("[T2] does not warn again for the same failure on a reload that changes nothing", async () => {
    const app = await plane({ tts: "tts-local", stt: "stt-bare", services: [local("tts-local", "tts", 9301, SPEECH), local("stt-bare", "stt", 9302)] });
    expect(selectionLog()).toHaveLength(1);
    await reload(app);
    await reload(app);
    await settle();
    expect(selectionLog()).toHaveLength(1);
  });

  it("[T2] starts no poll, so a poll request is refused and writes no selection warning", async () => {
    const app = await plane({ tts: "tts-local", stt: "stt-local", services: [local("tts-local", "tts", 9301, SPEECH), local("stt-local", "stt", 9302, TRANSCRIBE)] });
    expect(app.stopShardPoll).toBeNull();
    const res = await app.fetch(new Request("http://localhost/api/shards/chintamani/poll", { method: "POST" }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(selectionLog()).toEqual([]);
  });
});

describe("a control plane with a shard", () => {
  it("[T2] re-checks after a poll, so a service the poll reveals to fail is warned about", async () => {
    const app = await plane({ tts: "fluid-tts", stt: "stt-bare", services: [], withShard: true });
    shard!.services = [shardService("fluid-tts", { capabilityId: "tts", health: "healthy", provides: SPEECH } as any), shardService("stt-bare", { capabilityId: "stt", health: "healthy" } as any)];
    expect(selectionLog()).toEqual([]);
    await app.fetch(new Request("http://localhost/api/shards/chintamani/poll", { method: "POST" }));
    expect(selectionLog().filter(l => l.includes("stt-bare cannot"))).toHaveLength(1);
    expect((await getVoice(app)).stt.selectionError).toContain("stt-bare cannot");
  });
});

describe("a check that throws", () => {
  const services = () => [local("tts-local", "tts", 9301, SPEECH), local("stt-local", "stt", 9302, TRANSCRIBE), local("stt-broken", "stt", 9303, TRANSCRIBE)];
  const failedLogged = () => selectionLog().some(l => l.includes("the check of the stored selections failed"));

  it("[T2] does not fail startup, and is logged", async () => {
    const app = await plane({ tts: "tts-local", stt: "stt-broken", services: services(), unreadable: "stt-broken" });
    expect(failedLogged()).toBe(true);
    expect((await app.fetch(new Request("http://localhost/api/voice"))).status).toBe(200);
  });

  it("[T2] does not fail GET /api/voice, which serves no selection error", async () => {
    const app = await plane({ tts: "tts-local", stt: "stt-broken", services: services(), unreadable: "stt-broken" });
    const body = await getVoice(app);
    expect(body.stt).not.toHaveProperty("selectionError");
    expect(body.tts.selection.serviceId).toBe("tts-local");
  });

  it("[T2] does not fail a selection save, which stores the selection and logs the throw", async () => {
    const app = await plane({ tts: "tts-local", stt: "stt-local", services: services(), unreadable: "stt-broken" });
    const res = await patch(app, { sttServiceId: "stt-broken" });
    expect(res.status).toBe(200);
    expect(res.body.stt.serviceId).toBe("stt-broken");
    expect(JSON.parse(await readFile(configPath, "utf-8")).voice.stt.serviceId).toBe("stt-broken");
    expect(selectionLog().length).toBeGreaterThan(0);
  });

  it("[T2] does not fail a poll or a reload that polled, and still caches the shard's services", async () => {
    const app = await plane({ tts: "fluid-tts", stt: "stt-broken", services: [], withShard: true });
    shard!.services = [
      shardService("fluid-tts", { capabilityId: "tts", health: "healthy", provides: SPEECH } as any),
      shardService("stt-broken", { capabilityId: "stt", health: "healthy", provides: UNREADABLE } as any),
    ];
    const polled = await app.fetch(new Request("http://localhost/api/shards/chintamani/poll", { method: "POST" }));
    expect(polled.status).toBe(200);
    expect(failedLogged()).toBe(true);
    const services = await (await app.fetch(new Request("http://localhost/api/services"))).json() as any[];
    expect(services.some(s => s.id === "stt-broken")).toBe(true);

    shard!.reply("POST", "/api/config/reload", { status: 200, body: { registry: { ok: true }, warnings: [] } });
    const reloaded = await reload(app);
    expect(reloaded.status).toBe(200);
    expect((await getVoice(app)).stt).not.toHaveProperty("selectionError");
  });
});

describe("the shipped templates", () => {
  const read = (...parts: string[]) => JSON.parse(readFileSync(join(repo, ...parts), "utf-8"));
  const checked = (config: any, registry: any) => storedSelectionErrors(
    { ttsServiceId: config.voice.tts?.selection?.serviceId, sttServiceId: config.voice.stt?.serviceId, sttModel: config.voice.stt?.model },
    registry.services,
    registry.roster?.sttModels ?? [],
    [],
  );

  it("[T2] config.example.json's selections pass against registry.example.json", () => {
    const config = read("control", "control-plane", "data", "config.example.json");
    const registry = read("control", "control-plane", "data", "registry.example.json");
    expect(config.voice.tts.selection.serviceId).toBeTruthy();
    expect(checked(config, registry)).toEqual({});
  });

  it("[T2] the test environment's merge of the example registry and registry.fluid.example.json passes with fluid-tts, fluid-stt and parakeet-unified-0.6b", () => {
    const base = read("control", "control-plane", "data", "registry.example.json");
    const fluid = read("services", "fluid", "registry.fluid.example.json");
    // As docs/reference/test-environment.md, step 2, merges them: the control service stays, the fluid services join, the roster takes the fluid providers and sttModels.
    const merged = {
      ...base,
      services: [...base.services.filter((s: any) => s.id === "control"), ...fluid.services],
      roster: { ...base.roster, providers: fluid.roster.providers, sttModels: fluid.roster.sttModels, ttsModels: [...base.roster.ttsModels, ...fluid.roster.ttsModels] },
    };
    const config = { voice: { tts: { selection: { serviceId: "fluid-tts" } }, stt: { serviceId: "fluid-stt", model: "parakeet-unified-0.6b" } } };
    expect(merged.services.map((s: any) => s.id)).toEqual(expect.arrayContaining(["fluid-tts", "fluid-stt"]));
    expect(checked(config, merged)).toEqual({});
  });
});
