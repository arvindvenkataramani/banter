import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry, updateService, setEnabled } from "../src/registry";

const validRegistry = {
  version: 2,
  type: "control" as const,
  hosts: [
    { id: "host1", name: "Host One", hostname: "host1.ts.net", role: "control" as const }
  ],
  capabilities: [
    { id: "cap1", name: "Capability One" }
  ],
  services: [
    {
      id: "svc1",
      capabilityId: "cap1",
      hostId: "host1",
      permissions: { enabled: true },
      runner: { type: "systemd" as const, unit: "svc1", unitFile: "ops/systemd/svc1.service" },
      network: { port: 3000, healthPath: "/health" },
      lifecycle: { loadStrategy: "startup" as const, idleUnload: false }
    }
  ]
};

let tmpDir: string;
let registryPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "registry-test-"));
  registryPath = join(tmpDir, "registry.json");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("Registry loader — error cases", () => {
  it("throws when the file does not exist", async () => {
    expect(loadRegistry(join(tmpDir, "nonexistent.json"))).rejects.toThrow();
  });

  it("throws when the file contains invalid JSON", async () => {
    await writeFile(registryPath, "{ this is not json }");
    expect(loadRegistry(registryPath)).rejects.toThrow();
  });
});

describe("Registry loader", () => {
  it("loads a valid registry.json and returns typed hosts, capabilities, and services", async () => {
    await writeFile(registryPath, JSON.stringify(validRegistry));
    const registry = await loadRegistry(registryPath);
    expect(registry.hosts).toHaveLength(1);
    expect(registry.capabilities).toHaveLength(1);
    expect(registry.services).toHaveLength(1);
    expect(registry.hosts[0].id).toBe("host1");
  });

  it("rejects a registry file with missing required fields", async () => {
    const bad = { version: 2, type: "control", hosts: [], capabilities: [], services: [{ id: "x" }] };
    await writeFile(registryPath, JSON.stringify(bad));
    expect(loadRegistry(registryPath)).rejects.toThrow();
  });

  it("rejects a service whose capabilityId references a nonexistent capability", async () => {
    const bad = { ...validRegistry, services: [{ ...validRegistry.services[0], capabilityId: "nonexistent" }] };
    await writeFile(registryPath, JSON.stringify(bad));
    expect(loadRegistry(registryPath)).rejects.toThrow(/capabilityId/);
  });

  it("rejects a service whose hostId references a nonexistent host", async () => {
    const bad = { ...validRegistry, services: [{ ...validRegistry.services[0], hostId: "nonexistent" }] };
    await writeFile(registryPath, JSON.stringify(bad));
    expect(loadRegistry(registryPath)).rejects.toThrow(/hostId/);
  });

  it("returns empty arrays when registry has no services", async () => {
    const empty = { version: 2, type: "control" as const, hosts: [], capabilities: [], services: [] };
    await writeFile(registryPath, JSON.stringify(empty));
    const registry = await loadRegistry(registryPath);
    expect(registry.services).toHaveLength(0);
  });

  it("each service resolves to its host object", async () => {
    await writeFile(registryPath, JSON.stringify(validRegistry));
    const registry = await loadRegistry(registryPath);
    const svc = registry.services[0];
    const host = registry.hosts.find(h => h.id === svc.hostId);
    expect(host).toBeDefined();
    expect(host!.id).toBe("host1");
  });
});

