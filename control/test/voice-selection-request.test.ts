// GET /api/voice and the selection it serves (docs/reference/design/model-roster.md,
// "What the control plane serves" and "Reaching a resolution"). For a runtime on
// a shard host the control plane asks that shard and serves its answer as
// `selection.request`; for one on its own host it resolves from its own roster. The roster is the one the
// shared resolution cases use, held by a fake shard on the worker host.
//
// Assumed names: `tts.models[].canClone`, `tts.providers[].serves`,
// `tts.voices[].renderings[]` ({ model, method }), `tts.selection.serviceId`,
// `tts.selection.request` (the shard's answer, verbatim) and
// `tts.selection.requestError` (a string, present only when `request` is absent).

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlPlaneApp } from "../control-plane/src/app";
import { clearLocks } from "../shared/src/lifecycle";
import { FakeShard, shardService } from "./fixtures/fake-shard";

const shared = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "schemas", "voice-resolution-cases.json"), "utf-8")) as { roster: any };

// What the shard answers for the stored selection: nicole, cloned by pocket-tts on the self-resolving runtime.
const ANSWER = { model: "pocket-tts", voice: "nicole" };

let tmpDir: string;
let shard: FakeShard;
const stops: (() => void)[] = [];

beforeEach(async () => {
  clearLocks();
  tmpDir = await mkdtemp(join(tmpdir(), "voice-selection-request-"));
  shard = new FakeShard();
  shard.roster = shared.roster;
  shard.services = [
    shardService("fluid-tts", { name: "FluidServer TTS", health: "healthy" }),
    shardService("tts-mlx-audio", { name: "MLX Audio", health: "healthy" }),
    shardService("fluid-stt", { capabilityId: "stt", name: "FluidServer STT", health: "healthy" }),
  ];
  shard.reply("POST", "/api/voices/resolve", { status: 200, body: ANSWER });
});

afterEach(async () => {
  for (const stop of stops) stop();
  stops.length = 0;
  shard.stop();
  await rm(tmpDir, { recursive: true, force: true });
});

async function plane() {
  const registryPath = join(tmpDir, "registry.json");
  const configPath = join(tmpDir, "config.json");
  const config = {
    version: 4,
    voice: {
      enabled: true,
      tts: { selection: { serviceId: "fluid-tts", model: "pocket-tts", voice: "nicole", speed: 1 } },
      stt: { serviceId: "fluid-stt" },
    },
  };
  await writeFile(registryPath, JSON.stringify({
    version: 4,
    type: "control",
    hosts: [
      { id: "home-server", name: "home-server", hostname: "home-server.example.ts.net", role: "control" },
      { id: "gpu-machine", name: "gpu-machine", hostname: "localhost", role: "worker" },
    ],
    capabilities: [{ id: "tts", name: "TTS" }, { id: "stt", name: "STT" }],
    services: [],
    shards: [{ hostId: "gpu-machine", port: shard.port, scheme: "http" }],
  }));
  await writeFile(configPath, JSON.stringify(config));
  const app = await createControlPlaneApp({
    registryPath,
    eventsPath: join(tmpDir, "events.jsonl"),
    shardPollIntervalMs: 3_600_000,
    checkService: async () => {},
    runFn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    pollHealthFn: async () => true,
    config,
    configPath,
  } as any);
  stops.push(() => app.stopShardPoll?.());
  const end = Date.now() + 2000;
  while (true) {
    const shards = await (await app.fetch(new Request("http://localhost/api/shards"))).json();
    if (shards[0].lastPoll > 0) break;
    if (Date.now() > end) throw new Error("the shard was never polled");
    await new Promise(r => setTimeout(r, 5));
  }
  return app;
}

const getVoice = async (app: Awaited<ReturnType<typeof plane>>) => (await app.fetch(new Request("http://localhost/api/voice"))).json() as Promise<any>;

