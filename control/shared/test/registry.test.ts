// Loading, validating and writing a node's registry.json.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry, updateService, setEnabled } from "../src/registry";

let tmpDir: string;
let registryPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "registry-test-"));
  registryPath = join(tmpDir, "registry.json");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

type Doc = Record<string, any>;

/** A valid control registry with one systemd service, edited by `edit` before it is written. */
async function write(edit: (doc: Doc) => void = () => {}): Promise<Doc> {
  const doc: Doc = {
    version: 4,
    type: "control",
    hosts: [{ id: "host1", name: "Host One", hostname: "host1.ts.net", role: "control" }],
    capabilities: [{ id: "tts", name: "Text-to-Speech" }],
    services: [{
      id: "svc1",
      capabilityId: "tts",
      hostId: "host1",
      permissions: { enabled: true },
      runner: { type: "systemd", unit: "svc1", unitFile: "ops/systemd/svc1.service" },
      network: { port: 3000, healthPath: "/health" },
      lifecycle: { loadStrategy: "startup" },
    }],
  };
  edit(doc);
  await writeFile(registryPath, JSON.stringify(doc));
  return doc;
}

const svc = (doc: Doc) => doc.services[0];
const MANAGED = { type: "managed", startCmd: ["paseo", "daemon", "start"], stopCmd: ["paseo", "daemon", "stop"], healthCmd: "paseo daemon status" };
const INSTALL = { env: { workingDirectory: "/srv/app" }, install: { artifacts: [{ from: "services/app/.build/app", to: ".build/app" }] } };
const ROSTER = { ttsModels: [{ id: "m", name: "M" }], sttModels: [], providers: { svc1: { resolvesVoices: false, serves: [{ model: "m", key: "k" }] } }, voices: [] };

