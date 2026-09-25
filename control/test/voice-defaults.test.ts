import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlPlaneApp } from "../control-plane/src/app";
import { clearLocks } from "../shared/src/lifecycle";
import type { NodeRoster, Registry } from "../../shared/types";
import type { PlatformConfig } from "../control-plane/src/gateway-config";

let tmpDir: string;
let registryPath: string;
let eventsPath: string;
let configPath: string;

// What exists is the roster's; config.json names only the selection. Both
// providers are declared on the control plane's own registry (no shard) —
// which is what makes them resolvable without a poll.
const ROSTER: NodeRoster = {
  providers: {
    "tts-mlx-audio": {
      ttsModels: [{
        id: "kokoro-82m",
        name: "Kokoro 82M",
        key: "prince-canuma/Kokoro-82M",
        presetVoices: [
          { id: "bf_isabella", name: "Isabella" },
          { id: "af_heart", name: "Heart" },
        ],
      }],
    },
    "tts-other": {
      ttsModels: [{
        id: "other-model",
        name: "Other",
        key: "other-model",
        presetVoices: [{ id: "voice-a", name: "Voice A" }],
      }],
    },
  },
  voices: [],
};

function makeRegistry(roster: NodeRoster | undefined = ROSTER, shards: Registry["shards"] = []): Registry {
  return {
    version: 2,
    type: "control",
    hosts: [
      {
        id: "home-server",
        name: "home-server",
        hostname: "home-server.example.ts.net",
        role: "control",
      },
      // Present even when unused by a test's shards[]: hostId "gpu-machine"
      // in NEVER_POLLED_SHARD must resolve against a known host, or the
      // registry itself fails to load.
      {
        id: "gpu-machine",
        name: "gpu-machine",
        hostname: "127.0.0.1",
        role: "worker",
      },
    ],
    capabilities: [
      { id: "tts", name: "Text-to-Speech" },
    ],
    services: [
      {
        id: "tts-mlx-audio", name: "MLX Audio", capabilityId: "tts", hostId: "home-server",
        permissions: { enabled: true },
        runner: { type: "external" },
        network: { port: 8001, healthPath: "/health" },
      },
      {
        id: "tts-other", name: "Other TTS", capabilityId: "tts", hostId: "home-server",
        permissions: { enabled: true },
        runner: { type: "external" },
        network: { port: 8002, healthPath: "/health" },
      },
    ] as Registry["services"],
    shards,
    ...(roster !== undefined && { roster }),
  };
}

const BASE_CONFIG: PlatformConfig = {
  version: 1,
  voice: {
    enabled: true,
    tts: {
      selection: {
        serviceId: "tts-mlx-audio",
        model: "kokoro-82m",
        voice: "bf_isabella",
        speed: 1.0,
      },
      options: {
        chunkStrategy: "two-chunk",
        minChunkWords: 12,
        maxChunkWords: null,
      },
    },
    stt: { serviceId: "stt-fluid" },
  },
};

// roster undefined means "no roster section on the registry" (an empty
// roster, distinct from a never-polled shard); shards defaults to none, so
// every serviceId resolves purely from the control plane's own registry.
async function makeApp(cfg: PlatformConfig = BASE_CONFIG, roster: NodeRoster | undefined = ROSTER, shards: Registry["shards"] = []) {
  // Deep-clone so mutations in updateVoiceSelection don't bleed between tests
  const cloned: PlatformConfig = JSON.parse(JSON.stringify(cfg));
  await writeFile(configPath, JSON.stringify(cloned, null, 2));
  await writeFile(registryPath, JSON.stringify(makeRegistry(roster, shards), null, 2));
  return createControlPlaneApp({
    registryPath,
    eventsPath,
    checkService: async () => {},
    runFn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    pollHealthFn: async () => true,
    config: cloned,
    configPath,
  } as any);
}

