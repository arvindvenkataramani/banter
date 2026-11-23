// Deploying the repo's shipped configuration into a node's live directory by three-way merge.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployConfig } from "../src/live-config/deploy";

let root: string;
let liveDir: string;
let sourceDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "live-config-deploy-test-"));
  liveDir = join(root, "live");
  sourceDir = join(root, "source");
  await mkdir(join(liveDir, "shipped"), { recursive: true });
  await mkdir(sourceDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

type Doc = Record<string, any>;

function registry(edit: (doc: Doc) => void = () => {}): Doc {
  const doc: Doc = {
    version: 4,
    type: "control",
    hosts: [{ id: "host1", name: "Host One", hostname: "host1.ts.net", role: "control" }],
    capabilities: [{ id: "cap1", name: "Capability One" }],
    services: [{
      id: "svc1",
      capabilityId: "cap1",
      hostId: "host1",
      permissions: { enabled: true },
      runner: { type: "systemd", unit: "svc1", unitFile: "ops/systemd/svc1.service" },
      network: { port: 3000, healthPath: "/health" },
      lifecycle: { loadStrategy: "startup" },
    }],
  };
  edit(doc);
  return doc;
}

function config(edit: (doc: Doc) => void = () => {}): Doc {
  const doc: Doc = { version: 4, timezone: "UTC", voice: { tts: { selection: { voice: "nicole" } } } };
  edit(doc);
  return doc;
}

const put = (path: string, doc: Doc) => writeFile(path, JSON.stringify(doc, null, 2));
const read = async (path: string): Promise<Doc> => JSON.parse(await readFile(path, "utf8"));
const text = (path: string) => readFile(path, "utf8");
const svc = (doc: Doc) => doc.services[0];

// The repo ships example files; the live directory holds the real ones.
const source = (file: string) => join(sourceDir, file.replace(/\.json$/, ".example.json"));
const legacy = (file: string) => join(root, "legacy", file);
const live = (file: string) => join(liveDir, file);
const shipped = (file: string) => join(liveDir, "shipped", file);

describe("deployConfig", () => {
  it("first deploy with no live file writes the example copy as live and as shipped", async () => {
    await put(source("registry.json"), registry());

    const result = await deployConfig({ node: "shard", liveDir, sourceDir });

    expect(result.conflicts).toEqual([]);
    expect(await read(live("registry.json"))).toEqual(registry());
    expect(await read(shipped("registry.json"))).toEqual(registry());
  });

  it("takes a field changed only in the repo and keeps a field changed only on the node, in one deploy", async () => {
    await put(shipped("registry.json"), registry());
    await put(source("registry.json"), registry(d => { svc(d).network.port = 3001; }));
    await put(live("registry.json"), registry(d => { svc(d).permissions.enabled = false; }));

    const result = await deployConfig({ node: "shard", liveDir, sourceDir });

    expect(result.conflicts).toEqual([]);
    const merged = await read(live("registry.json"));
    expect(svc(merged).network.port).toBe(3001);
    expect(svc(merged).permissions.enabled).toBe(false);
    expect(await read(shipped("registry.json"))).toEqual(registry(d => { svc(d).network.port = 3001; }));
  });

  it("with no shipped copy but a live file, keeps every live value and takes only fields the source adds", async () => {
    await put(source("registry.json"), registry(d => {
      svc(d).network.port = 3001;
      svc(d).lifecycle.idleTimeoutMs = 60000;
    }));
    await put(live("registry.json"), registry(d => { svc(d).network.port = 4000; }));

    const result = await deployConfig({ node: "shard", liveDir, sourceDir });

    expect(result.conflicts).toEqual([]);
    const merged = await read(live("registry.json"));
    expect(svc(merged).network.port).toBe(4000);
    expect(svc(merged).lifecycle.idleTimeoutMs).toBe(60000);
  });

  it("reports a field changed differently on both sides as a conflict prefixed with the file name, and writes nothing", async () => {
    await put(shipped("registry.json"), registry());
    await put(source("registry.json"), registry(d => { svc(d).network.port = 3001; }));
    await put(live("registry.json"), registry(d => { svc(d).network.port = 3002; }));
    const liveBefore = await text(live("registry.json"));
    const shippedBefore = await text(shipped("registry.json"));

    const result = await deployConfig({ node: "shard", liveDir, sourceDir });

    expect(result.written).toEqual([]);
    expect(result.conflicts.length).toBeGreaterThan(0);
    for (const c of result.conflicts) expect(c.startsWith("registry.json:")).toBe(true);
    expect(await text(live("registry.json"))).toBe(liveBefore);
    expect(await text(shipped("registry.json"))).toBe(shippedBefore);
  });

  it("writes nothing when the merged registry fails semantic validation", async () => {
    await put(shipped("registry.json"), registry());
    await put(live("registry.json"), registry());
    await put(source("registry.json"), registry(d => {
      d.services.push({ ...svc(d), id: "svc2", hostId: "no-such-host", network: { port: 3001, healthPath: "/health" } });
    }));
    const liveBefore = await text(live("registry.json"));
    const shippedBefore = await text(shipped("registry.json"));

    const result = await deployConfig({ node: "shard", liveDir, sourceDir });

    expect(result.written).toEqual([]);
    expect(result.conflicts.join("\n")).toMatch(/hostId/);
    expect(await text(live("registry.json"))).toBe(liveBefore);
    expect(await text(shipped("registry.json"))).toBe(shippedBefore);
  });

  it("deploying the plane moves integrations.openclaw.defaultAgent from the live config into state/state.json as lastAgent", async () => {
    await put(source("registry.json"), registry());
    await put(source("config.json"), config());
    await put(live("registry.json"), registry());
    await put(live("config.json"), config(d => { d.integrations = { openclaw: { defaultAgent: "alex" } }; }));

    const result = await deployConfig({ node: "plane", liveDir, sourceDir });

    expect(result.conflicts).toEqual([]);
    expect((await read(join(liveDir, "state", "state.json"))).lastAgent).toBe("alex");
    const merged = await read(live("config.json"));
    expect(merged.integrations?.openclaw?.defaultAgent).toBeUndefined();
  });

  // A deploy from dev shipped `experimental`; a later deploy from main, whose code lacks it, must not strip it.
  it("keeps a live field the schema does not know, even when the repo stopped shipping it", async () => {
    await put(shipped("config.json"), config(d => { d.experimental = { level: 1 }; }));
    await put(live("config.json"), config(d => { d.experimental = { level: 2 }; }));
    await put(source("config.json"), config());
    await put(source("registry.json"), registry());
    await put(live("registry.json"), registry());

    const result = await deployConfig({ node: "plane", liveDir, sourceDir });

    expect(result.conflicts).toEqual([]);
    expect((await read(live("config.json"))).experimental).toEqual({ level: 2 });
  });

  it("still removes a service the repo stopped shipping", async () => {
    const two = (d: Doc) => { d.services.push({ ...svc(d), id: "svc2", network: { port: 3001, healthPath: "/health" } }); };
    await put(shipped("registry.json"), registry(two));
    await put(live("registry.json"), registry(two));
    await put(source("registry.json"), registry());

    const result = await deployConfig({ node: "shard", liveDir, sourceDir });

    expect(result.conflicts).toEqual([]);
    expect((await read(live("registry.json"))).services.map((s: Doc) => s.id)).toEqual(["svc1"]);
  });

  it("deploys the control plane's two files", async () => {
    await put(source("registry.json"), registry());
    await put(source("config.json"), config());

    const result = await deployConfig({ node: "plane", liveDir, sourceDir, });

    expect(result.conflicts).toEqual([]);
    expect(result.written.length).toBeGreaterThan(0);
    expect(await read(live("config.json"))).toEqual(config());
  });
});

// An older layout kept the live files elsewhere; a first deploy reads them from there.
describe("first deploy seeding from an older layout", () => {
  it("uses the legacy file as the live file, keeping its values and adding only what the example adds", async () => {
    await mkdir(join(root, "legacy"), { recursive: true });
    await put(source("registry.json"), registry(d => { svc(d).lifecycle.idleTimeoutMs = 60000; }));
    await put(source("config.json"), config(d => { d.voice = { tts: { selection: { voice: "example-voice" } } }; }));
    await put(legacy("registry.json"), registry(d => { svc(d).network.port = 4000; }));
    await put(legacy("config.json"), config(d => {
      d.voice = { tts: { selection: { voice: "mine" } } };
      d.integrations = { openclaw: { defaultAgent: "alex", lastSessionByAgent: { alex: "s1" } } };
    }));

    const result = await deployConfig({
      node: "plane", liveDir, sourceDir,
      legacy: { "config.json": legacy("config.json"), "registry.json": legacy("registry.json") },
    });

    expect(result.conflicts).toEqual([]);
    const merged = await read(live("registry.json"));
    expect(svc(merged).network.port).toBe(4000);
    expect(svc(merged).lifecycle.idleTimeoutMs).toBe(60000);
    expect((await read(live("config.json"))).voice.tts.selection.voice).toBe("mine");
    const state = await read(join(liveDir, "state", "state.json"));
    expect(state.lastAgent).toBe("alex");
    expect(state.lastSessionByAgent).toEqual({ alex: "s1" });
    // The merge base is the example, so the next deploy sees only later changes.
    expect(svc(await read(shipped("registry.json"))).network.port).toBe(3000);
  });

  it("ignores the legacy file once the live file exists", async () => {
    await mkdir(join(root, "legacy"), { recursive: true });
    await put(source("registry.json"), registry());
    await put(live("registry.json"), registry(d => { svc(d).network.port = 3500; }));
    await put(legacy("registry.json"), registry(d => { svc(d).network.port = 4000; }));

    await deployConfig({ node: "shard", liveDir, sourceDir, legacy: { "registry.json": legacy("registry.json") } });

    expect(svc(await read(live("registry.json"))).network.port).toBe(3500);
  });

  it("stops with a clear message when the example file is missing", async () => {
    await expect(deployConfig({ node: "shard", liveDir, sourceDir })).rejects.toThrow(/registry\.example\.json not found/);
  });
});