describe("loading", () => {
  it("loads hosts, capabilities and services, with an empty roster when none is declared and no default host port", async () => {
    await write();
    const registry = await loadRegistry(registryPath);
    expect(registry.services.map(s => s.id)).toEqual(["svc1"]);
    expect(registry.roster).toMatchObject({ providers: {}, voices: [] });
    expect(registry.hosts[0].port).toBeUndefined();
  });

  const REJECTED: [string, (doc: Doc) => void, RegExp][] = [
    ["no type", d => { delete d.type; }, /type/],
    ["an invalid type", d => { d.type = "banana"; }, /type/],
    ["a service naming an unknown capability", d => { svc(d).capabilityId = "nope"; }, /capabilityId/],
    ["a service naming an unknown host", d => { svc(d).hostId = "nope"; }, /hostId/],
    ["a service with no enabled flag", d => { svc(d).permissions = {}; }, /enabled/],
    ["a host port that is not a positive integer", d => { d.hosts[0].port = -1; }, /port/],
    ["a roster provider naming a service not in this registry", d => { d.roster = { ...ROSTER, providers: { ghost: ROSTER.providers.svc1 } }; }, /roster:.*ghost/],
    ["a service with no runner", d => { delete svc(d).runner; }, /runner is required/],
    ["an unknown runner type", d => { svc(d).runner = { type: "docker" }; }, /runner\.type/],
    ["a process runner without main", d => { svc(d).runner = { type: "process" }; }, /process runner requires runner.main/],
    ["a PORT among a service's variables", d => { svc(d).ops = { env: { variables: { PORT: "3000" } } }; }, /svc1.*PORT.*network.port/],
    ["a systemd runner without unit", d => { delete svc(d).runner.unit; }, /systemd runner requires/],
    ["a launchd runner without label", d => { svc(d).runner = { type: "launchd", plist: "ops/svc1.plist" }; }, /launchd runner requires/],
    ["a managed runner without startCmd", d => { svc(d).runner = { ...MANAGED, startCmd: undefined }; }, /managed runner requires/],
    ["a managed runner without stopCmd", d => { svc(d).runner = { ...MANAGED, stopCmd: undefined }; }, /managed runner requires/],
    ["a managed runner without healthCmd", d => { svc(d).runner = { ...MANAGED, healthCmd: undefined }; }, /managed runner requires/],
    ["a systemd service without a health path", d => { delete svc(d).network.healthPath; }, /network.healthPath is required/],
    ["an unknown group in defaults", d => { d.defaults = { bogus: { x: true } }; }, /unknown (field|group) in defaults/],
    ["a shard-only default on a control registry", d => { d.defaults = { network: { tailscaleServe: true } }; }, /shard-only field/],
    ["a service scheme other than http or https", d => { svc(d).network.scheme = "ftp"; }, /network\.scheme.*got "ftp"/],
    ["a default scheme other than http or https", d => { d.defaults = { network: { scheme: "ftp" } }; }, /defaults\.network\.scheme.*got "ftp"/],
    ["a shard scheme other than http or https", d => { d.shards = [{ hostId: "host1", port: 5007, scheme: "ftp" }]; }, /shard.*scheme.*got "ftp"/],
    ["ops.install with no artifacts", d => { svc(d).ops = { ...INSTALL, install: { artifacts: [] } }; }, /svc1.*ops.install.artifacts/],
    ["an artifact without a to", d => { svc(d).ops = { ...INSTALL, install: { artifacts: [{ from: "a" }] } }; }, /services\[svc1\].*\bto\b/],
    ["an absolute artifact to", d => { svc(d).ops = { ...INSTALL, install: { artifacts: [{ from: "a", to: "/usr/local/bin/app" }] } }; }, /svc1.*relative/],
    ["an artifact to climbing out with ..", d => { svc(d).ops = { ...INSTALL, install: { artifacts: [{ from: "a", to: "../app" }] } }; }, /svc1.*relative/],
    ["an absolute artifact from", d => { svc(d).ops = { ...INSTALL, install: { artifacts: [{ from: "/tmp/app", to: "app" }] } }; }, /svc1.*relative/],
    ["ops.install with no working directory", d => { svc(d).ops = { install: INSTALL.install }; }, /svc1.*workingDirectory/],
    ["intervals that are not an object", d => { d.intervals = 5; }, /intervals/],
    ["an unknown interval", d => { d.intervals = { pollMs: 1000 }; }, /unknown field in intervals/],
    ["an interval that is not a positive integer", d => { d.intervals = { healthMs: 0 }; }, /intervals.healthMs must be a positive integer/],
    ["a shard poll interval on a shard", d => { d.type = "shard"; d.intervals = { shardPollMs: 1000 }; }, /shardPollMs is control-only/],
  ];
  it.each(REJECTED)("refuses %s", async (_, edit, error) => {
    await write(edit);
    await expect(loadRegistry(registryPath)).rejects.toThrow(error);
  });

  it("fills a service's missing fields from defaults, its own values winning", async () => {
    await write(d => {
      d.type = "shard";
      d.defaults = { network: { tailscaleServe: true }, lifecycle: { idleTimeout: 600000, idleUnload: false } };
      d.services.push({ ...svc(d), id: "svc2", network: { port: 3001, healthPath: "/health", tailscaleServe: false } });
    });
    const [first, second] = (await loadRegistry(registryPath)).services;
    expect([first.network.tailscaleServe, first.lifecycle?.idleTimeout, first.lifecycle?.idleUnload]).toEqual([true, 600000, false]);
    expect(second.network.tailscaleServe).toBe(false);
  });

  it("accepts an external runner, and a managed one with or without a port, the port giving it an endpoint", async () => {
    await write(d => {
      svc(d).runner = { type: "external" };
      d.services.push({ ...svc(d), id: "managed", runner: MANAGED, network: undefined });
      d.services.push({ ...svc(d), id: "managed-port", runner: MANAGED, network: { port: 6767 } });
    });
    const services = (await loadRegistry(registryPath)).services;
    expect(services.map(s => s.runner?.type)).toEqual(["external", "managed", "managed"]);
    expect(services.slice(1).map(s => s.network.endpoint)).toEqual([undefined, "http://host1.ts.net:6767"]);
  });

  const ENDPOINTS: [string, (doc: Doc) => void, string][] = [
    // Banter defaults to http, where platform defaults to https off loopback
    // (dev/design/platform-divergence.md, "Decided").
    ["http by default", () => {}, "http://host1.ts.net:3000"],
    ["the service's own scheme", d => { svc(d).network.scheme = "https"; }, "https://host1.ts.net:3000"],
    ["http for a listenAddress, which says nothing about protocol", d => { svc(d).network.listenAddress = "host1.ts.net"; }, "http://host1.ts.net:3000"],
    ["http on loopback", d => { svc(d).network.listenAddress = "localhost"; }, "http://localhost:3000"],
    ["an explicit scheme on loopback", d => { Object.assign(svc(d).network, { listenAddress: "localhost", scheme: "https" }); }, "https://localhost:3000"],
    ["the defaults' scheme when the service sets none", d => { d.defaults = { network: { scheme: "https" } }; }, "https://host1.ts.net:3000"],
  ];
  it.each(ENDPOINTS)("derives a service endpoint with %s", async (_, edit, endpoint) => {
    await write(edit);
    expect((await loadRegistry(registryPath)).services[0].network.endpoint).toBe(endpoint);
  });

  it("derives a shard endpoint as http unless the shard names its scheme", async () => {
    await write(d => { d.shards = [{ hostId: "host1", port: 5007 }, { hostId: "host1", port: 5008, scheme: "https" }]; });
    expect((await loadRegistry(registryPath)).shards!.map(s => s.endpoint)).toEqual(["http://host1.ts.net:5007", "https://host1.ts.net:5008"]);
  });

  it.each(["server --port {port}", "./run.sh"])("accepts a process runner whose main is %s", async (main) => {
    await write(d => { svc(d).runner = { type: "process", main }; });
    expect((await loadRegistry(registryPath)).services[0].runner).toEqual({ type: "process", main });
  });
});