beforeEach(async () => {
  clearLocks();
  tmpDir = await mkdtemp(join(tmpdir(), "voice-defaults-test-"));
  registryPath = join(tmpDir, "registry.json");
  eventsPath = join(tmpDir, "events.jsonl");
  configPath = join(tmpDir, "config.json");
  // makeApp writes registryPath itself, per call, since the roster/shards it
  // needs vary by test.
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("GET /api/voice", () => {
  it("lists a provider built from the control plane's own registry roster, no shard involved", async () => {
    const app = await makeApp();
    const res = await app.fetch(new Request("http://localhost/api/voice"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const provider = body.tts.providers.find((p: any) => p.serviceId === "tts-mlx-audio");
    expect(provider).toBeDefined();
    expect(provider.hostId).toBe("home-server");
    expect(provider.models.some((m: any) => m.id === "kokoro-82m")).toBe(true);
  });
});

describe("PATCH /api/voice/selection", () => {
  it("updates selected voice and persists to disk", async () => {
    const app = await makeApp();

    const res = await app.fetch(
      new Request("http://localhost/api/voice/selection", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice: "af_heart" }),
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tts.selection.voice).toBe("af_heart");
    // Other fields unchanged
    expect(body.tts.selection.serviceId).toBe("tts-mlx-audio");
    expect(body.tts.selection.model).toBe("kokoro-82m");

    // Verify persisted to disk
    const diskRaw = await readFile(configPath, "utf-8");
    const disk = JSON.parse(diskRaw);
    expect(disk.voice.tts.selection.voice).toBe("af_heart");
  });

  it("updates speed and persists to disk", async () => {
    const app = await makeApp();

    const res = await app.fetch(
      new Request("http://localhost/api/voice/selection", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ speed: 1.5 }),
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tts.selection.speed).toBe(1.5);
    // Other fields unchanged
    expect(body.tts.selection.voice).toBe("bf_isabella");
    expect(body.tts.options.chunkStrategy).toBe("two-chunk");

    const diskRaw = await readFile(configPath, "utf-8");
    const disk = JSON.parse(diskRaw);
    expect(disk.voice.tts.selection.speed).toBe(1.5);
  });

  it("updates chunkStrategy and minChunkWords", async () => {
    const app = await makeApp();

    const res = await app.fetch(
      new Request("http://localhost/api/voice/selection", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chunkStrategy: "sentence", minChunkWords: 20 }),
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tts.options.chunkStrategy).toBe("sentence");
    expect(body.tts.options.minChunkWords).toBe(20);
  });

  it("sets maxChunkWords to null", async () => {
    const app = await makeApp({
      ...BASE_CONFIG,
      voice: {
        ...BASE_CONFIG.voice!,
        tts: {
          ...BASE_CONFIG.voice!.tts!,
          options: { ...BASE_CONFIG.voice!.tts!.options, maxChunkWords: 50 },
        },
      },
    });

    const res = await app.fetch(
      new Request("http://localhost/api/voice/selection", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxChunkWords: null }),
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tts.options.maxChunkWords).toBeNull();
  });

  it("returns 400 for unknown serviceId", async () => {
    const app = await makeApp();

    const res = await app.fetch(
      new Request("http://localhost/api/voice/selection", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceId: "does-not-exist" }),
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/unknown serviceId/);
  });

  it("returns 400 for a voice the selected model does not offer", async () => {
    const app = await makeApp();
    const res = await app.fetch(
      new Request("http://localhost/api/voice/selection", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice: "voice-a" }),
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/unknown voice/);
  });

  // A shard on a port nothing listens on, so the poller's first poll fails
  // and its host stays never-polled: exactly what makes "cannot be checked"
  // distinguishable from "checked, and it isn't there". scheme:"http" so
  // the connection attempt fails fast on a closed port rather than on a
  // TLS handshake.
  const NEVER_POLLED_SHARD: Registry["shards"] = [{ hostId: "gpu-machine", port: 1, scheme: "http" }];

  it("returns 503 for a serviceId on a shard that has never been polled, and writes nothing", async () => {
    const app = await makeApp(BASE_CONFIG, ROSTER, NEVER_POLLED_SHARD);
    await new Promise((r) => setTimeout(r, 50)); // let the first (failing) poll attempt settle
    const res = await app.fetch(
      new Request("http://localhost/api/voice/selection", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceId: "shard-tts", model: "shard-model", voice: "voice-a" }),
      })
    );
    expect(res.status).toBe(503);
    const disk = JSON.parse(await readFile(configPath, "utf-8"));
    expect(disk.voice.tts.selection.model).toBe("kokoro-82m");
  });

  it("returns 400, not 503, for an unknown serviceId once every shard has been polled at least once", async () => {
    // No shards at all: nothing left unpolled, so an unresolvable serviceId
    // is an ordinary "not there" rather than "cannot be checked yet."
    const app = await makeApp(BASE_CONFIG, ROSTER, []);
    const res = await app.fetch(
      new Request("http://localhost/api/voice/selection", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceId: "does-not-exist" }),
      })
    );
    expect(res.status).toBe(400);
  });

  it("changes speed without touching the roster at all", async () => {
    const app = await makeApp(BASE_CONFIG, ROSTER, NEVER_POLLED_SHARD);
    const res = await app.fetch(
      new Request("http://localhost/api/voice/selection", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ speed: 1.2 }),
      })
    );
    expect(res.status).toBe(200);
  });

  it("returns 400 for speed below 0.5", async () => {
    const app = await makeApp();

    const res = await app.fetch(
      new Request("http://localhost/api/voice/selection", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ speed: 0.4 }),
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/speed/);
  });

  it("returns 400 for speed above 2.0", async () => {
    const app = await makeApp();

    const res = await app.fetch(
      new Request("http://localhost/api/voice/selection", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ speed: 2.1 }),
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/speed/);
  });

  it("returns 400 for invalid chunkStrategy", async () => {
    const app = await makeApp();

    const res = await app.fetch(
      new Request("http://localhost/api/voice/selection", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chunkStrategy: "streaming" }),
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/chunkStrategy/);
  });

  it("returns 400 for non-positive minChunkWords", async () => {
    const app = await makeApp();

    const res = await app.fetch(
      new Request("http://localhost/api/voice/selection", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ minChunkWords: 0 }),
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/minChunkWords/);
  });

  it("returns 400 for non-integer minChunkWords", async () => {
    const app = await makeApp();

    const res = await app.fetch(
      new Request("http://localhost/api/voice/selection", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ minChunkWords: 5.5 }),
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/minChunkWords/);
  });

  it("returns 400 for non-positive maxChunkWords", async () => {
    const app = await makeApp();

    const res = await app.fetch(
      new Request("http://localhost/api/voice/selection", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxChunkWords: -1 }),
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/maxChunkWords/);
  });

  it("returns 503 when voice is not configured", async () => {
    const cfgNoVoice: PlatformConfig = { version: 1 };
    await writeFile(configPath, JSON.stringify(cfgNoVoice, null, 2));
    await writeFile(registryPath, JSON.stringify(makeRegistry(), null, 2));
    const app = await createControlPlaneApp({
      registryPath,
      eventsPath,
        checkService: async () => {},
      runFn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      pollHealthFn: async () => true,
      config: cfgNoVoice,
      configPath,
    } as any);

    const res = await app.fetch(
      new Request("http://localhost/api/voice/selection", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ speed: 1.2 }),
      })
    );

    expect(res.status).toBe(503);
  });

  it("partial patch leaves other fields unchanged", async () => {
    const app = await makeApp();

    const res = await app.fetch(
      new Request("http://localhost/api/voice/selection", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ speed: 0.8 }),
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    // Only speed changed
    expect(body.tts.selection.speed).toBe(0.8);
    expect(body.tts.selection.serviceId).toBe("tts-mlx-audio");
    expect(body.tts.selection.model).toBe("kokoro-82m");
    expect(body.tts.selection.voice).toBe("bf_isabella");
    // Options unchanged
    expect(body.tts.options.chunkStrategy).toBe("two-chunk");
    expect(body.tts.options.minChunkWords).toBe(12);
    expect(body.tts.options.maxChunkWords).toBeNull();
  });

  it("accepts all valid chunk strategies", async () => {
    const strategies = ["two-chunk", "paragraph", "sentence"];
    for (const strategy of strategies) {
      const app = await makeApp();
      const res = await app.fetch(
        new Request("http://localhost/api/voice/selection", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chunkStrategy: strategy }),
        })
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tts.options.chunkStrategy).toBe(strategy);
    }
  });

  it("stores null for chunkStrategy rather than deleting the key or rejecting it", async () => {
    const app = await makeApp();

    const res = await app.fetch(
      new Request("http://localhost/api/voice/selection", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chunkStrategy: null }),
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tts.options.chunkStrategy).toBeNull();
  });

  it("stores null for minChunkWords rather than deleting the key or rejecting it", async () => {
    const app = await makeApp();

    const res = await app.fetch(
      new Request("http://localhost/api/voice/selection", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ minChunkWords: null }),
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tts.options.minChunkWords).toBeNull();
  });
});

