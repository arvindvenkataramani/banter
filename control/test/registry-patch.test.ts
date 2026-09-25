import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry, updateService } from "../shared/src/registry";
import type { NodeRoster, Registry } from "../../shared/types";

let tmpDir: string;
let registryPath: string;

const REGISTRY: Registry = {
  version: 2,
  type: "shard",
  hosts: [
    { id: "gpu-machine", name: "gpu-machine", hostname: "gpu-machine.example.ts.net", role: "worker" },
  ],
  capabilities: [{ id: "research", name: "Research" }],
  services: [
    {
      id: "pdf-ocr",
      capabilityId: "research",
      hostId: "gpu-machine",
      permissions: { enabled: true, protected: false },
      runner: { type: "process", main: ".venv/bin/server" },
      network: { port: 8006, healthPath: "/", listenAddress: "127.0.0.1" },
      lifecycle: {
        loadStrategy: "demand",
        idleUnload: true,
        idleTimeout: 1800000,
        startupTime: 60000,
        maxRestarts: 3,
        restartBackoff: 5000,
      },
    },
  ],
} as unknown as Registry;

async function freshState(): Promise<Registry> {
  await writeFile(registryPath, JSON.stringify(REGISTRY, null, 2));
  return loadRegistry(registryPath);
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "registry-patch-"));
  registryPath = join(tmpDir, "registry.json");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("updateService — notes", () => {
  it("round-trips a note through disk", async () => {
    const state = await freshState();
    await updateService(state, registryPath, "pdf-ocr", { notes: "run with --grounded" });

    const reloaded = await loadRegistry(registryPath);
    expect(reloaded.services[0].notes).toBe("run with --grounded");
  });

  it("clears the note on null, leaving no key behind", async () => {
    const state = await freshState();
    await updateService(state, registryPath, "pdf-ocr", { notes: "temporary" });
    const updated = await updateService(state, registryPath, "pdf-ocr", { notes: null });

    expect("notes" in updated).toBe(false);

    const reloaded = await loadRegistry(registryPath);
    expect("notes" in reloaded.services[0]).toBe(false);
  });

  it("rejects a non-string note", async () => {
    const state = await freshState();
    await expect(
      updateService(state, registryPath, "pdf-ocr", { notes: 42 as unknown as string })
    ).rejects.toThrow("notes must be a string");
  });
});

describe("updateService — clearing optional fields", () => {
  it("clears listenAddress and re-derives the endpoint from the host", async () => {
    const state = await freshState();
    const updated = await updateService(state, registryPath, "pdf-ocr", {
      network: { listenAddress: null },
    });

    expect(updated.network.listenAddress).toBeUndefined();
    expect(updated.network.endpoint).toBe("http://gpu-machine.example.ts.net:8006");

    const reloaded = await loadRegistry(registryPath);
    expect("listenAddress" in reloaded.services[0].network).toBe(false);
  });

  it("clears the optional lifecycle numerics", async () => {
    const state = await freshState();
    const updated = await updateService(state, registryPath, "pdf-ocr", {
      lifecycle: { idleTimeout: null, startupTime: null, maxRestarts: null, restartBackoff: null },
    });

    expect("idleTimeout" in updated.lifecycle!).toBe(false);
    expect("startupTime" in updated.lifecycle!).toBe(false);
    expect("maxRestarts" in updated.lifecycle!).toBe(false);
    expect("restartBackoff" in updated.lifecycle!).toBe(false);

    const reloaded = await loadRegistry(registryPath);
    expect("idleTimeout" in reloaded.services[0].lifecycle!).toBe(false);
  });
});

describe("updateService — required fields stay required", () => {
  it("refuses to clear the port", async () => {
    const state = await freshState();
    await expect(
      updateService(state, registryPath, "pdf-ocr", { network: { port: null } })
    ).rejects.toThrow("network.port cannot be cleared");
  });

  it("refuses to clear the healthPath", async () => {
    const state = await freshState();
    await expect(
      updateService(state, registryPath, "pdf-ocr", { network: { healthPath: null } })
    ).rejects.toThrow("network.healthPath cannot be cleared");
  });

  it("refuses to clear the hostId", async () => {
    const state = await freshState();
    await expect(
      updateService(state, registryPath, "pdf-ocr", { hostId: null as unknown as string })
    ).rejects.toThrow("hostId cannot be cleared");
  });

  it("leaves the registry loadable after a refused clear", async () => {
    const state = await freshState();
    await updateService(state, registryPath, "pdf-ocr", { notes: "keep me" }).catch(() => {});
    await updateService(state, registryPath, "pdf-ocr", { network: { port: null } }).catch(() => {});

    const reloaded = await loadRegistry(registryPath);
    expect(reloaded.services[0].network.port).toBe(8006);
  });
});

describe("updateService — roster", () => {
  const ROSTER: NodeRoster = {
    providers: {
      "pdf-ocr": {
        sttModels: [{ id: "m", name: "M", key: "k", kind: "batch" }],
      },
    },
    voices: [],
  };

  it("a service edit leaves a registry's roster section unchanged on disk", async () => {
    await writeFile(registryPath, JSON.stringify({ ...REGISTRY, roster: ROSTER }, null, 2));
    const state = await loadRegistry(registryPath);

    await updateService(state, registryPath, "pdf-ocr", { notes: "edited" });

    const onDisk = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(onDisk.roster).toEqual(ROSTER);
  });

  it("a service edit on a registry with no roster section writes none back", async () => {
    // REGISTRY carries no roster section; loadRegistry defaults it to an
    // empty one in memory (validateRoster), which updateService's write
    // must not turn into an on-disk section the file never had.
    await freshState();
    const state = await loadRegistry(registryPath);

    await updateService(state, registryPath, "pdf-ocr", { notes: "edited" });

    const onDisk = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(onDisk.roster).toBeUndefined();
  });
});