describe("GET /api/voice", () => {
  it("serves the models, the providers with what each serves, and the voices with their renderings as model and method", async () => {
    const body = await getVoice(await plane());

    const pocket = body.tts.models.find((m: any) => m.id === "pocket-tts");
    expect(pocket).toMatchObject({ name: "Pocket-TTS", canClone: true, chunking: { mode: "sentence" } });
    expect(body.tts.models.find((m: any) => m.id === "kokoro-82m").canClone).toBe(false);

    const fluid = body.tts.providers.find((p: any) => p.serviceId === "fluid-tts");
    expect(fluid).toMatchObject({ hostId: "gpu-machine", reachable: true, name: "FluidServer TTS", responseFormat: "aac", sessions: true });
    expect(fluid.serves.map((s: any) => s.model)).toEqual(["pocket-tts", "luxtts", "kokoro-82m"]);
    expect(body.tts.providers.map((p: any) => p.serviceId)).not.toContain("fluid-stt");

    const nicole = body.tts.voices.find((v: any) => v.id === "nicole");
    expect(nicole.name).toBe("Nicole");
    expect(nicole.renderings).toEqual([
      { model: "kokoro-82m", method: "preset" },
      { model: "pocket-tts", method: "clone" },
      { model: "luxtts", method: "clone" },
      { model: "chatterbox", method: "clone" },
    ]);
  });

  it("serves neither a preset's key nor a recording's path", async () => {
    const text = JSON.stringify((await getVoice(await plane())).tts);
    expect(text).not.toContain("af_nicole");
    expect(text).not.toContain("/refs/");
  });

  it("serves the selection's voice, model and runtime with `request` exactly as the shard resolved it", async () => {
    const body = await getVoice(await plane());
    expect(body.tts.selection).toMatchObject({ voice: "nicole", model: "pocket-tts", serviceId: "fluid-tts", speed: 1 });
    expect(body.tts.selection.request).toEqual(ANSWER);

    const asked = shard.received("POST", "/api/voices/resolve");
    expect(asked.length).toBeGreaterThan(0);
    expect(JSON.parse(asked[0].body)).toEqual({ voice: "nicole", model: "pocket-tts", serviceId: "fluid-tts" });
  });

  it("leaves `request` absent, with the reason, when the shard cannot be reached", async () => {
    const app = await plane();
    shard.stop();
    await app.fetch(new Request("http://localhost/api/shards/gpu-machine/poll", { method: "POST" }));

    const body = await getVoice(app);
    expect(body.tts.selection.request).toBeUndefined();
    expect(typeof body.tts.selection.requestError).toBe("string");
    expect(body.tts.selection.requestError.length).toBeGreaterThan(0);
    // The roster keeps its last known providers, flagged.
    expect(body.tts.providers.find((p: any) => p.serviceId === "fluid-tts").reachable).toBe(false);
  });
});

describe("resolving through a shard the poller last saw failing", () => {
  it("asks the shard anyway, so the selection carries `request` while the cached reachability is false", async () => {
    const app = await plane();
    shard.reply("GET", "/api/services", { status: 500, body: { error: "boom" } });
    await app.fetch(new Request("http://localhost/api/shards/gpu-machine/poll", { method: "POST" }));
    expect((await (await app.fetch(new Request("http://localhost/api/shards"))).json() as any)[0].online).toBe(false);

    const body = await getVoice(app);
    expect(body.tts.providers.find((p: any) => p.serviceId === "fluid-tts").reachable).toBe(false);
    expect(body.tts.selection.request).toEqual(ANSWER);
  });
});

describe("a shard still serving the older roster format", () => {
  it("is treated as having no usable roster: the route answers 200 with no providers and a reason, not a 500", async () => {
    shard.reply("POST", "/api/voices/resolve", { status: 404, body: { error: "not found" } });
    shard.roster = {
      providers: { "fluid-tts": { ttsModels: [{ id: "pocket-tts", name: "Pocket-TTS", key: "pocket-tts" }] } },
      voices: [{ id: "nicole", name: "Nicole", models: [{ serviceId: "fluid-tts", model: "pocket-tts", key: "clone" }] }],
    } as any;
    const res = await (await plane()).fetch(new Request("http://localhost/api/voice"));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.tts.providers).toEqual([]);
    expect(typeof body.tts.selection.requestError).toBe("string");
  });
});

describe("PATCH /api/voice/selection", () => {
  it("answers a voice change with the shard's resolution of the new selection", async () => {
    const app = await plane();
    shard.reply("POST", "/api/voices/resolve", { status: 200, body: { model: "pocket-tts", voice: "eponine" } });

    const res = await app.fetch(new Request("http://localhost/api/voice/selection", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ voice: "eponine" }),
    }));

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.tts.selection).toMatchObject({ voice: "eponine", model: "pocket-tts", serviceId: "fluid-tts" });
    expect(body.tts.selection.request).toEqual({ model: "pocket-tts", voice: "eponine" });
    const last = shard.received("POST", "/api/voices/resolve").at(-1)!;
    expect(JSON.parse(last.body)).toEqual({ voice: "eponine", model: "pocket-tts", serviceId: "fluid-tts" });
  });
});

describe("GET /api/voice with no shard", () => {
  // The single-machine install: the control-plane example registry and config,
  // as ops/install.sh seeds them. The runtime is on the control plane's host.
  it("resolves the selection from the control plane's own roster", async () => {
    const data = join(import.meta.dir, "..", "control-plane", "data");
    const registryPath = join(tmpDir, "registry.json");
    const configPath = join(tmpDir, "config.json");
    await writeFile(registryPath, readFileSync(join(data, "registry.example.json"), "utf-8"));
    const config = JSON.parse(readFileSync(join(data, "config.example.json"), "utf-8"));
    await writeFile(configPath, JSON.stringify(config));
    const app = await createControlPlaneApp({
      registryPath,
      eventsPath: join(tmpDir, "events.jsonl"),
      checkService: async () => {},
      runFn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      pollHealthFn: async () => true,
      config,
      configPath,
    } as any);
    stops.push(() => app.stopShardPoll?.());

    const body = await (await app.fetch(new Request("http://localhost/api/voice"))).json() as any;
    expect(body.tts.selection.requestError).toBeUndefined();
    expect(body.tts.selection.request).toEqual({ model: "kokoro-82m", voice: "af_heart" });
  });
});
