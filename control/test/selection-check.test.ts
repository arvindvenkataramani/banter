// The selection check (docs/reference/design/service-apis.md, "Selections"). A
// selection passes when its service has the capability the selection is for and
// declares a candidate provision for the operation: `synthesize` for the TTS
// selection; for the STT selection `transcribeStream` with `client-endpointing`
// when the selected model is `streaming`, `transcribe` when `batch`, either when
// `both`. The selection routes refuse a failing selection; the control plane
// re-checks stored selections after each shard poll and after a config or
// registry reload, serves a failure in GET /api/voice and never fails startup.
//
// Each failure is also logged with console.warn under the prefix `selection:`, once each
// time a selection starts failing or its message changes.
//

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlPlaneApp } from "../control-plane/src/app";
import { clearLocks } from "../shared/src/lifecycle";
import { clearFileLocks } from "../shared/src/atomic-write";
import { FakeShard, shardService } from "./fixtures/fake-shard";

const shared = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "schemas", "voice-resolution-cases.json"), "utf-8")) as { roster: any };

const SPEECH = [{ api: "openai.audio.speech" }];
const TRANSCRIBE = [{ api: "openai.audio.transcriptions" }];
const STREAM = [{ api: "fluid.stt.stream" }];
// Deepgram's live route holds client-endpointing only with the endpointing-off extension.
const LISTEN_PLAIN = [{ api: "deepgram.listen.live" }];
const LISTEN_OFF = [{ api: "deepgram.listen.live", extends: ["endpointing-off"] }];
const NOT_SPEECH = [{ api: "openai.audio.transcriptions" }];

const BATCH = "parakeet-tdt-v3";
const STREAMING = "stream-model";
const BOTH = "both-model";

/** The shared roster with a streaming and a both-kind speech-to-text model added. */
function roster() {
  const r = structuredClone(shared.roster);
  r.sttModels.push({ id: STREAMING, name: "Stream model", kind: "streaming" }, { id: BOTH, name: "Both model", kind: "both" });
  r.providers["fluid-stt"].serves.push({ model: STREAMING, key: "stream-key", streaming: true }, { model: BOTH, key: "both-key" });
  return r;
}

const service = (id: string, capabilityId: string, provides?: unknown[]) =>
  shardService(id, { capabilityId, health: "healthy", ...(provides !== undefined && { provides }) } as any);

/** A service the control plane runs itself, as its registry holds it. */
const local = (id: string, capabilityId: string, port: number, provides?: unknown[]) => ({
  id, name: id, capabilityId, hostId: "airavatha",
  permissions: { enabled: true },
  runner: { type: "external" },
  network: { port, healthPath: "/health" },
  ...(provides !== undefined && { provides }),
});

let tmpDir: string;
let shard: FakeShard;
let logged: string[];
let originalWarn: typeof console.warn;
let configPath: string;
let registryPath: string;
const stops: (() => void)[] = [];

beforeEach(async () => {
  logged = [];
  originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  clearLocks();
  clearFileLocks();
  tmpDir = await mkdtemp(join(tmpdir(), "selection-check-"));
  configPath = join(tmpDir, "config.json");
  registryPath = join(tmpDir, "registry.json");
  shard = new FakeShard();
  shard.roster = roster();
  shard.reply("POST", "/api/voices/resolve", { status: 200, body: { model: "pocket-tts", voice: { name: "nicole" } } });
  shard.reply("POST", "/api/config/reload", { status: 200, body: { registry: { ok: true }, warnings: [] } });
  shard.services = [
    service("fluid-tts", "tts", SPEECH),
    service("tts-mlx-audio", "tts", SPEECH),
    service("stt-stream", "stt", STREAM),
    service("stt-batch", "stt", TRANSCRIBE),
    service("stt-both", "stt", [...STREAM, ...TRANSCRIBE]),
    service("stt-none", "stt"),
    service("stt-listen-plain", "stt", LISTEN_PLAIN),
    service("stt-listen-off", "stt", LISTEN_OFF),
  ];
});

afterEach(async () => {
  console.warn = originalWarn;
  for (const stop of stops) stop();
  stops.length = 0;
  shard.stop();
  await rm(tmpDir, { recursive: true, force: true });
});