describe("writing", () => {
  it("persists an edit, re-deriving the endpoint, and keeps everything else in the file as it was", async () => {
    const doc = await write(d => {
      d.type = "shard";
      d.defaults = { lifecycle: { idleTimeout: 300000 } };
      d.roster = ROSTER;
      d.intervals = { healthMs: 60000 };
      svc(d).ops = INSTALL;
      d.services.push({ ...svc(d), id: "svc2", runner: { type: "external" }, ops: undefined, network: { port: 4000, healthPath: "/health" } });
    });
    const state = await loadRegistry(registryPath);
    await updateService(state, registryPath, "svc1", { network: { port: 9999 } });

    expect(state.services[0].network.endpoint).toBe("http://host1.ts.net:9999");
    const onDisk = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(onDisk.services[0].network).toEqual({ ...doc.services[0].network, port: 9999 });
    expect(onDisk.services[0].lifecycle).toEqual(doc.services[0].lifecycle);
    expect(onDisk.services[1]).toEqual(doc.services[1]);
    for (const key of ["version", "type", "defaults", "roster", "intervals"]) expect(onDisk[key]).toEqual(doc[key]);
    expect(onDisk.services[0].ops).toEqual(INSTALL);
    expect(await readdir(tmpDir)).toEqual(["registry.json"]);
  });

  it("writes no roster section back to a registry that had none", async () => {
    await write();
    await updateService(await loadRegistry(registryPath), registryPath, "svc1", { notes: "edited" });
    expect(JSON.parse(await readFile(registryPath, "utf-8")).roster).toBeUndefined();
  });

  it("re-derives the endpoint when the scheme changes, and keeps a set scheme when only the port does", async () => {
    await write();
    const state = await loadRegistry(registryPath);
    await updateService(state, registryPath, "svc1", { network: { scheme: "https" } });
    await updateService(state, registryPath, "svc1", { network: { port: 9999 } });
    expect(state.services[0].network.endpoint).toBe("https://host1.ts.net:9999");
    expect((await loadRegistry(registryPath)).services[0].network.endpoint).toBe("https://host1.ts.net:9999");
  });

  it("persists enabling and disabling", async () => {
    await write();
    await setEnabled(await loadRegistry(registryPath), registryPath, "svc1", false);
    expect((await loadRegistry(registryPath)).services[0].permissions.enabled).toBe(false);
  });

  it("clears an optional field given null, leaving no key, and re-derives the endpoint when listenAddress goes", async () => {
    await write(d => {
      Object.assign(svc(d), { notes: "temporary" });
      svc(d).network.listenAddress = "127.0.0.1";
      svc(d).lifecycle = { idleTimeout: 1800000, startupTime: 60000 };
    });
    const state = await loadRegistry(registryPath);
    const updated = await updateService(state, registryPath, "svc1", {
      notes: null,
      network: { listenAddress: null },
      lifecycle: { idleTimeout: null, startupTime: null },
    } as any);

    expect(updated.network.endpoint).toBe("http://host1.ts.net:3000");
    const onDisk = JSON.parse(await readFile(registryPath, "utf-8")).services[0];
    expect(["notes" in onDisk, "listenAddress" in onDisk.network, "idleTimeout" in onDisk.lifecycle, "startupTime" in onDisk.lifecycle]).toEqual([false, false, false, false]);
  });

  const REFUSED: [string, string, Record<string, unknown>, RegExp][] = [
    ["an unknown service", "nope", { network: { port: 1234 } }, /nope/],
    ["a scheme other than http or https", "svc1", { network: { scheme: "ftp" } }, /network\.scheme.*got "ftp"/],
    ["a note that is not a string", "svc1", { notes: 42 }, /notes must be a string/],
    ["clearing the port", "svc1", { network: { port: null } }, /network.port cannot be cleared/],
    ["clearing the health path", "svc1", { network: { healthPath: null } }, /network.healthPath cannot be cleared/],
    ["clearing the host", "svc1", { hostId: null }, /hostId cannot be cleared/],
  ];
  it.each(REFUSED)("refuses %s, leaving the file as it was", async (_, id, patch, error) => {
    await write();
    const before = await readFile(registryPath, "utf-8");
    await expect(updateService(await loadRegistry(registryPath), registryPath, id, patch as any)).rejects.toThrow(error);
    expect(await readFile(registryPath, "utf-8")).toBe(before);
  });
});
