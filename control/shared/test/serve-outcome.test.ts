import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvents } from "../src/events";
import { clearLocks, clearRestartCounts, startService as realStartService } from "../src/lifecycle";
import type { Service } from "../../../shared/types";
import type {
  RunFn as SharedRunFn,
  PollHealthFn as SharedPollHealthFn,
  SpawnFn,
  ProbeFn,
} from "../src/tailscale";

// A start has two outcomes a caller must tell apart: the process came up, and
// the service is reachable over Tailscale. When only the second fails, the
// process stays running and the service is degraded — the state the platform
// already models for "localhost answers, Tailscale does not". Tearing the
// process down would discard working work over a config-write race.

const notRunningProbeFn: ProbeFn = async () => {
  throw new Error("ECONNREFUSED (test stub: nothing listening)");
};

function startService(
  runFn: SharedRunFn,
  pollHealthFn: SharedPollHealthFn,
  svc: Service,
  eventsPath: string,
  spawnFn?: SpawnFn
): ReturnType<typeof realStartService> {
  return realStartService(runFn, pollHealthFn, svc, eventsPath, spawnFn, notRunningProbeFn);
}

type RunFn = SharedRunFn;
type PollHealthFn = SharedPollHealthFn;

let tmpDir: string;
let eventsPath: string;

