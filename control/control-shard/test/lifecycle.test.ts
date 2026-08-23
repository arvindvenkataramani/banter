import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvents } from "../../shared/src/events";
import { clearLocks } from "../../shared/src/lifecycle";
import type { Registry } from "../../../shared/types";

type RunFn = (cmd: string[]) => Promise<{ stdout: string; exitCode: number; stderr: string }>;
type PollHealthFn = (endpoint: string, timeout: number) => Promise<boolean>;

let tmpDir: string;
let eventsPath: string;

const originalFetch = globalThis.fetch;

beforeEach(async () => {
  clearLocks();
  tmpDir = await mkdtemp(join(tmpdir(), "shard-lifecycle-test-"));
  eventsPath = join(tmpDir, "events.jsonl");
  // startService's fast path probes http://localhost:<port> directly. Left
  // unstubbed it hits the real network, so an unrelated process listening on the
  // fixture's port makes the service look already-running and the start is
  // skipped. Always report "nothing there" so startup actually runs.
  globalThis.fetch = (async () => { throw new Error("connection refused"); }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await rm(tmpDir, { recursive: true, force: true });
});

const SEED: Registry = {
  version: 2,
  type: "shard",
  hosts: [{ id: "gpu-machine", name: "gpu-machine", hostname: "gpu-machine.example.ts.net", role: "worker" }],
  capabilities: [{ id: "tts", name: "TTS" }],
  services: [
    {
      id: "svc-autostart",
      capabilityId: "tts",
      hostId: "gpu-machine",
      permissions: { enabled: true },
      runner: { type: "process", main: "start-svc-autostart" },
      network: { port: 59000, healthPath: "/health", endpoint: "https://gpu-machine.example.ts.net:59000" },
      lifecycle: { autoStart: true, shutdown: true },
    },
    {
      id: "svc-manual",
      capabilityId: "tts",
      hostId: "gpu-machine",
      permissions: { enabled: true },
      runner: { type: "process", main: "start-svc-manual" },
      network: { port: 59001, healthPath: "/health", endpoint: "https://gpu-machine.example.ts.net:59001" },
      lifecycle: { autoStart: false, shutdown: false },
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Shard-level: shardStartup
// ─────────────────────────────────────────────────────────────────────────────

describe("shardStartup", () => {
  it("auto-start services are loaded on startup", async () => {
    const startedCmds: string[][] = [];
    const runFn: RunFn = async (cmd) => {
      startedCmds.push(cmd);
      return { stdout: "", exitCode: 0, stderr: "" };
    };
    const pollHealthFn: PollHealthFn = async () => true;

    const { shardStartup } = await import("../src/lifecycle");
    await shardStartup({ registryState: SEED, eventsPath, runFn, pollHealthFn });

    // svc-autostart has autoStart:true, its main command should have been called
    expect(startedCmds.some(c => c[0] === "start-svc-autostart")).toBe(true);
  });

  it("services with autoStart:false are not started during startup", async () => {
    const startedCmds: string[][] = [];
    const runFn: RunFn = async (cmd) => {
      startedCmds.push(cmd);
      return { stdout: "", exitCode: 0, stderr: "" };
    };
    const pollHealthFn: PollHealthFn = async () => true;

    const { shardStartup } = await import("../src/lifecycle");
    await shardStartup({ registryState: SEED, eventsPath, runFn, pollHealthFn });

    expect(startedCmds.some(c => c[0] === "start-svc-manual")).toBe(false);
  });

  it("startup continues loading remaining services if one auto-start service fails", async () => {
    const runFn: RunFn = async (cmd) => {
      // svc-autostart start fails
      if (cmd[0] === "start-svc-autostart") return { stdout: "", exitCode: 1, stderr: "fail" };
      return { stdout: "", exitCode: 0, stderr: "" };
    };
    const pollHealthFn: PollHealthFn = async () => true;

    const { shardStartup } = await import("../src/lifecycle");
    // Should not throw — errors are caught and logged
    await shardStartup({ registryState: SEED, eventsPath, runFn, pollHealthFn });
  });

  it("sets loadTime on successfully auto-started services", async () => {
    const runFn: RunFn = async () => ({ stdout: "", exitCode: 0, stderr: "" });
    const pollHealthFn: PollHealthFn = async () => true;

    const registry = JSON.parse(JSON.stringify(SEED)) as Registry;

    const { shardStartup } = await import("../src/lifecycle");
    await shardStartup({ registryState: registry, eventsPath, runFn, pollHealthFn });

    const autostart = registry.services.find(s => s.id === "svc-autostart");
    expect(autostart?.state?.loadTime).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Shard-level: shardShutdown
// ─────────────────────────────────────────────────────────────────────────────

describe("shardShutdown", () => {
  it("services with shutdown:true are stopped on shutdown", async () => {
    const stoppedCmds: string[][] = [];
    const runFn: RunFn = async (cmd) => {
      stoppedCmds.push(cmd);
      return { stdout: "", exitCode: 0, stderr: "" };
    };

    const { shardShutdown } = await import("../src/lifecycle");

    const origExit = process.exit;
    process.exit = (() => {}) as never;
    try {
      await shardShutdown({
        registryState: SEED,
        eventsPath,
        runFn,
        stopHealth: () => {},
        stopIdle: () => {},
        stopServer: () => {},
      });
    } finally {
      process.exit = origExit;
    }

    // svc-autostart has shutdown:true — its stop sequence should have run (tailscale off + stop)
    const events = await readEvents(eventsPath, { subjectId: "svc-autostart" });
    expect(events.some(e => e.type === "service.stopped")).toBe(true);
  });

  it("services with shutdown:false are not stopped on shutdown", async () => {
    const runFn: RunFn = async () => ({ stdout: "", exitCode: 0, stderr: "" });

    const { shardShutdown } = await import("../src/lifecycle");

    const origExit = process.exit;
    process.exit = (() => {}) as never;
    try {
      await shardShutdown({
        registryState: SEED,
        eventsPath,
        runFn,
        stopHealth: () => {},
        stopIdle: () => {},
        stopServer: () => {},
      });
    } finally {
      process.exit = origExit;
    }

    const events = await readEvents(eventsPath, { subjectId: "svc-manual" });
    expect(events.some(e => e.type === "service.stopped")).toBe(false);
  });

  it("calls stopHealth, stopIdle, and stopServer on shutdown", async () => {
    const order: string[] = [];
    const runFn: RunFn = async () => ({ stdout: "", exitCode: 0, stderr: "" });

    const { shardShutdown } = await import("../src/lifecycle");

    const origExit = process.exit;
    process.exit = (() => {}) as never;
    try {
      await shardShutdown({
        registryState: SEED,
        eventsPath,
        runFn,
        stopHealth: () => { order.push("stopHealth"); },
        stopIdle: () => { order.push("stopIdle"); },
        stopServer: () => { order.push("stopServer"); },
      });
    } finally {
      process.exit = origExit;
    }

    expect(order).toContain("stopHealth");
    expect(order).toContain("stopIdle");
    expect(order).toContain("stopServer");
  });

  it("continues shutting down even if a service stop throws", async () => {
    let serverStopped = false;
    const runFn: RunFn = async (cmd) => {
      // Cause the stop to throw for svc-autostart (reject after the tailscale check)
      if (cmd[0] === "start-svc-autostart" || cmd[0] === "stop") throw new Error("stop failed");
      return { stdout: "", exitCode: 0, stderr: "" };
    };

    const { shardShutdown } = await import("../src/lifecycle");

    const origExit = process.exit;
    process.exit = (() => {}) as never;
    try {
      await shardShutdown({
        registryState: SEED,
        eventsPath,
        runFn,
        stopHealth: () => {},
        stopIdle: () => {},
        stopServer: () => { serverStopped = true; },
      });
    } finally {
      process.exit = origExit;
    }

    expect(serverStopped).toBe(true);
  });
});
