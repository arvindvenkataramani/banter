import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlPlaneApp } from "../control-plane/src/app";
import { clearLocks } from "../shared/src/lifecycle";
import type { Registry } from "../../shared/types";
import type { PlatformConfig } from "../control-plane/src/gateway-config";

let tmpDir: string;
let registryPath: string;
let eventsPath: string;
let configPath: string;

const REGISTRY: Registry = {
  version: 2,
  type: "control",
  hosts: [
    {
      id: "home-server",
      name: "home-server",
      hostname: "home-server.example.ts.net",
      role: "control",
    },
  ],
  capabilities: [
    { id: "tts", name: "Text-to-Speech" },
  ],
  services: [],
  shards: [],
};

const BASE_CONFIG: PlatformConfig = {
  version: 1,
  voice: {
    enabled: true,
    tts: {
      providers: [
        {
          serviceId: "tts-mlx-audio",
          models: [
            {
              id: "prince-canuma/Kokoro-82M",
              voices: [
                { id: "bf_isabella", name: "Isabella" },
                { id: "af_heart", name: "Heart" },
              ],
            },
          ],
        },
        {
          serviceId: "tts-other",
          models: [
            {
              id: "other-model",
              voices: [
                { id: "voice-a", name: "Voice A" },
              ],
            },
          ],
        },
      ],
      selection: {
        serviceId: "tts-mlx-audio",
        model: "prince-canuma/Kokoro-82M",
        voice: "bf_isabella",
        speed: 1.0,
      },
      options: {
        chunkStrategy: "two-chunk",
        minChunkWords: 12,
        maxChunkWords: null,
      },
    },
    stt: { serviceId: "stt-parakeet" },
  },
};

async function makeApp(cfg: PlatformConfig = BASE_CONFIG) {
  // Deep-clone so mutations in updateVoiceSelection don't bleed between tests
  const cloned: PlatformConfig = JSON.parse(JSON.stringify(cfg));
  await writeFile(configPath, JSON.stringify(cloned, null, 2));
  return createControlPlaneApp({
    registryPath,
    eventsPath,
    checkService: async () => {},
    runFn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    pollHealthFn: async () => true,
    config: cloned,
    configPath,
  });
}

beforeEach(async () => {
  clearLocks();
  tmpDir = await mkdtemp(join(tmpdir(), "voice-defaults-test-"));
  registryPath = join(tmpDir, "registry.json");
  eventsPath = join(tmpDir, "events.jsonl");
  configPath = join(tmpDir, "config.json");

  await writeFile(registryPath, JSON.stringify(REGISTRY, null, 2));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
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
    expect(body.tts.selection.model).toBe("prince-canuma/Kokoro-82M");

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
    const app = await createControlPlaneApp({
      registryPath,
      eventsPath,
      checkService: async () => {},
      runFn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      pollHealthFn: async () => true,
      config: cfgNoVoice,
      configPath,
    });

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
    expect(body.tts.selection.model).toBe("prince-canuma/Kokoro-82M");
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
              "prince-canuma/Kokoro-82M": {
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
    expect(body.tts.modelPrefs["tts-mlx-audio"]["prince-canuma/Kokoro-82M"]).toEqual({
      source: "overridden",
      chunking: { mode: "sentence", maxWords: 45 },
    });

    const disk = JSON.parse(await readFile(configPath, "utf-8"));
    expect(disk.voice.tts.modelPrefs["tts-mlx-audio"]["prince-canuma/Kokoro-82M"]).toEqual({
      source: "overridden",
      chunking: { mode: "sentence", maxWords: 45 },
    });
  });

  it("a second patch replaces the entry wholesale, not merges it", async () => {
    const app = await makeApp();
    const key = { serviceId: "tts-mlx-audio", modelId: "prince-canuma/Kokoro-82M" };

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
    const key = { serviceId: "tts-mlx-audio", modelId: "prince-canuma/Kokoro-82M" };

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
            "tts-mlx-audio": { "prince-canuma/Kokoro-82M": { source: "overridden", chunking: { mode: "streaming" } } },
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
    const key = { serviceId: "tts-mlx-audio", modelId: "prince-canuma/Kokoro-82M" };

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
    const key = { serviceId: "tts-mlx-audio", modelId: "prince-canuma/Kokoro-82M" };

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