describe("Registry loader — new schema fields", () => {
  it("loads a service with protected:true and preserves the value", async () => {
    const reg = {
      ...validRegistry,
      services: [{ ...validRegistry.services[0], permissions: { enabled: true, protected: true } }]
    };
    await writeFile(registryPath, JSON.stringify(reg));
    const registry = await loadRegistry(registryPath);
    expect(registry.services[0].permissions.protected).toBe(true);
  });

  it("loads a service with port field and preserves the value", async () => {
    const reg = {
      ...validRegistry,
      services: [{ ...validRegistry.services[0], network: { port: 8080, healthPath: "/health" } }]
    };
    await writeFile(registryPath, JSON.stringify(reg));
    const registry = await loadRegistry(registryPath);
    expect(registry.services[0].network.port).toBe(8080);
  });

  it("loads a service with loadStrategy:demand and preserves the value", async () => {
    const reg = {
      ...validRegistry,
      services: [{ ...validRegistry.services[0], lifecycle: { loadStrategy: "demand" as const } }]
    };
    await writeFile(registryPath, JSON.stringify(reg));
    const registry = await loadRegistry(registryPath);
    expect(registry.services[0].lifecycle?.loadStrategy).toBe("demand");
  });

  it("loads a service with idleUnload:true and preserves the value", async () => {
    const reg = {
      ...validRegistry,
      services: [{ ...validRegistry.services[0], lifecycle: { loadStrategy: "startup" as const, idleUnload: true } }]
    };
    await writeFile(registryPath, JSON.stringify(reg));
    const registry = await loadRegistry(registryPath);
    expect(registry.services[0].lifecycle?.idleUnload).toBe(true);
  });

  it("service without protected field gets value from defaults", async () => {
    const shardRegistry = {
      version: 2 as const,
      type: "shard" as const,
      defaults: {
        permissions: { protected: false },
        lifecycle: { loadStrategy: "startup" as const, idleUnload: false }
      },
      hosts: validRegistry.hosts,
      capabilities: validRegistry.capabilities,
      services: [{ ...validRegistry.services[0] }]
    };
    await writeFile(registryPath, JSON.stringify(shardRegistry));
    const registry = await loadRegistry(registryPath);
    expect(registry.services[0].permissions.protected).toBe(false);
  });

  it("service without loadStrategy field gets value from defaults", async () => {
    const shardRegistry = {
      version: 2 as const,
      type: "shard" as const,
      defaults: {
        permissions: { protected: false },
        lifecycle: { loadStrategy: "startup" as const, idleUnload: false }
      },
      hosts: validRegistry.hosts,
      capabilities: validRegistry.capabilities,
      services: [{ ...validRegistry.services[0], lifecycle: undefined }]
    };
    await writeFile(registryPath, JSON.stringify(shardRegistry));
    const registry = await loadRegistry(registryPath);
    expect(registry.services[0].lifecycle?.loadStrategy).toBe("startup");
  });

  it("service without idleUnload field gets value from defaults", async () => {
    const shardRegistry = {
      version: 2 as const,
      type: "shard" as const,
      defaults: {
        permissions: { protected: false },
        lifecycle: { loadStrategy: "startup" as const, idleUnload: false }
      },
      hosts: validRegistry.hosts,
      capabilities: validRegistry.capabilities,
      services: [{ ...validRegistry.services[0], lifecycle: undefined }]
    };
    await writeFile(registryPath, JSON.stringify(shardRegistry));
    const registry = await loadRegistry(registryPath);
    expect(registry.services[0].lifecycle?.idleUnload).toBe(false);
  });
});

describe("Registry loader — version and type validation", () => {
  it("rejects a registry with no version field", async () => {
    const bad = { type: "control", hosts: [], capabilities: [], services: [] };
    await writeFile(registryPath, JSON.stringify(bad));
    expect(loadRegistry(registryPath)).rejects.toThrow(/version/);
  });

  it("rejects a registry with unsupported version", async () => {
    const bad = { version: 99, type: "control", hosts: [], capabilities: [], services: [] };
    await writeFile(registryPath, JSON.stringify(bad));
    expect(loadRegistry(registryPath)).rejects.toThrow(/unsupported version/);
  });

  it("rejects a registry with no type field", async () => {
    const bad = { version: 2, hosts: [], capabilities: [], services: [] };
    await writeFile(registryPath, JSON.stringify(bad));
    expect(loadRegistry(registryPath)).rejects.toThrow(/type/);
  });

  it("rejects a registry with invalid type", async () => {
    const bad = { version: 2, type: "banana", hosts: [], capabilities: [], services: [] };
    await writeFile(registryPath, JSON.stringify(bad));
    expect(loadRegistry(registryPath)).rejects.toThrow(/invalid type/);
  });
});