describe("PATCH /api/voice/selection — modelPrefs", () => {
  it("a valid write lands on disk and in the response", async () => {
    const app = await makeApp();

    const res = await app.fetch(
      new Request("http://localhost/api/voice/selection", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelPrefs: {
            "tts-mlx-audio": {
              "kokoro-82m": {
                source: "overridden",
                chunking: { mode: "sentence", maxWords: 45 },
              },
            },
          },
        }),
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tts.modelPrefs["tts-mlx-audio"]["kokoro-82m"]).toEqual({
      source: "overridden",
      chunking: { mode: "sentence", maxWords: 45 },
    });

    const disk = JSON.parse(await readFile(configPath, "utf-8"));
    expect(disk.voice.tts.modelPrefs["tts-mlx-audio"]["kokoro-82m"]).toEqual({
      source: "overridden",
      chunking: { mode: "sentence", maxWords: 45 },
    });
  });

  it("a second patch replaces the entry wholesale, not merges it", async () => {
    const app = await makeApp();
    const key = { serviceId: "tts-mlx-audio", modelId: "kokoro-82m" };

    await app.fetch(
      new Request("http://localhost/api/voice/selection", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelPrefs: { [key.serviceId]: { [key.modelId]: { source: "overridden", chunking: { mode: "sentence", minWords: 5, maxWords: 45 } } } },
        }),
      })
    );

    const res = await app.fetch(
      new Request("http://localhost/api/voice/selection", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelPrefs: { [key.serviceId]: { [key.modelId]: { source: "overridden", chunking: { maxWords: 45 } } } },
        }),
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    // mode and minWords from the first write must NOT survive — full replace.
    expect(body.tts.modelPrefs[key.serviceId][key.modelId]).toEqual({
      source: "overridden",
      chunking: { maxWords: 45 },
    });
  });

  it("null deletes the entry and prunes an emptied serviceId bucket", async () => {
    const app = await makeApp();
    const key = { serviceId: "tts-mlx-audio", modelId: "kokoro-82m" };

    await app.fetch(
      new Request("http://localhost/api/voice/selection", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelPrefs: { [key.serviceId]: { [key.modelId]: { source: "overridden", chunking: { maxWords: 45 } } } },
        }),
      })
    );

    const res = await app.fetch(
      new Request("http://localhost/api/voice/selection", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelPrefs: { [key.serviceId]: { [key.modelId]: null } },
        }),
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tts.modelPrefs[key.serviceId]).toBeUndefined();
  });

  it("400 for an unknown serviceId", async () => {
    const app = await makeApp();
    const res = await app.fetch(
      new Request("http://localhost/api/voice/selection", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelPrefs: { "does-not-exist": { "some-model": { source: "global" } } } }),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/unknown serviceId/);
  });

  it("400 for an unknown model within a known serviceId", async () => {
    const app = await makeApp();
    const res = await app.fetch(
      new Request("http://localhost/api/voice/selection", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelPrefs: { "tts-mlx-audio": { "does-not-exist": { source: "global" } } } }),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/unknown model/);
  });

  it("400 for an invalid settingsScope", async () => {
    const app = await makeApp();
    const res = await app.fetch(
      new Request("http://localhost/api/voice/selection", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settingsScope: "nonsense" }),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/settingsScope/);
  });

  it("persists settingsScope so the choice survives a reload", async () => {
    const app = await makeApp();
    const res = await app.fetch(
      new Request("http://localhost/api/voice/selection", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settingsScope: "per-model" }),
      })
    );
    expect(res.status).toBe(200);
    const cfg = await app.fetch(new Request("http://localhost/api/voice"));
    const body = await cfg.json();
    expect(body.tts.settingsScope).toBe("per-model");
  });

  it("400 for an invalid chunking.mode", async () => {
    const app = await makeApp();
    const res = await app.fetch(
      new Request("http://localhost/api/voice/selection", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelPrefs: {
            "tts-mlx-audio": { "kokoro-82m": { source: "overridden", chunking: { mode: "streaming" } } },
          },
        }),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/modelPrefs chunking\.mode/);
  });

  it("a patch with no modelPrefs leaves an existing one untouched", async () => {
    const app = await makeApp();
    const key = { serviceId: "tts-mlx-audio", modelId: "kokoro-82m" };

    await app.fetch(
      new Request("http://localhost/api/voice/selection", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelPrefs: { [key.serviceId]: { [key.modelId]: { source: "overridden", chunking: { maxWords: 45 } } } },
        }),
      })
    );

    const res = await app.fetch(
      new Request("http://localhost/api/voice/selection", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ speed: 0.9 }),
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tts.modelPrefs[key.serviceId][key.modelId]).toEqual({
      source: "overridden",
      chunking: { maxWords: 45 },
    });
  });

  it("a config with no modelPrefs round-trips unchanged", async () => {
    const app = await makeApp();

    const res = await app.fetch(
      new Request("http://localhost/api/voice/selection", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ speed: 0.9 }),
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tts.modelPrefs).toBeUndefined();
  });

  it("source: global with a non-empty chunking survives untouched (gap A) — the server never normalizes", async () => {
    const app = await makeApp();
    const key = { serviceId: "tts-mlx-audio", modelId: "kokoro-82m" };

    const res = await app.fetch(
      new Request("http://localhost/api/voice/selection", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelPrefs: { [key.serviceId]: { [key.modelId]: { source: "global", chunking: { maxWords: 45 } } } },
        }),
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tts.modelPrefs[key.serviceId][key.modelId]).toEqual({
      source: "global",
      chunking: { maxWords: 45 },
    });
  });
});

