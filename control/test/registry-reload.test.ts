// Tests for reloadRegistry (docs/design/config-reload.md). Same shape as
// registry-patch.test.ts: write a registry, load it, edit the file on disk,
// reload, assert on the same live object the loader returned.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry, reloadRegistry } from "../shared/src/registry";
import { clearFileLocks, withFileLock } from "../shared/src/atomic-write";
import type { NodeRoster, Registry } from "../../shared/types";

let tmpDir: string;
let registryPath: string;

const REGISTRY: Registry = {
  version: 2,
  type: "shard",
  hosts: [
    { id: "gpu-machine", name: "gpu-machine", hostname: "gpu-machine.example.ts.net", role: "worker" },
  ],
  capabilities: [{ id: "tts", name: "Text-to-Speech" }],
  services: [
    {
      id: "svc-a",
      capabilityId: "tts",
      hostId: "gpu-machine",
      permissions: { enabled: true, protected: false },
      runner: { type: "process", main: ".venv/bin/server" },
      network: { port: 8001, healthPath: "/health" },
      lifecycle: { loadStrategy: "demand", idleUnload: true, idleTimeout: 1800000 },
    },
  ],
} as unknown as Registry;

async function freshState(registry: Registry = REGISTRY): Promise<Registry> {
  await writeFile(registryPath, JSON.stringify(registry, null, 2));
  return loadRegistry(registryPath);
}

const alwaysRunning = () => true;
const neverRunning = () => false;

beforeEach(async () => {
  clearFileLocks();
  tmpDir = await mkdtemp(join(tmpdir(), "registry-reload-"));
  registryPath = join(tmpDir, "registry.json");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("reloadRegistry — malformed file", () => {
  it("leaves the live registry untouched and reports the validation error", async () => {
    const state = await freshState();
    await writeFile(registryPath, "{ not valid json");

    const result = await reloadRegistry(registryPath, state, neverRunning);

    expect(result.ok).toBe(false);
    expect(state.services).toHaveLength(1);
    expect(state.services[0].id).toBe("svc-a");
  });

  it("reports a failed structural validation the same way", async () => {
    const state = await freshState();
    const bad = { ...REGISTRY, services: [{ id: "svc-a" }] };
    await writeFile(registryPath, JSON.stringify(bad, null, 2));

    const result = await reloadRegistry(registryPath, state, neverRunning);

    expect(result.ok).toBe(false);
    expect(state.services[0].network.port).toBe(8001);
  });
});

describe("reloadRegistry — runtime state", () => {
  it("a service present before and after keeps its state, loadTime included", async () => {
    const state = await freshState();
    state.services[0].state = { loadTime: 12345 };

    const edited = { ...REGISTRY, services: [{ ...REGISTRY.services[0], notes: "edited" }] };
    await writeFile(registryPath, JSON.stringify(edited, null, 2));

    const result = await reloadRegistry(registryPath, state, neverRunning);

    expect(result.ok).toBe(true);
    expect(state.services[0].notes).toBe("edited");
    expect(state.services[0].state?.loadTime).toBe(12345);
  });
});

describe("reloadRegistry — refills, never reassigns", () => {
  it("mutates the same services array in place, so a caller holding a reference sees the new contents", async () => {
    const state = await freshState();
    const servicesRef = state.services;

    const edited = { ...REGISTRY, services: [{ ...REGISTRY.services[0], notes: "changed" }] };
    await writeFile(registryPath, JSON.stringify(edited, null, 2));

    await reloadRegistry(registryPath, state, neverRunning);

    expect(state.services).toBe(servicesRef);
    expect(servicesRef[0].notes).toBe("changed");
  });
});

describe("reloadRegistry — file lock", () => {
  it("holds the registry's file lock across the reload, as updateService does", async () => {
    const state = await freshState();

    let release: (() => void) | undefined;
    const held = withFileLock(registryPath, () => new Promise<void>(r => { release = r; }));

    let resolved = false;
    const reloadPromise = reloadRegistry(registryPath, state, neverRunning).then(r => { resolved = true; return r; });

    await new Promise(r => setTimeout(r, 20));
    expect(resolved).toBe(false);

    release!();
    await held;
    const result = await reloadPromise;
    expect(result.ok).toBe(true);
  });
});

describe("reloadRegistry — provider-changed warning", () => {
  const withRoster = (roster: NodeRoster): Registry => ({ ...REGISTRY, roster });

  it("names a provider whose roster section changed", async () => {
    const before: NodeRoster = {
      providers: { "svc-a": { sttModels: [{ id: "m", name: "M", key: "k", kind: "batch" }] } },
      voices: [],
    };
    const state = await freshState(withRoster(before));

    const after: NodeRoster = {
      providers: { "svc-a": { sttModels: [{ id: "m", name: "M v2", key: "k", kind: "batch" }] } },
      voices: [],
    };
    await writeFile(registryPath, JSON.stringify(withRoster(after), null, 2));

    const result = await reloadRegistry(registryPath, state, neverRunning);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toContainEqual(
        expect.objectContaining({ kind: "provider-changed", serviceId: "svc-a" })
      );
    }
    expect(state.roster?.providers["svc-a"].sttModels?.[0].name).toBe("M v2");
  });

  it("does not warn when the roster section is unchanged", async () => {
    const roster: NodeRoster = {
      providers: { "svc-a": { sttModels: [{ id: "m", name: "M", key: "k", kind: "batch" }] } },
      voices: [],
    };
    const state = await freshState(withRoster(roster));
    await writeFile(registryPath, JSON.stringify(withRoster(roster), null, 2));

    const result = await reloadRegistry(registryPath, state, neverRunning);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings).toEqual([]);
  });
});

