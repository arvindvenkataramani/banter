// POST /api/voices/resolve: the shard resolves a voice for a runtime that cannot
// read the registry (docs/reference/design/model-roster.md, "Reaching a resolution").
// The answer is a resolution (docs/reference/design/service-apis.md, "Provisions"):
// `{ model, voice: { name } | { recording, transcript? }, params? }`, which the
// caller hands to the synthesis adapter unchanged. The resolution rule itself is
// covered by the shared cases in control/test/voice-resolution.test.ts.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createShardApp } from "../src/shard-api";
import { loadRegistry } from "../../shared/src/registry";
import { clearFileLocks } from "../../shared/src/atomic-write";
import type { Registry } from "../../../shared/types";

const shared = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "schemas", "voice-resolution-cases.json"), "utf-8")) as {
  services: { id: string; capabilityId: string }[];
  roster: any;
};

let tmpDir: string;
let registry: Registry;

// The shared roster with its recordings moved under tmpDir, where the transcripts are real files.
async function load(edit: (roster: any) => void = () => {}): Promise<Registry> {
  const roster = JSON.parse(JSON.stringify(shared.roster).replaceAll('"/refs/', `"${tmpDir}/refs/`));
  edit(roster);
  for (const voice of roster.voices) {
    for (const rec of voice.recordings ?? []) {
      await mkdir(dirname(rec.text), { recursive: true });
      await writeFile(rec.text, `transcript of ${rec.audio.split("/").pop()}`);
    }
  }
  const doc = {
    version: 4,
    type: "shard",
    hosts: [{ id: "gpu-machine", name: "gpu-machine", hostname: "gpu-machine.example.ts.net", role: "worker" }],
    capabilities: [{ id: "tts", name: "TTS" }, { id: "stt", name: "STT" }],
    services: shared.services.map((s, i) => ({
      ...s,
      hostId: "gpu-machine",
      permissions: { enabled: true },
      runner: { type: "process", main: "true" },
      network: { port: 8000 + i, healthPath: "/health" },
    })),
    roster,
  };
  const path = join(tmpDir, "registry.json");
  await writeFile(path, JSON.stringify(doc));
  return loadRegistry(path);
}

beforeEach(async () => {
  clearFileLocks();
  tmpDir = await mkdtemp(join(tmpdir(), "voices-resolve-"));
});
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

async function resolve(body: Record<string, unknown>, reg?: Registry): Promise<{ status: number; body: any }> {
  registry = reg ?? (await load());
  const app = createShardApp({
    registryState: registry,
    eventsPath: join(tmpDir, "events.jsonl"),
    getFreeMem: async () => 4096,
    loadService: async () => ({ ok: true }),
    unloadService: async () => ({ ok: true }),
    sharedLifecycle: async () => Response.json({ success: true }),
  });
  const res = await app.fetch(new Request("http://localhost/api/voices/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

describe("POST /api/voices/resolve", () => {
  it("[T2] answers a runtime that resolves voices itself with the platform's model id and a voice name, and no recording", async () => {
    const res = await resolve({ voice: "alex", model: "luxtts", serviceId: "fluid-tts" });
    expect(res.status).toBe(200);
    expect(res.body.model).toBe("luxtts");
    expect(res.body.voice).toEqual({ name: "alex" });
  });

  it("[T2] answers any other runtime with its key for the model, the preset's key as the voice name, and the serving's request parameters as params", async () => {
    const res = await resolve({ voice: "eponine", model: "pocket-tts", serviceId: "tts-mlx-audio" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ model: "mlx-community/pocket-tts", voice: { name: "eponine" }, params: { streaming_interval: 4 } });
  });

  it("[T2] answers a clone with the recording's audio path as the voice, and no transcript for a model that does not use one", async () => {
    const res = await resolve({ voice: "nicole", model: "pocket-tts", serviceId: "tts-mlx-audio" });
    expect(res.status).toBe(200);
    expect(res.body.model).toBe("mlx-community/pocket-tts");
    expect(res.body.voice).toEqual({ recording: `${tmpDir}/refs/voices/nicole.wav` });
  });

  it("[T2] answers a clone for a model that uses a transcript with the transcript's contents, not its path", async () => {
    // LuxTTS is also served by the second runtime here, so the shard is the one resolving.
    const reg = await load(r => { r.providers["tts-mlx-audio"].serves.push({ model: "luxtts", key: "mlx-community/luxtts" }); });
    const res = await resolve({ voice: "alex", model: "luxtts", serviceId: "tts-mlx-audio" }, reg);
    expect(res.status).toBe(200);
    expect(res.body.model).toBe("mlx-community/luxtts");
    expect(res.body.voice).toEqual({ recording: `${tmpDir}/refs/voices-5s/alex.wav`, transcript: "transcript of alex.wav" });
  });

  it("[T2] refuses with a 400 naming the voice and the model", async () => {
    for (const body of [
      { voice: "no-such-voice", model: "pocket-tts", serviceId: "tts-mlx-audio" },
      { voice: "eponine", model: "luxtts", serviceId: "fluid-tts" },
      { voice: "nicole", model: "chatterbox", serviceId: "fluid-tts" },
    ]) {
      const res = await resolve(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain(body.voice);
      expect(res.body.error).toContain(body.model);
    }
  });
});