beforeEach(async () => {
  clearLocks();
  clearRestartCounts();
  tmpDir = await mkdtemp(join(tmpdir(), "serve-outcome-test-"));
  eventsPath = join(tmpDir, "events.jsonl");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeService(overrides: Partial<Service> = {}): Service {
  const { permissions, network, runner, ops, lifecycle, ...rest } = overrides as any;
  return {
    id: "test-svc",
    capabilityId: "cap",
    hostId: "host",
    permissions: { enabled: true, ...permissions },
    network: {
      port: 8080,
      healthPath: "/health",
      endpoint: "http://localhost:8080",
      healthTimeout: 5000,
      tailscaleServe: true,
      ...network,
    },
    runner: { type: "process", main: "./server --port 8080", ...runner },
    ops: { env: { workingDirectory: "/tmp/test-svc" }, ...ops },
    lifecycle: { startupTime: 30000, ...lifecycle },
    ...rest,
  } as Service;
}

function isStatus(cmd: string[]): boolean {
  return cmd.includes("status") && cmd.includes("--json");
}

function isServeWrite(cmd: string[]): boolean {
  return cmd[0] === "tailscale" && !isStatus(cmd) && !cmd.includes("off");
}

/** Every serve registration attempt fails; the port never appears as served.
 *  `onStop` fires only for a stop issued *after* a failed serve write — the
 *  start sequence runs an idempotent stop before spawning, and that one is
 *  not a teardown. */
function serveAlwaysFailsRunFn(onStop?: () => void): RunFn {
  let serveFailed = false;
  return async (cmd) => {
    if (isStatus(cmd)) {
      return { stdout: JSON.stringify({ Web: {} }), exitCode: 0, stderr: "" };
    }
    if (isServeWrite(cmd)) {
      serveFailed = true;
      return { stdout: "", exitCode: 1, stderr: "etag mismatch\n" };
    }
    if (serveFailed && cmd.includes("stop")) onStop?.();
    return { stdout: "", exitCode: 0, stderr: "" };
  };
}

// ═════════════════════════════════════════════════════════════════════════════

describe("startService — serve registration failure with a healthy process", () => {
  it("leaves the process running when only serve registration fails", async () => {
    let killed = false;
    const spawnFn: SpawnFn = () => ({
      kill: () => { killed = true; },
      exited: new Promise<number>(() => {}),
    });
    const pollHealthFn: PollHealthFn = async () => true;

    const svc = makeService();
    await startService(serveAlwaysFailsRunFn(), pollHealthFn, svc, eventsPath, spawnFn);

    expect(killed).toBe(false);
  });

  it("does not issue a stop command when only serve registration fails (systemd runner)", async () => {
    let stopCalled = false;
    const pollHealthFn: PollHealthFn = async () => true;

    const svc = makeService({
      runner: { type: "systemd", unit: "test-svc", unitFile: "ops/test-svc.service" },
    });
    await startService(
      serveAlwaysFailsRunFn(() => { stopCalled = true; }),
      pollHealthFn,
      svc,
      eventsPath
    );

    expect(stopCalled).toBe(false);
  });

  it("emits service.degraded when the process is healthy but serve registration failed", async () => {
    const pollHealthFn: PollHealthFn = async () => true;

    const svc = makeService();
    await startService(serveAlwaysFailsRunFn(), pollHealthFn, svc, eventsPath);

    const events = await readEvents(eventsPath);
    expect(events.some(e => e.type === "service.degraded" && e.subjectId === "test-svc")).toBe(true);
  });

  it("does not emit service.up when serve registration failed", async () => {
    const pollHealthFn: PollHealthFn = async () => true;

    const svc = makeService();
    await startService(serveAlwaysFailsRunFn(), pollHealthFn, svc, eventsPath);

    const events = await readEvents(eventsPath);
    expect(events.some(e => e.type === "service.up")).toBe(false);
  });

  it("still emits tailscale.serve_failed when registration fails", async () => {
    const pollHealthFn: PollHealthFn = async () => true;

    const svc = makeService();
    await startService(serveAlwaysFailsRunFn(), pollHealthFn, svc, eventsPath);

    const events = await readEvents(eventsPath);
    expect(events.some(e => e.type === "tailscale.serve_failed")).toBe(true);
  });

  it("names the stage that failed, rather than reporting a bare start failure", async () => {
    const pollHealthFn: PollHealthFn = async () => true;

    const svc = makeService();
    const result = await startService(serveAlwaysFailsRunFn(), pollHealthFn, svc, eventsPath);

    expect(result.stage).toBe("serve");
  });

  it("reports ok for a running process whose serve registration failed", async () => {
    // ok drives the shard's demand-load handler (shard-api.ts:181): a false
    // result writes service.down over the degraded event and skips setting
    // loadTime, so idle eviction would never track the running process. The
    // process is up and usable over loopback, which is what ok reports; the
    // stage carries what went wrong.
    const pollHealthFn: PollHealthFn = async () => true;

    const svc = makeService();
    const result = await startService(serveAlwaysFailsRunFn(), pollHealthFn, svc, eventsPath);

    expect(result.ok).toBe(true);
  });

  it("carries the serve error so a caller can report why the service is degraded", async () => {
    // The dashboard reports lastEvent.data.error as the reason a service is
    // unusable; a degraded event without one leaves it with nothing to say.
    const pollHealthFn: PollHealthFn = async () => true;

    const svc = makeService();
    await startService(serveAlwaysFailsRunFn(), pollHealthFn, svc, eventsPath);

    const events = await readEvents(eventsPath);
    const degraded = events.find(e => e.type === "service.degraded" && e.subjectId === "test-svc");
    expect(degraded?.data?.error).toContain("etag mismatch");
  });

  it("reports the process stage as successful when the process came up", async () => {
    const pollHealthFn: PollHealthFn = async () => true;

    const svc = makeService();
    const result = await startService(serveAlwaysFailsRunFn(), pollHealthFn, svc, eventsPath);

    expect(result.processStarted).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe("startService — process failure still tears down", () => {
  it("kills the spawned child when the health poll times out", async () => {
    // Unchanged behaviour: a process that never became healthy is not
    // something to keep. Only the serve-failure case changed.
    let killed = false;
    const spawnFn: SpawnFn = () => ({
      kill: () => { killed = true; },
      exited: new Promise<number>(() => {}),
    });
    const pollHealthFn: PollHealthFn = async () => false;

    const svc = makeService({
      network: {
        port: 8080,
        healthPath: "/health",
        endpoint: "http://localhost:8080",
        tailscaleServe: false,
      },
    });
    await startService(async () => ({ stdout: "", exitCode: 0, stderr: "" }), pollHealthFn, svc, eventsPath, spawnFn);

    expect(killed).toBe(true);
  });

  it("reports the process stage as failed when the health poll times out", async () => {
    const pollHealthFn: PollHealthFn = async () => false;

    const svc = makeService({
      network: {
        port: 8080,
        healthPath: "/health",
        endpoint: "http://localhost:8080",
        tailscaleServe: false,
      },
    });
    const result = await startService(
      async () => ({ stdout: "", exitCode: 0, stderr: "" }),
      pollHealthFn,
      svc,
      eventsPath
    );

    expect(result.ok).toBe(false);
    expect(result.stage).toBe("process");
    expect(result.processStarted).toBe(false);
  });
});
