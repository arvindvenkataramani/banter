// Reloading a running node's registry from disk.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry, reloadRegistry } from "../shared/src/registry";
import { clearFileLocks, withFileLock } from "../shared/src/atomic-write";
import type { Registry } from "../../shared/types";

let tmpDir: string;
let registryPath: string;

type Doc = Record<string, any>;

function base(): Doc {
  return {
    version: 2,
    type: "control",
    hosts: [
      { id: "gpu-machine", name: "gpu-machine", hostname: "gpu-machine.example.ts.net", role: "worker" },
      { id: "home-server", name: "home-server", hostname: "home-server.example.ts.net", role: "control" },
    ],
    capabilities: [{ id: "tts", name: "Text-to-Speech" }],
    services: [{
      id: "svc-a",
      provides: [{ api: "openai.audio.speech" }],
      capabilityId: "tts",
      hostId: "gpu-machine",
      permissions: { enabled: true },
      runner: { type: "process", main: ".venv/bin/server" },
      network: { port: 8001, healthPath: "/health" },
    }],
    roster: { ttsModels: [{ id: "m", name: "M" }], sttModels: [], providers: { "svc-a": { resolvesVoices: false, serves: [{ model: "m", key: "k" }] } }, voices: [] },
    shards: [{ hostId: "gpu-machine", port: 5007 }],
    intervals: { healthMs: 60000 },
  };
}

/** Loads `base()` as the live registry, then writes it again with `edit` applied. */
async function liveThenEdit(edit: (doc: Doc) => void): Promise<Registry> {
  await writeFile(registryPath, JSON.stringify(base()));
  const live = await loadRegistry(registryPath);
  const doc = base();
  edit(doc);
  await writeFile(registryPath, JSON.stringify(doc));
  return live;
}