describe("reloadRegistry — service-removed warning", () => {
  it("names a service removed from the file while it is running", async () => {
    const state = await freshState();
    const edited = { ...REGISTRY, services: [] };
    await writeFile(registryPath, JSON.stringify(edited, null, 2));

    const result = await reloadRegistry(registryPath, state, alwaysRunning);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toContainEqual(
        expect.objectContaining({ kind: "service-removed", serviceId: "svc-a" })
      );
    }
    expect(state.services).toHaveLength(0);
  });

  it("does not warn when the removed service was not running", async () => {
    const state = await freshState();
    const edited = { ...REGISTRY, services: [] };
    await writeFile(registryPath, JSON.stringify(edited, null, 2));

    const result = await reloadRegistry(registryPath, state, neverRunning);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings).toEqual([]);
  });
});

describe("reloadRegistry — shards-changed warning", () => {
  it("names a changed shards list and leaves live.shards untouched", async () => {
    const withShard: Registry = {
      ...REGISTRY,
      hosts: [...REGISTRY.hosts, { id: "home-server", name: "home-server", hostname: "home-server.example.ts.net", role: "control" }],
      shards: [{ hostId: "home-server", port: 5007 }],
    };
    const state = await freshState(withShard);
    const shardsBefore = state.shards;

    const edited = { ...withShard, shards: [{ hostId: "home-server", port: 9999 }] };
    await writeFile(registryPath, JSON.stringify(edited, null, 2));

    const result = await reloadRegistry(registryPath, state, neverRunning);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toContainEqual(expect.objectContaining({ kind: "shards-changed" }));
    }
    expect(state.shards).toBe(shardsBefore);
    expect(state.shards?.[0].port).toBe(5007);
  });

  it("does not warn when the shards list is unchanged", async () => {
    const withShard: Registry = {
      ...REGISTRY,
      hosts: [...REGISTRY.hosts, { id: "home-server", name: "home-server", hostname: "home-server.example.ts.net", role: "control" }],
      shards: [{ hostId: "home-server", port: 5007 }],
    };
    const state = await freshState(withShard);
    await writeFile(registryPath, JSON.stringify(withShard, null, 2));

    const result = await reloadRegistry(registryPath, state, neverRunning);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings).toEqual([]);
  });
});