describe("PATCH /api/voice/selection — listening tuning", () => {
  function patch(app: Awaited<ReturnType<typeof makeApp>>, body: unknown) {
    return app.fetch(
      new Request("http://localhost/api/voice/selection", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    );
  }

  it("merges vad and turnTaking fields into stt and persists them", async () => {
    const app = await makeApp({
      ...BASE_CONFIG,
      voice: {
        ...BASE_CONFIG.voice!,
        stt: {
          serviceId: "stt-fluid",
          vad: { minSpeechDurationS: 0.5, minSpeechProb: 0.9 },
          turnTaking: { pauseThresholdMs: 200, commitMaxDelayMs: 800, curve: { type: "power", exponent: 2 } },
        },
      },
    });

    const res = await patch(app, { vad: { minSpeechProb: 0.7 }, turnTaking: { pauseThresholdMs: 350 } });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stt.vad).toEqual({ minSpeechDurationS: 0.5, minSpeechProb: 0.7 });
    expect(body.stt.turnTaking).toEqual({ pauseThresholdMs: 350, commitMaxDelayMs: 800, curve: { type: "power", exponent: 2 } });
    expect(body.stt.serviceId).toBe("stt-fluid");

    const disk = JSON.parse(await readFile(configPath, "utf-8"));
    expect(disk.voice.stt.vad.minSpeechProb).toBe(0.7);
    expect(disk.voice.stt.turnTaking.pauseThresholdMs).toBe(350);
  });

  it("creates the sections when the config has none", async () => {
    const app = await makeApp();

    const res = await patch(app, { turnTaking: { smartTurnThreshold: 0.8 } });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stt.turnTaking).toEqual({ smartTurnThreshold: 0.8 });
  });

  it("rejects a field the dialog does not tune", async () => {
    const app = await makeApp();
    const res = await patch(app, { turnTaking: { interruptionMinRemainingS: 0.5 } });
    expect(res.status).toBe(400);
  });

  it("rejects a non-number, a negative duration and a probability above 1", async () => {
    const app = await makeApp();
    expect((await patch(app, { vad: { minSpeechDurationS: "0.5" } })).status).toBe(400);
    expect((await patch(app, { turnTaking: { pauseThresholdMs: -1 } })).status).toBe(400);
    expect((await patch(app, { vad: { minSpeechProb: 1.2 } })).status).toBe(400);
  });

  it("rejects a commit minimum above the maximum, counting the stored value", async () => {
    const app = await makeApp({
      ...BASE_CONFIG,
      voice: { ...BASE_CONFIG.voice!, stt: { serviceId: "stt-fluid", turnTaking: { commitMaxDelayMs: 800 } } },
    });

    const res = await patch(app, { turnTaking: { commitMinDelayMs: 900 } });

    expect(res.status).toBe(400);
    const disk = JSON.parse(await readFile(configPath, "utf-8"));
    expect(disk.voice.stt.turnTaking.commitMinDelayMs).toBeUndefined();
  });
});