beforeEach(async () => {
  clearFileLocks();
  tmpDir = await mkdtemp(join(tmpdir(), "registry-reload-"));
  registryPath = join(tmpDir, "registry.json");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("reloadRegistry", () => {
  it.each([
    ["a file that is not JSON", "{ not valid json"],
    ["a file that fails validation", JSON.stringify({ ...base(), services: [{ id: "svc-a" }] })],
    ["[T1] a provision whose omits names a part its API's index lacks", JSON.stringify((() => { const d = base(); d.services[0].provides = [{ api: "openai.audio.speech", omits: ["parameter:nonesuch"] }]; return d; })())],
  ])("reports %s and leaves the live registry untouched", async (_, contents) => {
    await writeFile(registryPath, JSON.stringify(base()));
    const live = await loadRegistry(registryPath);
    await writeFile(registryPath, contents);

    expect((await reloadRegistry(registryPath, live, () => false)).ok).toBe(false);
    expect(live.services[0].network.port).toBe(8001);
  });

  it("refills the arrays callers already hold, keeping each surviving service's runtime state", async () => {
    const live = await liveThenEdit(d => { d.services[0].notes = "edited"; });
    live.services[0].state = { loadTime: 12345 };
    const held = live.services;

    expect((await reloadRegistry(registryPath, live, () => false)).ok).toBe(true);
    expect(live.services).toBe(held);
    expect(held[0].notes).toBe("edited");
    expect(held[0].state?.loadTime).toBe(12345);
  });

  it("waits for the registry's file lock, as a write does", async () => {
    const live = await liveThenEdit(() => {});
    let release!: () => void;
    const held = withFileLock(registryPath, () => new Promise<void>(r => { release = r; }));
    let done = false;
    const reload = reloadRegistry(registryPath, live, () => false).then(r => { done = true; return r; });

    await new Promise(r => setTimeout(r, 20));
    expect(done).toBe(false);
    release();
    await held;
    expect((await reload).ok).toBe(true);
  });

  const WARNINGS: [string, (doc: Doc) => void, boolean, Record<string, unknown>[]][] = [
    ["nothing changed", () => {}, true, []],
    ["a provider's roster section changed", d => { d.roster.providers["svc-a"].serves[0].key = "k2"; }, false, [{ kind: "provider-changed", serviceId: "svc-a" }]],
    ["a running service was removed", d => { d.services = []; d.roster = undefined; }, true, [{ kind: "service-removed", serviceId: "svc-a" }, { kind: "provider-changed", serviceId: "svc-a" }]],
    ["a stopped service was removed", d => { d.services = []; d.roster = undefined; }, false, [{ kind: "provider-changed", serviceId: "svc-a" }]],
    ["the shards list changed", d => { d.shards[0].port = 9999; }, false, [{ kind: "shards-changed" }]],
    ["the intervals changed", d => { d.intervals.healthMs = 30000; }, false, [{ kind: "intervals-changed" }]],
  ];
  it.each(WARNINGS)("when %s, warns accordingly", async (_, edit, running, expected) => {
    const live = await liveThenEdit(edit);
    const result = await reloadRegistry(registryPath, live, () => running);
    if (!result.ok) throw new Error(result.error);
    expect(result.warnings).toEqual(expected.map(w => expect.objectContaining(w)));
  });

  describe("when a voice changes", () => {
    // Two synthesis providers: one handed the registry, which resolves voices
    // for itself and read them at startup, and one that is not.
    const VOICE = {
      id: "nicole",
      name: "Nicole",
      recordings: [{ audio: "/refs/nicole.wav", text: "/refs/nicole.txt", durationS: 8, sampleRate: 24000 }],
      renderings: [{ model: "clones", method: "clone" }],
    };
    const serving = (id: string) => ({ resolvesVoices: false, serves: [{ model: id, key: id }] });
    function withVoices(voices: unknown[]): Doc {
      const doc = base();
      const service = (id: string, main: string, port: number) => ({ ...doc.services[0], id, runner: { type: "process", main }, network: { port, healthPath: "/health" } });
      doc.services = [
        service("svc-built", "server --registry {registry} --provider svc-built", 8001),
        service("svc-third-party", ".venv/bin/server", 8002),
      ];
      doc.roster = {
        ttsModels: [{ id: "clones", name: "clones", cloning: { requiresText: false } }, { id: "other", name: "other", cloning: { requiresText: false } }],
        sttModels: [],
        providers: { "svc-built": { ...serving("clones"), resolvesVoices: true }, "svc-third-party": serving("other") },
        voices,
      };
      return doc;
    }

    it("names only the server that reads the registry as needing a restart", async () => {
      await writeFile(registryPath, JSON.stringify(withVoices([VOICE])));
      const live = await loadRegistry(registryPath);
      const edited = { ...VOICE, recordings: [{ ...VOICE.recordings[0], audio: "/refs/nicole-v2.wav" }] };
      await writeFile(registryPath, JSON.stringify(withVoices([edited])));

      const result = await reloadRegistry(registryPath, live, () => false);
      if (!result.ok) throw new Error(result.error);
      expect(result.warnings).toEqual([expect.objectContaining({ kind: "provider-changed", serviceId: "svc-built" })]);
    });

    it("names nothing when the voices are as they were", async () => {
      await writeFile(registryPath, JSON.stringify(withVoices([VOICE])));
      const live = await loadRegistry(registryPath);
      const result = await reloadRegistry(registryPath, live, () => false);
      if (!result.ok) throw new Error(result.error);
      expect(result.warnings).toEqual([]);
    });
  });

  it("applies the roster at once, and leaves shards and intervals for a restart", async () => {
    const live = await liveThenEdit(d => {
      d.roster.providers["svc-a"].serves[0].key = "k2";
      d.shards[0].port = 9999;
      d.intervals.healthMs = 30000;
    });
    await reloadRegistry(registryPath, live, () => false);

    expect(live.roster?.providers["svc-a"].serves[0].key).toBe("k2");
    expect(live.shards?.[0].port).toBe(5007);
    expect(live.intervals).toEqual({ healthMs: 60000 });
  });
});

describe("when a service's provisions change", () => {
  // INVENTED: the design says the reload's warnings name a server that reads its own
  // provisions at startup, "as they do for a roster change"; this reuses that warning's kind.
  const before = [{ api: "openai.audio.speech" }];
  const after = [{ api: "openai.audio.speech", omits: ["parameter:instructions"] }];
  const doc = (main: string, provides: unknown[]): Doc => {
    const d = base();
    d.services[0].runner = { type: "process", main };
    d.services[0].provides = provides;
    return d;
  };

  it("[T1] names the server that reads the registry as needing a restart", async () => {
    const main = "server --registry {registry} --provider svc-a";
    await writeFile(registryPath, JSON.stringify(doc(main, before)));
    const live = await loadRegistry(registryPath);
    await writeFile(registryPath, JSON.stringify(doc(main, after)));

    const result = await reloadRegistry(registryPath, live, () => true);
    if (!result.ok) throw new Error(result.error);
    expect(result.warnings).toEqual([expect.objectContaining({ kind: "provider-changed", serviceId: "svc-a" })]);
  });

  // INVENTED: a server that does not read the registry has nothing to restart, so the reload says nothing of it.
  it("[T1] applies a change to a server that does not read the registry, with nothing to restart", async () => {
    const main = ".venv/bin/server";
    await writeFile(registryPath, JSON.stringify(doc(main, before)));
    const live = await loadRegistry(registryPath);
    await writeFile(registryPath, JSON.stringify(doc(main, after)));

    const result = await reloadRegistry(registryPath, live, () => true);
    if (!result.ok) throw new Error(result.error);
    expect(result.warnings).toEqual([]);
    expect((live.services[0] as any).provides).toEqual(after);
  });
});