interface PlaneOptions {
  tts?: string;
  stt?: string;
  sttModel?: string;
  /** Store no STT model at all. */
  noSttModel?: boolean;
  /** Services the control plane runs itself, as registry entries. */
  local?: unknown[];
  /** Leave the shard unreachable from the start. */
  shardDown?: boolean;
  /** A plane with no shard at all, so a reload ends in no poll. */
  noShard?: boolean;
}

async function plane(opts: PlaneOptions = {}) {
  const config = {
    version: 4,
    voice: {
      enabled: true,
      tts: { selection: { serviceId: opts.tts ?? "fluid-tts", model: "pocket-tts", voice: "nicole", speed: 1 } },
      stt: { serviceId: opts.stt ?? "stt-stream", ...(!opts.noSttModel && { model: opts.sttModel ?? STREAMING }) },
    },
  };
  await writeFile(registryPath, JSON.stringify({
    version: 4,
    type: "control",
    hosts: [
      { id: "airavatha", name: "airavatha", hostname: "airavatha.example.ts.net", role: "control" },
      { id: "chintamani", name: "chintamani", hostname: "localhost", role: "worker" },
    ],
    capabilities: [{ id: "tts", name: "TTS" }, { id: "stt", name: "STT" }],
    services: opts.local ?? [],
    shards: opts.noShard ? [] : [{ hostId: "chintamani", port: shard.port, scheme: "http" }],
  }));
  await writeFile(configPath, JSON.stringify(config));
  if (opts.shardDown) shard.stop();
  const app = await createControlPlaneApp({
    registryPath,
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
  if (!opts.shardDown && !opts.noShard) {
    const end = Date.now() + 2000;
    while (true) {
      const shards = await (await app.fetch(new Request("http://localhost/api/shards"))).json();
      if (shards[0].lastPoll > 0) break;
      if (Date.now() > end) throw new Error("the shard was never polled");
      await new Promise(r => setTimeout(r, 5));
    }
  }
  return app;
}
type App = Awaited<ReturnType<typeof plane>>;

const poll = (app: App) => app.fetch(new Request("http://localhost/api/shards/chintamani/poll", { method: "POST" }));
const reload = (app: App) => app.fetch(new Request("http://localhost/api/config/reload", { method: "POST" }));
/** Waits, for at most two seconds, until the log holds `count` selection lines. */
async function logHolds(count: number): Promise<void> {
  const end = Date.now() + 2000;
  while (selectionLog().length < count && Date.now() < end) await new Promise(r => setTimeout(r, 5));
}
/** Gives a check that should write nothing the time a late one would take. */
const settle = () => new Promise(r => setTimeout(r, 100));
const getVoice = async (app: App) => (await app.fetch(new Request("http://localhost/api/voice"))).json() as Promise<any>;
const patch = async (app: App, body: unknown) => {
  const res = await app.fetch(new Request("http://localhost/api/voice/selection", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() as any };
};
/** The selection warnings written so far, one string each. */
const selectionLog = () => logged.filter(line => line.startsWith("selection:"));
const stored = async () => JSON.parse(await readFile(configPath, "utf-8")).voice;

describe("the TTS selection route", () => {
  const TO_MLX = { serviceId: "tts-mlx-audio", model: "pocket-tts", voice: "eponine" };

  it("[T2] accepts a service that declares a speech provision", async () => {
    const app = await plane();
    const res = await patch(app, TO_MLX);
    expect(res.status).toBe(200);
    expect((await stored()).tts.selection.serviceId).toBe("tts-mlx-audio");
  });

  it.each([
    ["no provides at all", undefined],
    ["only an API that does not synthesize", NOT_SPEECH],
    ["a speech provision that omits the input", [{ api: "openai.audio.speech", omits: ["parameter:input"] }]],
  ])("[T2] refuses a service with %s, naming it and the operation, and stores nothing", async (_, provides) => {
    shard.services = shard.services.map(s => (s.id === "tts-mlx-audio" ? service("tts-mlx-audio", "tts", provides as any) : s));
    const app = await plane();
    const res = await patch(app, TO_MLX);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("tts-mlx-audio cannot synthesize");
    expect((await stored()).tts.selection.serviceId).toBe("fluid-tts");
  });

  it("[T2] refuses a provider the roster names but no service entry backs, as not a registered service", async () => {
    shard.roster = { ...shard.roster, providers: { ...(shard.roster as any).providers, "tts-ghost": { resolvesVoices: false, serves: [{ model: "pocket-tts", key: "ghost-key" }] } } } as any;
    const app = await plane();
    const res = await patch(app, { serviceId: "tts-ghost", model: "pocket-tts", voice: "eponine" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("tts-ghost");
    expect(res.body.error).toContain("not a registered service");
    expect((await stored()).tts.selection.serviceId).toBe("fluid-tts");
  });

  it("[T2] still refuses a service of the wrong capability", async () => {
    const app = await plane();
    const res = await patch(app, { serviceId: "stt-stream", model: "pocket-tts", voice: "nicole" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("stt-stream");
    expect((await stored()).tts.selection.serviceId).toBe("fluid-tts");
  });
});

describe("the STT selection route", () => {
  const accepts = async (app: App, id: string) => {
    const res = await patch(app, { sttServiceId: id });
    expect(res.status, `${id}: ${JSON.stringify(res.body)}`).toBe(200);
    expect((await stored()).stt.serviceId).toBe(id);
  };
  const refuses = async (app: App, id: string, operation?: string) => {
    const before = (await stored()).stt.serviceId;
    const res = await patch(app, { sttServiceId: id });
    expect(res.status, id).toBe(400);
    expect(res.body.error).toContain(id);
    if (operation) expect(res.body.error).toContain(`${id} cannot ${operation}`);
    expect((await stored()).stt.serviceId).toBe(before);
  };

  it("[T2] for a streaming model requires a streaming candidate in which the client decides where an utterance ends", async () => {
    const app = await plane({ sttModel: STREAMING, stt: "stt-batch" });
    await accepts(app, "stt-stream");
    await accepts(app, "stt-both");
    await accepts(app, "stt-listen-off");
    await refuses(app, "stt-batch", "transcribeStream");
    await refuses(app, "stt-listen-plain", "transcribeStream");
    await refuses(app, "stt-none", "transcribeStream");
  });

  it("[T2] for a batch model requires a transcribe candidate", async () => {
    const app = await plane({ sttModel: BATCH, stt: "stt-stream" });
    await accepts(app, "stt-batch");
    await accepts(app, "stt-both");
    await refuses(app, "stt-stream", "transcribe");
    await refuses(app, "stt-none", "transcribe");
  });

  it("[T2] for a model of both kinds takes either, and a service with neither is refused", async () => {
    const app = await plane({ sttModel: BOTH, stt: "stt-none" });
    await accepts(app, "stt-stream");
    await accepts(app, "stt-batch");
    await refuses(app, "stt-none");
    await refuses(app, "stt-listen-plain");
  });

  it("[T2] with no STT model stored takes either operation, so a streaming-only and a batch-only service pass and one with neither is refused", async () => {
    const app = await plane({ noSttModel: true, stt: "stt-none" });
    await accepts(app, "stt-stream");
    await accepts(app, "stt-batch");
    await refuses(app, "stt-none");
    await refuses(app, "stt-listen-plain");
  });

  it("[T2] still refuses a service of the wrong capability, and an unknown one", async () => {
    const app = await plane({ sttModel: BOTH });
    await refuses(app, "fluid-tts");
    await refuses(app, "no-such-service");
  });
});

describe("stored selections, checked again when the assembled roster changes", () => {
  it("[T2] serve no failure while every stored selection passes", async () => {
    const body = await getVoice(await plane());
    expect(body.tts.selection).not.toHaveProperty("selectionError");
    expect(body.stt).not.toHaveProperty("selectionError");
  });

  it("[T2] after the first poll, serve a failure beside each selection that fails, with the control plane up", async () => {
    shard.services = shard.services.map(s => (s.id === "fluid-tts" ? service("fluid-tts", "tts") : s));
    const app = await plane({ tts: "fluid-tts", stt: "stt-batch", sttModel: STREAMING });

    const res = await app.fetch(new Request("http://localhost/api/voice"));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.tts.selection.selectionError).toContain("fluid-tts cannot synthesize");
    expect(body.stt.selectionError).toContain("stt-batch cannot transcribeStream");
    // The selection itself is served as stored.
    expect(body.tts.selection).toMatchObject({ serviceId: "fluid-tts", model: "pocket-tts", voice: "nicole" });
    expect(body.stt).toMatchObject({ serviceId: "stt-batch", model: STREAMING });
  });

  it("[T2] after a poll in which the shard stops declaring what a selection needs, serve the failure", async () => {
    const app = await plane({ tts: "tts-mlx-audio", stt: "stt-stream", sttModel: STREAMING });
    expect((await getVoice(app)).tts.selection).not.toHaveProperty("selectionError");

    shard.services = shard.services.map(s => (s.id === "tts-mlx-audio" ? service("tts-mlx-audio", "tts", NOT_SPEECH) : s));
    await poll(app);

    expect((await getVoice(app)).tts.selection.selectionError).toContain("tts-mlx-audio cannot synthesize");
  });

  it("[T2] after a poll in which the shard declares it, a served failure clears", async () => {
    shard.services = shard.services.map(s => (s.id === "stt-batch" ? service("stt-batch", "stt") : s));
    const app = await plane({ stt: "stt-batch", sttModel: BATCH });
    expect((await getVoice(app)).stt.selectionError).toContain("stt-batch");

    shard.services = shard.services.map(s => (s.id === "stt-batch" ? service("stt-batch", "stt", TRANSCRIBE) : s));
    await poll(app);

    expect((await getVoice(app)).stt).not.toHaveProperty("selectionError");
  });

  // The next two run on a plane with no shard, so a reload ends in no poll and only a
  // re-check made by the reload itself can produce the failure.
  it("[T2] after a config reload that stores a selection which fails, serve the failure, on a plane with no shard", async () => {
    const app = await plane({
      noShard: true, noSttModel: true, tts: "tts-local", stt: "stt-local",
      local: [local("tts-local", "tts", 9301, SPEECH), local("stt-local", "stt", 9302, TRANSCRIBE), local("stt-local-bare", "stt", 9303)],
    });
    expect((await getVoice(app)).stt).not.toHaveProperty("selectionError");
    expect(selectionLog()).toEqual([]);

    const onDisk = JSON.parse(await readFile(configPath, "utf-8"));
    onDisk.voice.stt.serviceId = "stt-local-bare";
    await writeFile(configPath, JSON.stringify(onDisk));
    await reload(app);

    expect((await getVoice(app)).stt.selectionError).toContain("stt-local-bare cannot");
  });

  it("[T2] after a registry reload that removes what a local service declared, serve the failure, on a plane with no shard", async () => {
    const app = await plane({
      noShard: true, noSttModel: true, tts: "tts-local", stt: "stt-local",
      local: [local("tts-local", "tts", 9301, SPEECH), local("stt-local", "stt", 9302, TRANSCRIBE)],
    });
    expect((await getVoice(app)).stt).not.toHaveProperty("selectionError");

    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    registry.services = [local("tts-local", "tts", 9301, SPEECH), local("stt-local", "stt", 9302)];
    await writeFile(registryPath, JSON.stringify(registry));
    await reload(app);

    expect((await getVoice(app)).stt.selectionError).toContain("stt-local cannot");
  });

  it("[T2] with no STT model stored, fails a stored service only when it has neither operation", async () => {
    expect((await getVoice(await plane({ noSttModel: true, stt: "stt-batch" }))).stt).not.toHaveProperty("selectionError");
    expect((await getVoice(await plane({ noSttModel: true, stt: "stt-none" }))).stt.selectionError).toContain("stt-none");
  });

  it("[T2] never stops the control plane: a stored selection that fails still starts it", async () => {
    const failing = await plane({ tts: "fluid-tts", stt: "stt-none", sttModel: STREAMING });
    expect((await failing.fetch(new Request("http://localhost/api/voice"))).status).toBe(200);
  });
});

describe("the selection log, written when the roster changes and not when it is read", () => {
  it("[T2] warns once per failing selection after the first poll, before anything reads GET /api/voice", async () => {
    shard.services = shard.services.map(s => (s.id === "fluid-tts" ? service("fluid-tts", "tts") : s));
    await plane({ tts: "fluid-tts", stt: "stt-batch", sttModel: STREAMING });
    await logHolds(2);

    const lines = selectionLog();
    expect(lines).toHaveLength(2);
    expect(lines.some(l => l.includes("fluid-tts cannot synthesize"))).toBe(true);
    expect(lines.some(l => l.includes("stt-batch cannot transcribeStream"))).toBe(true);
  });

  it("[T2] does not warn again for the same failure on a repeated read or a poll that changes nothing", async () => {
    shard.services = shard.services.map(s => (s.id === "fluid-tts" ? service("fluid-tts", "tts") : s));
    const app = await plane({ tts: "fluid-tts", stt: "stt-stream", sttModel: STREAMING });
    await logHolds(1);
    expect(selectionLog()).toHaveLength(1);

    await getVoice(app);
    await getVoice(app);
    await poll(app);
    await settle();

    expect(selectionLog()).toHaveLength(1);
  });

  it("[T2] writes nothing while every stored selection passes", async () => {
    const app = await plane();
    await getVoice(app);
    await poll(app);
    await settle();
    expect(selectionLog()).toEqual([]);
  });

  it("[T2] warns when a poll makes a passing selection fail, and again when it fails, clears and fails once more", async () => {
    const app = await plane({ tts: "tts-mlx-audio", stt: "stt-stream", sttModel: STREAMING });
    const breakIt = (provides?: unknown[]) => {
      shard.services = shard.services.map(s => (s.id === "tts-mlx-audio" ? service("tts-mlx-audio", "tts", provides) : s));
    };

    breakIt(NOT_SPEECH);
    await poll(app);
    await logHolds(1);
    expect(selectionLog()).toHaveLength(1);

    breakIt(SPEECH);
    await poll(app);
    await settle();
    expect(selectionLog()).toHaveLength(1);

    breakIt(NOT_SPEECH);
    await poll(app);
    await logHolds(2);
    expect(selectionLog()).toHaveLength(2);
  });

  it("[T2] warns again when a selection still fails but its message changes", async () => {
    shard.services = shard.services.map(s => (s.id === "stt-stream" ? service("stt-stream", "stt") : s));
    const app = await plane({ stt: "stt-stream", sttModel: STREAMING });
    await logHolds(1);
    expect(selectionLog()).toHaveLength(1);

    shard.services = shard.services.map(s => (s.id === "stt-stream" ? service("stt-stream", "stt", TRANSCRIBE) : s));
    await poll(app);
    await logHolds(2);

    expect(selectionLog()).toHaveLength(2);
    expect(selectionLog()[1]).toContain("openai.audio.transcriptions");
  });

  it("[T2] warns after a config reload that stores a failing selection, before anything reads GET /api/voice", async () => {
    const app = await plane({
      noShard: true, noSttModel: true, tts: "tts-local", stt: "stt-local",
      local: [local("tts-local", "tts", 9301, SPEECH), local("stt-local", "stt", 9302, TRANSCRIBE), local("stt-local-bare", "stt", 9303)],
    });
    await settle();
    expect(selectionLog()).toEqual([]);

    const onDisk = JSON.parse(await readFile(configPath, "utf-8"));
    onDisk.voice.stt.serviceId = "stt-local-bare";
    await writeFile(configPath, JSON.stringify(onDisk));
    await reload(app);
    await logHolds(1);

    expect(selectionLog().filter(l => l.includes("stt-local-bare cannot"))).toHaveLength(1);
  });
});

describe("a selection on a host no poll has reached", () => {
  it("[T2] reports no failure and writes no warning for any stored selection, and the control plane answers", async () => {
    const app = await plane({ tts: "fluid-tts", stt: "stt-none", sttModel: STREAMING, shardDown: true });

    const res = await app.fetch(new Request("http://localhost/api/voice"));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.tts.selection).not.toHaveProperty("selectionError");
    expect(body.stt).not.toHaveProperty("selectionError");
    expect(selectionLog()).toEqual([]);
  });
});
