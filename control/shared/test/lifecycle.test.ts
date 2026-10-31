// Starting, stopping, adopting and recovering a service, against a fake node
// that records every command and answers Tailscale Serve like the real CLI.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvents } from "../src/events";
import { submit, clearExecutor, type TaskResult } from "../src/executor";
import {
  clearLocks,
  clearRestartCounts,
  clearChildren,
  startService,
  stopService,
  restartService,
  enableService,
  disableService,
  handleProcessExit,
  deriveStartCmd,
  deriveStopCmd,
  deriveRestartCmd,
  deriveEnableCmd,
  deriveDisableCmd,
} from "../src/lifecycle";
import type { Service } from "../../../shared/types";
import type { RunFn, PollHealthFn, SpawnFn, ProbeFn } from "../src/tailscale";

let tmpDir: string;
let eventsPath: string;

beforeEach(async () => {
  clearLocks();
  clearRestartCounts();
  clearChildren();
  clearExecutor();
  tmpDir = await mkdtemp(join(tmpdir(), "lifecycle-test-"));
  eventsPath = join(tmpDir, "events.jsonl");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeService(overrides: Record<string, any> = {}): Service {
  const { network, runner, lifecycle, ...rest } = overrides;
  return {
    id: "test-svc",
    capabilityId: "cap",
    hostId: "host",
    permissions: { enabled: true },
    network: { port: 8080, healthPath: "/health", endpoint: "http://localhost:8080", healthTimeout: 5000, tailscaleServe: true, ...network },
    runner: { type: "process", main: "./server --port 8080", ...runner },
    ops: { env: { workingDirectory: "/tmp/test-svc" } },
    lifecycle: { startupTime: 30000, serveRetryDelay: 1, ...lifecycle },
    ...rest,
  } as Service;
}

const SYSTEMD = { type: "systemd", unit: "test-svc", unitFile: "ops/test-svc.service" };
const MANAGED = { type: "managed", startCmd: ["paseo", "daemon", "start"], stopCmd: ["paseo", "daemon", "stop"], healthCmd: "paseo daemon status" };
const NO_SERVE = { tailscaleServe: false };

/** A node with one Serve slot. `log` holds every command and lifecycle step in order. */
class FakeNode {
  log: string[] = [];
  calls: string[][] = [];
  served = false;
  listening = false;
  probeOk = true;
  healthy = true;
  serveWriteError: string | null = null;
  serveOffError: string | null = null;
  statusFails = false;
  managedHealthy = true;
  commandError: string | null = null;
  polls: { url: string; timeout: number; acceptsAnyResponse?: boolean }[] = [];
  spawned: string[][] = [];
  kills = 0;
  private exits: ((code: number) => void)[] = [];

  runFn: RunFn = async (cmd) => {
    this.calls.push(cmd);
    if (cmd[0] === "tailscale" && cmd.includes("status")) {
      if (this.statusFails) return { stdout: "", exitCode: 1, stderr: "tailscaled is not running" };
      return { stdout: JSON.stringify({ Web: this.served ? { "host:8080": {} } : {} }), exitCode: 0, stderr: "" };
    }
    if (cmd[0] === "tailscale" && cmd.includes("off")) {
      this.log.push("serve-off");
      if (this.serveOffError) return { stdout: "", exitCode: 1, stderr: this.serveOffError };
      this.served = false;
      return { stdout: "", exitCode: 0, stderr: "" };
    }
    if (cmd[0] === "tailscale") {
      this.log.push("serve-add");
      if (this.serveWriteError) return { stdout: "", exitCode: 1, stderr: this.serveWriteError };
      this.served = true;
      return { stdout: "", exitCode: 0, stderr: "" };
    }
    if (cmd[0] === "sh") return { stdout: "", exitCode: this.managedHealthy ? 0 : 1, stderr: "" };
    this.log.push(cmd.join(" "));
    if (this.commandError) return { stdout: "", exitCode: 1, stderr: this.commandError };
    return { stdout: "", exitCode: 0, stderr: "" };
  };

  pollHealthFn: PollHealthFn = async (url, timeout, opts) => {
    this.log.push("poll-health");
    this.polls.push({ url, timeout, acceptsAnyResponse: opts?.acceptsAnyResponse });
    return this.healthy;
  };

  spawnFn: SpawnFn = (cmd) => {
    this.log.push("spawn");
    this.spawned.push(cmd);
    let exit!: (code: number) => void;
    const exited = new Promise<number>(r => { exit = r; });
    this.exits.push(exit);
    return { kill: () => { this.kills++; }, exited };
  };

  probeFn: ProbeFn = async () => {
    if (!this.listening) throw new Error("ECONNREFUSED");
    return { ok: this.probeOk };
  };

  /** Ends the most recently spawned child (or the nth) with `code`. */
  exit(code: number, nth = this.exits.length - 1): void {
    this.exits[nth](code);
  }

  start(svc: Service) {
    return startService(this.runFn, this.pollHealthFn, svc, eventsPath, this.spawnFn, this.probeFn);
  }

  stop(svc: Service) {
    return stopService(this.runFn, svc, eventsPath);
  }
}

async function events(type?: string) {
  const all = (await readEvents(eventsPath)).reverse();
  return type ? all.filter(e => e.type === type) : all;
}

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

describe("commands each runner type issues", () => {
  const plist = `${process.env.HOME}/Library/LaunchAgents/com.example.svc.plist`;
  const gui = `gui/${process.getuid?.() ?? 501}`;
  const systemd = makeService({ runner: { type: "systemd", unit: "embedding" } });
  const launchd = makeService({ runner: { type: "launchd", label: "com.example.svc" } });
  const managed = makeService({ runner: MANAGED });
  const process_ = makeService({ runner: { type: "process", main: ".venv/bin/uvicorn server:app --port 8080" } });

  const TABLE: [string, (s: Service) => string[] | null, Service, string[] | null][] = [
    ["process start", deriveStartCmd, process_, [".venv/bin/uvicorn", "server:app", "--port", "8080"]],
    ["process stop (the held child is killed instead)", deriveStopCmd, process_, null],
    ["systemd start", deriveStartCmd, systemd, ["systemctl", "--user", "start", "embedding.service"]],
    ["systemd stop", deriveStopCmd, systemd, ["systemctl", "--user", "stop", "embedding.service"]],
    ["systemd restart", deriveRestartCmd, systemd, ["systemctl", "--user", "restart", "embedding.service"]],
    ["systemd enable", deriveEnableCmd, systemd, ["systemctl", "--user", "enable", "--now", "embedding.service"]],
    ["systemd disable", deriveDisableCmd, systemd, ["systemctl", "--user", "disable", "--now", "embedding.service"]],
    ["launchd start", deriveStartCmd, launchd, ["launchctl", "bootstrap", gui, plist]],
    ["launchd stop", deriveStopCmd, launchd, ["launchctl", "bootout", gui, plist]],
    ["managed start, as argv with no shell", deriveStartCmd, managed, ["paseo", "daemon", "start"]],
    ["managed stop, as argv with no shell", deriveStopCmd, managed, ["paseo", "daemon", "stop"]],
  ];
  it.each(TABLE)("%s", (_, derive, svc, expected) => {
    expect(derive(svc)).toEqual(expected);
  });

  it("runs enable, disable and restart through those commands", async () => {
    const node = new FakeNode();
    const svc = makeService({ runner: SYSTEMD, network: NO_SERVE });
    await enableService(node.runFn, svc, eventsPath);
    await disableService(node.runFn, svc, eventsPath);
    await restartService(node.runFn, node.pollHealthFn, svc, eventsPath);
    expect(node.log.filter(l => l.startsWith("systemctl"))).toEqual([
      "systemctl --user enable --now test-svc.service",
      "systemctl --user disable --now test-svc.service",
      "systemctl --user restart test-svc.service",
    ]);
  });

  it("refuses to start or stop an external service", async () => {
    const node = new FakeNode();
    const svc = makeService({ runner: { type: "external" } });
    for (const result of [await node.start(svc), await node.stop(svc)]) {
      expect(result.ok).toBe(false);
      expect(result.error).toContain("external");
    }
  });
});

describe("starting a service", () => {
  it("clears stale Serve, spawns, waits for local health for startupTime, registers Serve, then records service.up", async () => {
    const node = new FakeNode();
    node.served = true;
    const svc = makeService({ network: { endpoint: "https://remote-host:8080" }, lifecycle: { startupTime: 60000 } });

    expect(await node.start(svc)).toEqual({ ok: true });
    expect(node.log).toEqual(["serve-off", "spawn", "poll-health", "serve-add"]);
    expect(node.polls).toEqual([{ url: "http://localhost:8080/health", timeout: 60000, acceptsAnyResponse: false }]);
    expect((await events()).map(e => e.type)).toEqual(["service.started", "service.up"]);
  });

  it("waits 30s by default, and treats any response as alive only for a reachable-only service", async () => {
    const node = new FakeNode();
    await node.start(makeService({ lifecycle: { startupTime: undefined } }));
    await node.start(makeService({ network: { healthExpect: "reachable" } }));
    expect(node.polls.map(p => [p.timeout, p.acceptsAnyResponse])).toEqual([[30000, false], [30000, true]]);
  });

  it.each([
    ["process", {}, (n: FakeNode) => n.kills],
    ["systemd", { runner: SYSTEMD }, (n: FakeNode) => n.log.filter(l => l === "systemctl --user stop test-svc.service").length - 1],
  ] as const)("fails a %s service that never becomes healthy at the process stage, stops it, and registers no Serve", async (_, overrides, stops) => {
    const node = new FakeNode();
    node.healthy = false;
    const result = await node.start(makeService(overrides));
    expect(result).toMatchObject({ ok: false, stage: "process", processStarted: false });
    expect(result.error).toContain("startup");
    expect(stops(node)).toBe(1);
    expect(node.log).not.toContain("serve-add");
  });

  it("fails when the start command fails, carrying its error", async () => {
    const node = new FakeNode();
    node.commandError = "start failed";
    const result = await node.start(makeService({ runner: SYSTEMD }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("start failed");
  });

  it("keeps a healthy process running when only Serve registration fails, reporting the service degraded", async () => {
    const node = new FakeNode();
    node.serveWriteError = "etag mismatch";
    const result = await node.start(makeService({ lifecycle: { serveRetryAttempts: 2 } }));

    expect(result).toEqual({ ok: true, stage: "serve", processStarted: true, error: "etag mismatch" });
    expect(node.kills).toBe(0);
    expect(node.log.filter(l => l === "serve-add")).toHaveLength(2);
    expect((await events()).map(e => e.type)).toEqual(["service.started", "tailscale.serve_failed", "service.degraded"]);
  });

  it("never touches Tailscale for a service without tailscaleServe", async () => {
    const node = new FakeNode();
    const svc = makeService({ network: NO_SERVE });
    await node.start(svc);
    await node.stop(svc);
    expect(node.calls.some(c => c[0] === "tailscale")).toBe(false);
  });
});

describe("adopting a service that is already running", () => {
  it("records it up without respawning, registering Serve if the entry is missing", async () => {
    const node = new FakeNode();
    node.listening = true;
    expect(await node.start(makeService())).toEqual({ ok: true });
    expect(node.log).toEqual(["serve-add"]);
    expect((await events("service.up"))[0].data).toEqual({ alreadyRunning: true, serveRepaired: true });
  });

  it.each([
    ["Serve is already registered", (n: FakeNode) => { n.served = true; }],
    ["the Serve status cannot be read", (n: FakeNode) => { n.statusFails = true; }],
  ])("leaves Serve alone when %s", async (_, setup) => {
    const node = new FakeNode();
    node.listening = true;
    setup(node);
    await node.start(makeService());
    expect(node.log).toEqual([]);
    expect((await events("service.up"))[0].data).toEqual({ alreadyRunning: true });
  });

  it("adopts a reachable-only service whose probe answers non-2xx", async () => {
    const node = new FakeNode();
    node.listening = true;
    node.probeOk = false;
    await node.start(makeService({ network: { healthExpect: "reachable" } }));
    expect(node.spawned).toEqual([]);
  });

  it("respawns instead when Serve is missing and the platform holds a child for the service", async () => {
    const node = new FakeNode();
    await node.start(makeService());
    node.listening = true;
    node.served = false;

    expect(await node.start(makeService())).toEqual({ ok: true });
    expect(node.kills).toBe(1);
    expect(node.spawned).toHaveLength(2);
    expect(node.served).toBe(true);
  });

  it("reports the service degraded when registering the missing Serve entry fails", async () => {
    const node = new FakeNode();
    node.listening = true;
    node.serveWriteError = "etag mismatch";
    expect(await node.start(makeService())).toEqual({ ok: true, stage: "serve", processStarted: true, error: "etag mismatch" });
    expect((await events("service.degraded"))).toHaveLength(1);
  });
});

describe("a managed runner", () => {
  it("starts through its own command without spawning, and is healthy when healthCmd exits 0", async () => {
    const node = new FakeNode();
    const result = await node.start(makeService({ runner: MANAGED, network: NO_SERVE }));
    expect(result.ok).toBe(true);
    expect(node.log).toEqual(["paseo daemon stop", "paseo daemon start"]);
    expect(node.spawned).toEqual([]);
    expect(node.polls).toEqual([]);
  });

  it.each([
    ["its start command fails", (n: FakeNode) => { n.commandError = "paseo: command not found"; }, "command not found"],
    ["healthCmd never passes within startupTime", (n: FakeNode) => { n.managedHealthy = false; }, "startup"],
  ])("fails a start when %s", async (_, setup, error) => {
    const node = new FakeNode();
    setup(node);
    const result = await node.start(makeService({ runner: MANAGED, network: NO_SERVE, lifecycle: { startupTime: 100 } }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain(error);
  });

  it("confirms a stop only once healthCmd reports the daemon down", async () => {
    const svc = makeService({ runner: MANAGED, network: NO_SERVE });
    const down = new FakeNode();
    down.managedHealthy = false;
    expect((await down.stop(svc)).ok).toBe(true);

    const stillUp = new FakeNode();
    const result = await stillUp.stop(svc);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("healthy");

    const failing = new FakeNode();
    failing.commandError = "stop failed";
    expect((await failing.stop(svc)).ok).toBe(false);
  }, 10000);
});

describe("stopping a service", () => {
  it("removes Serve before stopping the process, then records service.stopped", async () => {
    const node = new FakeNode();
    node.served = true;
    expect((await node.stop(makeService({ runner: SYSTEMD }))).ok).toBe(true);
    expect(node.log).toEqual(["serve-off", "systemctl --user stop test-svc.service"]);
    expect((await events()).map(e => e.type)).toEqual(["service.stopped"]);
  });

  it("still stops and succeeds when Serve removal fails, recording the failure", async () => {
    const node = new FakeNode();
    node.served = true;
    node.serveOffError = "error";
    expect((await node.stop(makeService({ runner: SYSTEMD }))).ok).toBe(true);
    expect(node.log).toContain("systemctl --user stop test-svc.service");
    expect((await events()).map(e => e.type)).toEqual(["tailscale.serve_remove_failed", "service.stopped"]);
  });
});

describe("crash recovery", () => {
  it("records a nonzero exit of the held child as a crash, removes its Serve entry, and marks it down when restart is off", async () => {
    const node = new FakeNode();
    await node.start(makeService());
    node.exit(1);
    await tick();

    const crashed = await events("service.crashed");
    expect(crashed.map(e => e.data.exitCode)).toEqual([1]);
    expect(node.served).toBe(false);
    expect(await events("service.down")).toHaveLength(1);
    expect(node.spawned).toHaveLength(1);
  });

  it.each([
    ["a deliberate stop", async (n: FakeNode, svc: Service) => { await n.stop(svc); n.exit(143, 0); }],
    ["the exit of a child already replaced", async (n: FakeNode, svc: Service) => { await n.start(svc); n.exit(1, 0); }],
    ["a clean exit", async (n: FakeNode) => { n.exit(0, 0); }],
  ])("does not treat %s as a crash", async (_, act) => {
    const node = new FakeNode();
    const svc = makeService({ lifecycle: { restartOnCrash: true, restartBackoff: 1 } });
    await node.start(svc);
    await act(node, svc);
    await tick();
    expect(await events("service.crashed")).toEqual([]);
  });

  it("restarts a crashed service, and a restart that comes up healthy resets the budget", async () => {
    const node = new FakeNode();
    await node.start(makeService({ lifecycle: { restartOnCrash: true, restartBackoff: 1, maxRestarts: 1 } }));
    for (const spawns of [2, 3]) {
      node.exit(1);
      await tick(60);
      expect(node.spawned).toHaveLength(spawns);
    }
    expect(await events("service.down")).toEqual([]);
  });

  it.each([[2, true], [3, false]])("with %i failed recoveries behind it and a budget of 3, restarts: %s", async (restartCount, restarts) => {
    const node = new FakeNode();
    const svc = makeService({ lifecycle: { restartOnCrash: true, restartBackoff: 1, maxRestarts: 3 } });
    await handleProcessExit(node.runFn, svc, eventsPath, 1, { restartCount, pollHealthFn: node.pollHealthFn, spawnFn: node.spawnFn });
    expect(node.spawned.length > 0).toBe(restarts);
    expect((await events("service.down")).length).toBe(restarts ? 0 : 1);
  });

  it("records a crash but skips recovery while a lifecycle request for the service is pending", async () => {
    const node = new FakeNode();
    const svc = makeService({ lifecycle: { restartOnCrash: true, restartBackoff: 1 } });
    await node.start(svc);

    let release!: () => void;
    const pending = submit(svc.id, "stop", () => new Promise<TaskResult>(r => { release = () => r({ ok: true }); }));
    node.exit(1);
    await tick(60);

    expect(node.spawned).toHaveLength(1);
    expect((await events("service.crashed"))[0].data.recovery).toContain("skipped");
    release();
    await pending;
  });
});
