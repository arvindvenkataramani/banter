// What the shard starts when it comes up and stops when it goes down.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvents } from "../../shared/src/events";
import { clearLocks } from "../../shared/src/lifecycle";
import { clearExecutor } from "../../shared/src/executor";
import { shardStartup, shardShutdown } from "../src/lifecycle";
import type { Registry, Service } from "../../../shared/types";
import type { RunFn } from "../../shared/src/tailscale";

let tmpDir: string;
let eventsPath: string;
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  clearLocks();
  clearExecutor();
  tmpDir = await mkdtemp(join(tmpdir(), "shard-lifecycle-test-"));
  eventsPath = join(tmpDir, "events.jsonl");
  // Nothing is already running, so every start takes the full path.
  globalThis.fetch = (async () => { throw new Error("connection refused"); }) as unknown as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await rm(tmpDir, { recursive: true, force: true });
});

function service(id: string, lifecycle: Record<string, unknown>, port: number): Service {
  return {
    id,
    capabilityId: "tts",
    hostId: "gpu-machine",
    permissions: { enabled: true },
    runner: { type: "systemd", unit: id },
    network: { port, healthPath: "/health", endpoint: `https://gpu-machine.ts.net:${port}` },
    lifecycle,
  } as unknown as Service;
}

function registry(): Registry {
  return {
    version: 2,
    type: "shard",
    hosts: [{ id: "gpu-machine", name: "gpu-machine", hostname: "gpu-machine.ts.net", role: "worker" }],
    capabilities: [{ id: "tts", name: "TTS" }],
    services: [
      service("broken", { autoStart: true, shutdown: true }, 59000),
      service("auto", { autoStart: true, shutdown: true }, 59001),
      service("manual", { autoStart: false, shutdown: false }, 59002),
    ],
  };
}

/** Records the systemctl commands issued; `failing` names units whose start or stop fails, `throwing` ones that throw. */
function node(opts: { failing?: string; throwing?: string } = {}) {
  const issued: string[] = [];
  const runFn: RunFn = async (cmd) => {
    if (cmd[0] !== "systemctl") return { stdout: "", exitCode: 0, stderr: "" };
    issued.push(`${cmd[2]} ${cmd[3]}`);
    if (opts.throwing && cmd[3] === `${opts.throwing}.service`) throw new Error("stop failed");
    const failed = opts.failing && cmd[3] === `${opts.failing}.service` && cmd[2] === "start";
    return { stdout: "", exitCode: failed ? 1 : 0, stderr: failed ? "fail" : "" };
  };
  return { runFn, issued };
}

describe("shardStartup", () => {
  it("starts each autoStart service, past one that fails, and marks only those that came up as loaded", async () => {
    const reg = registry();
    const { runFn, issued } = node({ failing: "broken" });
    await shardStartup({ registryState: reg, eventsPath, runFn, pollHealthFn: async () => true });

    expect(issued.filter(c => c.startsWith("start"))).toEqual(["start broken.service", "start auto.service"]);
    expect(reg.services.map(s => [s.id, (s.state?.loadTime ?? 0) > 0])).toEqual([["broken", false], ["auto", true], ["manual", false]]);
  });
});

describe("shardShutdown", () => {
  async function shutDown(runFn: RunFn) {
    const order: string[] = [];
    const exit = process.exit;
    process.exit = (() => {}) as never;
    try {
      await shardShutdown({
        registryState: registry(),
        eventsPath,
        runFn: async (cmd) => { if (cmd[0] === "systemctl") order.push(`stop ${cmd[3]}`); return runFn(cmd); },
        stopServer: () => { order.push("server"); },
        stopHealth: () => { order.push("health"); },
        stopIdle: () => { order.push("idle"); },
      });
    } finally {
      process.exit = exit;
    }
    return order;
  }

  it("closes the server and loops first, then stops only the services marked shutdown", async () => {
    const order = await shutDown(node().runFn);
    expect(order).toEqual(["server", "health", "idle", "stop broken.service", "stop auto.service"]);
    const stopped = (await readEvents(eventsPath)).reverse().filter(e => e.type === "service.stopped");
    expect(stopped.map(e => e.subjectId)).toEqual(["broken", "auto"]);
  });

  it("keeps stopping services after one stop throws", async () => {
    const order = await shutDown(node({ throwing: "broken" }).runFn);
    expect(order).toContain("stop auto.service");
  });
});