describe("Registry loader — defaults", () => {
  it("merges defaults into services missing optional fields", async () => {
    const reg = {
      ...validRegistry,
      version: 2,
      type: "shard" as const,
      defaults: {
        network: { tailscaleServe: true },
        lifecycle: { idleTimeout: 600000 }
      },
      services: [{ ...validRegistry.services[0] }]
    };
    await writeFile(registryPath, JSON.stringify(reg));
    const registry = await loadRegistry(registryPath);
    expect(registry.services[0].network.tailscaleServe).toBe(true);
    expect(registry.services[0].lifecycle?.idleTimeout).toBe(600000);
  });

  it("per-service values override defaults", async () => {
    const reg = {
      ...validRegistry,
      version: 2,
      type: "shard" as const,
      defaults: { network: { tailscaleServe: true } },
      services: [{ ...validRegistry.services[0], network: { port: 3000, healthPath: "/health", tailscaleServe: false } }]
    };
    await writeFile(registryPath, JSON.stringify(reg));
    const registry = await loadRegistry(registryPath);
    expect(registry.services[0].network.tailscaleServe).toBe(false);
  });

  it("works without a defaults section", async () => {
    await writeFile(registryPath, JSON.stringify(validRegistry));
    const registry = await loadRegistry(registryPath);
    expect(registry.services).toHaveLength(1);
    expect(registry.defaults).toBeUndefined();
  });

  it("rejects unknown keys in defaults", async () => {
    const bad = { ...validRegistry, defaults: { bogusGroup: { bogusField: true } } };
    await writeFile(registryPath, JSON.stringify(bad));
    expect(loadRegistry(registryPath)).rejects.toThrow(/unknown (field|group) in defaults/);
  });

  it("rejects shard-only defaults on a control registry", async () => {
    const bad = { ...validRegistry, defaults: { network: { tailscaleServe: true } } };
    await writeFile(registryPath, JSON.stringify(bad));
    expect(loadRegistry(registryPath)).rejects.toThrow(/shard-only field/);
  });
});

describe("Registry loader — runner validation", () => {
  it("rejects a service with no runner field", async () => {
    const bad = { ...validRegistry, services: [{ ...validRegistry.services[0], runner: undefined }] };
    await writeFile(registryPath, JSON.stringify(bad));
    expect(loadRegistry(registryPath)).rejects.toThrow(/runner is required/);
  });

  it("rejects an unknown runner type", async () => {
    const bad = { ...validRegistry, services: [{ ...validRegistry.services[0], runner: { type: "docker" } }] };
    await writeFile(registryPath, JSON.stringify(bad));
    expect(loadRegistry(registryPath)).rejects.toThrow(/runner.type must be one of/);
  });

  it("rejects a process runner without runner.main", async () => {
    const bad = { ...validRegistry, services: [{ ...validRegistry.services[0], runner: { type: "process" } }] };
    await writeFile(registryPath, JSON.stringify(bad));
    expect(loadRegistry(registryPath)).rejects.toThrow(/process runner requires runner.main/);
  });

  it("rejects a systemd runner without runner.unit", async () => {
    const bad = { ...validRegistry, services: [{ ...validRegistry.services[0], runner: { type: "systemd", unitFile: "ops/systemd/svc1.service" } }] };
    await writeFile(registryPath, JSON.stringify(bad));
    expect(loadRegistry(registryPath)).rejects.toThrow(/systemd runner requires/);
  });

  it("rejects a launchd runner without runner.label", async () => {
    const bad = { ...validRegistry, services: [{ ...validRegistry.services[0], runner: { type: "launchd", plist: "ops/svc1.plist" } }] };
    await writeFile(registryPath, JSON.stringify(bad));
    expect(loadRegistry(registryPath)).rejects.toThrow(/launchd runner requires/);
  });

  it("accepts an external runner with no other fields", async () => {
    const reg = { ...validRegistry, services: [{ ...validRegistry.services[0], runner: { type: "external" } }] };
    await writeFile(registryPath, JSON.stringify(reg));
    const registry = await loadRegistry(registryPath);
    expect(registry.services[0].runner?.type).toBe("external");
  });

  it("accepts a process runner with runner.main", async () => {
    const reg = { ...validRegistry, services: [{ ...validRegistry.services[0], runner: { type: "process", main: "./server --port 3000" } }] };
    await writeFile(registryPath, JSON.stringify(reg));
    const registry = await loadRegistry(registryPath);
    expect((registry.services[0].runner as any).main).toBe("./server --port 3000");
  });

  it("rejects a managed runner without runner.startCmd", async () => {
    const bad = { ...validRegistry, services: [{ ...validRegistry.services[0], runner: { type: "managed", stopCmd: ["paseo", "daemon", "stop"], healthCmd: "paseo daemon status" }, network: undefined }] };
    await writeFile(registryPath, JSON.stringify(bad));
    expect(loadRegistry(registryPath)).rejects.toThrow(/managed runner requires/);
  });

  it("rejects a managed runner without runner.stopCmd", async () => {
    const bad = { ...validRegistry, services: [{ ...validRegistry.services[0], runner: { type: "managed", startCmd: ["paseo", "daemon", "start"], healthCmd: "paseo daemon status" }, network: undefined }] };
    await writeFile(registryPath, JSON.stringify(bad));
    expect(loadRegistry(registryPath)).rejects.toThrow(/managed runner requires/);
  });

  it("rejects a managed runner without runner.healthCmd", async () => {
    const bad = { ...validRegistry, services: [{ ...validRegistry.services[0], runner: { type: "managed", startCmd: ["paseo", "daemon", "start"], stopCmd: ["paseo", "daemon", "stop"] }, network: undefined }] };
    await writeFile(registryPath, JSON.stringify(bad));
    expect(loadRegistry(registryPath)).rejects.toThrow(/managed runner requires/);
  });

  it("accepts a managed runner with no network.healthPath", async () => {
    const reg = {
      ...validRegistry,
      services: [{
        ...validRegistry.services[0],
        runner: {
          type: "managed",
          startCmd: ["paseo", "daemon", "start"],
          stopCmd: ["paseo", "daemon", "stop"],
          healthCmd: "paseo daemon status --json | jq -e '.localDaemon == \"running\"'",
        },
        network: { port: 6767 },
      }],
    };
    await writeFile(registryPath, JSON.stringify(reg));
    const registry = await loadRegistry(registryPath);
    expect(registry.services[0].runner?.type).toBe("managed");
  });

  it("does not derive network.endpoint for a managed runner, even when network.port is set", async () => {
    // A managed runner has no HTTP health surface — a derived endpoint would
    // wrongly imply one exists, even though network.port may be set for reference
    // (e.g. the daemon's own listen port, unrelated to platform health checks).
    const reg = {
      ...validRegistry,
      services: [{
        ...validRegistry.services[0],
        runner: {
          type: "managed",
          startCmd: ["paseo", "daemon", "start"],
          stopCmd: ["paseo", "daemon", "stop"],
          healthCmd: "paseo daemon status --json | jq -e '.localDaemon == \"running\"'",
        },
        network: { port: 6767 },
      }],
    };
    await writeFile(registryPath, JSON.stringify(reg));
    const registry = await loadRegistry(registryPath);
    expect(registry.services[0].network.endpoint).toBeUndefined();
  });

  it("accepts a managed runner with no network object at all", async () => {
    const reg = {
      ...validRegistry,
      services: [{
        ...validRegistry.services[0],
        runner: {
          type: "managed",
          startCmd: ["paseo", "daemon", "start"],
          stopCmd: ["paseo", "daemon", "stop"],
          healthCmd: "paseo daemon status --json | jq -e '.localDaemon == \"running\"'",
        },
        network: undefined,
      }],
    };
    await writeFile(registryPath, JSON.stringify(reg));
    const registry = await loadRegistry(registryPath);
    expect(registry.services[0].runner?.type).toBe("managed");
  });

  it("still requires network.healthPath for a systemd runner (unaffected by the managed exemption)", async () => {
    const bad = { ...validRegistry, services: [{ ...validRegistry.services[0], network: { port: 3000 } }] };
    await writeFile(registryPath, JSON.stringify(bad));
    expect(loadRegistry(registryPath)).rejects.toThrow(/network.healthPath is required/);
  });
});

