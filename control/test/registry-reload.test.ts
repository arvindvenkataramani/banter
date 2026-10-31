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
      capabilityId: "tts",
      hostId: "gpu-machine",
      permissions: { enabled: true },
      runner: { type: "process", main: ".venv/bin/server" },
      network: { port: 8001, healthPath: "/health" },
    }],
    roster: { providers: { "svc-a": { sttModels: [{ id: "m", name: "M", key: "k", kind: "batch" }] } }, voices: [] },
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
    ["a provider's roster section changed", d => { d.roster.providers["svc-a"].sttModels[0].name = "M v2"; }, false, [{ kind: "provider-changed", serviceId: "svc-a" }]],
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

  it("applies the roster at once, and leaves shards and intervals for a restart", async () => {
    const live = await liveThenEdit(d => {
      d.roster.providers["svc-a"].sttModels[0].name = "M v2";
      d.shards[0].port = 9999;
      d.intervals.healthMs = 30000;
    });
    await reloadRegistry(registryPath, live, () => false);

    expect(live.roster?.providers["svc-a"].sttModels?.[0].name).toBe("M v2");
    expect(live.shards?.[0].port).toBe(5007);
    expect(live.intervals).toEqual({ healthMs: 60000 });
  });
});