describe("Registry writer — preserves version, type, and defaults", () => {
  it("updateService round-trip preserves version, type, and defaults", async () => {
    const reg = {
      ...validRegistry,
      version: 2,
      type: "shard" as const,
      defaults: { lifecycle: { idleTimeout: 300000 } }
    };
    await writeFile(registryPath, JSON.stringify(reg));
    const state = await loadRegistry(registryPath);
    await updateService(state, registryPath, "svc1", { network: { port: 4321 } });
    const reloaded = await loadRegistry(registryPath);
    expect(reloaded.version).toBe(2);
    expect(reloaded.type).toBe("shard");
    expect(reloaded.defaults).toEqual({ lifecycle: { idleTimeout: 300000 } });
  });
});

describe("Registry writer", () => {
  it("updating a service's port persists to disk and endpoint is re-derived on reload", async () => {
    await writeFile(registryPath, JSON.stringify(validRegistry));
    const state = await loadRegistry(registryPath);
    await updateService(state, registryPath, "svc1", { network: { port: 9999 } });
    const reloaded = await loadRegistry(registryPath);
    expect(reloaded.services[0].network.port).toBe(9999);
    expect(reloaded.services[0].network.endpoint).toBe("http://host1.ts.net:9999");
  });

  it("patching a service with a listenAddress derives the same endpoint the loader would", async () => {
    // The patched endpoint and the reloaded one must agree. They once did not:
    // updateService inferred https from listenAddress, so a port patch wrote an
    // endpoint that flipped back to http on the next load.
    const withListen = {
      ...validRegistry,
      services: [{ ...validRegistry.services[0], network: { port: 3000, healthPath: "/health", listenAddress: "127.0.0.1" } }]
    };
    await writeFile(registryPath, JSON.stringify(withListen));
    const state = await loadRegistry(registryPath);
    const patched = await updateService(state, registryPath, "svc1", { network: { port: 9999 } });
    const reloaded = await loadRegistry(registryPath);
    expect(patched.network.endpoint).toBe("http://127.0.0.1:9999");
    expect(reloaded.services[0].network.endpoint).toBe(patched.network.endpoint);
  });

  it("patching scheme re-derives the endpoint and agrees with a reload", async () => {
    await writeFile(registryPath, JSON.stringify(validRegistry));
    const state = await loadRegistry(registryPath);
    const patched = await updateService(state, registryPath, "svc1", { network: { scheme: "https" } });
    const reloaded = await loadRegistry(registryPath);
    expect(patched.network.endpoint).toBe("https://host1.ts.net:3000");
    expect(reloaded.services[0].network.endpoint).toBe(patched.network.endpoint);
  });

  it("patching a scheme that is neither http nor https is rejected", async () => {
    await writeFile(registryPath, JSON.stringify(validRegistry));
    const state = await loadRegistry(registryPath);
    expect(updateService(state, registryPath, "svc1", { network: { scheme: "ftp" } })).rejects.toThrow(/http/);
  });

  it("a managed runner gets no derived endpoint from a patch, matching the loader", async () => {
    const managed = {
      ...validRegistry,
      services: [{
        id: "svc1", capabilityId: "cap1", hostId: "host1",
        permissions: { enabled: true },
        runner: { type: "managed" as const, startCmd: "start", stopCmd: "stop", healthCmd: "health" },
        network: { port: 3000 }
      }]
    };
    await writeFile(registryPath, JSON.stringify(managed));
    const state = await loadRegistry(registryPath);
    const patched = await updateService(state, registryPath, "svc1", { network: { port: 9999 } });
    const reloaded = await loadRegistry(registryPath);
    expect(patched.network.endpoint).toBeUndefined();
    expect(reloaded.services[0].network.endpoint).toBeUndefined();
  });

  it("toggling a service's enabled field persists to disk", async () => {
    await writeFile(registryPath, JSON.stringify(validRegistry));
    const state = await loadRegistry(registryPath);
    await setEnabled(state, registryPath, "svc1", false);
    const reloaded = await loadRegistry(registryPath);
    expect(reloaded.services[0].permissions.enabled).toBe(false);
  });

  it("updating a nonexistent service ID returns an error", async () => {
    await writeFile(registryPath, JSON.stringify(validRegistry));
    const state = await loadRegistry(registryPath);
    expect(updateService(state, registryPath, "nonexistent", { network: { port: 1234 } })).rejects.toThrow();
  });

  it("write does not corrupt other services in the file", async () => {
    const multi = {
      ...validRegistry,
      services: [
        validRegistry.services[0],
        {
          id: "svc2", capabilityId: "cap1", hostId: "host1",
          permissions: { enabled: true },
          runner: { type: "external" as const },
          network: { port: 4000, healthPath: "/health" }
        }
      ]
    };
    await writeFile(registryPath, JSON.stringify(multi));
    const state = await loadRegistry(registryPath);
    await updateService(state, registryPath, "svc1", { network: { port: 1234 } });
    const reloaded = await loadRegistry(registryPath);
    expect(reloaded.services).toHaveLength(2);
    expect(reloaded.services[1].id).toBe("svc2");
  });

  it("write is atomic — temp file is renamed into place, no partial file left behind", async () => {
    await writeFile(registryPath, JSON.stringify(validRegistry));
    const state = await loadRegistry(registryPath);
    await updateService(state, registryPath, "svc1", { network: { port: 5678 } });
    // No .registry.tmp.* files should remain after the write
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(tmpDir);
    const tmpFiles = files.filter(f => f.startsWith(".registry.tmp."));
    expect(tmpFiles).toHaveLength(0);
    // And the final file must be valid JSON
    const result = await readFile(registryPath, "utf-8");
    expect(() => JSON.parse(result)).not.toThrow();
  });
});
