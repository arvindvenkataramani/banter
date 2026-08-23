import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvents } from "../src/events";
import { clearLocks } from "../src/lifecycle";
import type { Service } from "../../../shared/types";

// ── Types for injectable dependencies ───────────────────────────────────────

type RunFn = (cmd: string[]) => Promise<{ stdout: string; exitCode: number; stderr: string }>;
type PollHealthFn = (endpoint: string, timeout: number) => Promise<boolean>;
type SpawnProcessFn = (cmd: string, opts: { cwd?: string; env?: Record<string, string> }) => {
  pid: number;
  exited: Promise<number>;
  kill: () => void;
};

// ── Fixtures ────────────────────────────────────────────────────────────────

let tmpDir: string;
let eventsPath: string;

beforeEach(async () => {
  clearLocks();
  tmpDir = await mkdtemp(join(tmpdir(), "lifecycle-test-"));
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

// Tailscale `serve status --json` probes need a parseable response.
// For the add-serve verification probe we report the port as registered so
// addTailscaleServe sees its entry and returns ok.
function tailscaleStatusStdout(port: number): string {
  return JSON.stringify({ Web: { [`test-host:${port}`]: {} } });
}

function successRunFn(): RunFn {
  return async (cmd) => {
    if (cmd.includes("status") && cmd.includes("--json")) {
      return { stdout: tailscaleStatusStdout(8080), exitCode: 0, stderr: "" };
    }
    return { stdout: "", exitCode: 0, stderr: "" };
  };
}

function trackingRunFn(): { runFn: RunFn; calls: string[][] } {
  const calls: string[][] = [];
  const runFn: RunFn = async (cmd) => {
    calls.push(cmd);
    if (cmd.includes("status") && cmd.includes("--json")) {
      return { stdout: tailscaleStatusStdout(8080), exitCode: 0, stderr: "" };
    }
    return { stdout: "", exitCode: 0, stderr: "" };
  };
  return { runFn, calls };
}

// ═════════════════════════════════════════════════════════════════════════════
// Runner: command derivation
// ═════════════════════════════════════════════════════════════════════════════

describe("runner command derivation", () => {
  describe("process runner", () => {
    it("derives start command from runner.main", async () => {
      const { runFn, calls } = trackingRunFn();
      const pollHealthFn: PollHealthFn = async () => true;

      const { startService } = await import("../src/lifecycle");
      const svc = makeService({ runner: { type: "process", main: ".venv/bin/uvicorn server:app --port 8080" } });
      await startService(runFn, pollHealthFn, svc, eventsPath);

      // The start command should contain the main command (spawned or via shell)
      const startCmd = calls.find(c => c.some(arg => arg.includes("uvicorn")));
      expect(startCmd).toBeDefined();
    });

    it("derives stop from held process reference, not command pattern matching", async () => {
      // Process runner uses Bun.spawn and holds the child — stop kills the child,
      // not pkill -f. This test verifies stop does not shell out to pkill.
      const { runFn, calls } = trackingRunFn();

      const { stopService } = await import("../src/lifecycle");
      const svc = makeService({ runner: { type: "process", main: "./server" } });
      await stopService(runFn, svc, eventsPath);

      const pkillCmd = calls.find(c => c.some(arg => arg.includes("pkill")));
      expect(pkillCmd).toBeUndefined();
    });
  });

  describe("systemd runner", () => {
    it("derives start command as systemctl --user start {unit}.service", async () => {
      const { runFn, calls } = trackingRunFn();
      const pollHealthFn: PollHealthFn = async () => true;

      const { startService } = await import("../src/lifecycle");
      const svc = makeService({
        runner: { type: "systemd", unit: "embedding", unitFile: "ops/systemd/embedding.service" },
        network: { port: 8767, healthPath: "/health", endpoint: "http://localhost:8767", tailscaleServe: false },
      });
      await startService(runFn, pollHealthFn, svc, eventsPath);

      const startCmd = calls.find(c =>
        c.includes("systemctl") && c.includes("start") && c.includes("embedding.service")
      );
      expect(startCmd).toBeDefined();
      expect(startCmd).toContain("--user");
    });

    it("derives stop command as systemctl --user stop {unit}.service", async () => {
      const { runFn, calls } = trackingRunFn();

      const { stopService } = await import("../src/lifecycle");
      const svc = makeService({
        runner: { type: "systemd", unit: "embedding", unitFile: "ops/systemd/embedding.service" },
        network: { port: 8767, healthPath: "/health", endpoint: "http://localhost:8767", tailscaleServe: false },
      });
      await stopService(runFn, svc, eventsPath);

      const stopCmd = calls.find(c =>
        c.includes("systemctl") && c.includes("stop") && c.includes("embedding.service")
      );
      expect(stopCmd).toBeDefined();
    });

    it("derives restart command as systemctl --user restart {unit}.service", async () => {
      const { runFn, calls } = trackingRunFn();
      const pollHealthFn: PollHealthFn = async () => true;

      const { restartService } = await import("../src/lifecycle");
      const svc = makeService({
        runner: { type: "systemd", unit: "embedding", unitFile: "ops/systemd/embedding.service" },
      });
      await restartService(runFn, pollHealthFn, svc, eventsPath);

      const restartCmd = calls.find(c =>
        c.includes("systemctl") && c.includes("restart") && c.includes("embedding.service")
      );
      expect(restartCmd).toBeDefined();
    });

    it("derives enable command as systemctl --user enable --now {unit}.service", async () => {
      const { runFn, calls } = trackingRunFn();

      const { enableService } = await import("../src/lifecycle");
      const svc = makeService({
        runner: { type: "systemd", unit: "embedding", unitFile: "ops/systemd/embedding.service" },
      });
      await enableService(runFn, svc, eventsPath);

      const enableCmd = calls.find(c =>
        c.includes("systemctl") && c.includes("enable") && c.includes("--now")
      );
      expect(enableCmd).toBeDefined();
    });

    it("derives disable command as systemctl --user disable --now {unit}.service", async () => {
      const { runFn, calls } = trackingRunFn();

      const { disableService } = await import("../src/lifecycle");
      const svc = makeService({
        runner: { type: "systemd", unit: "embedding", unitFile: "ops/systemd/embedding.service" },
      });
      await disableService(runFn, svc, eventsPath);

      const disableCmd = calls.find(c =>
        c.includes("systemctl") && c.includes("disable") && c.includes("--now")
      );
      expect(disableCmd).toBeDefined();
    });
  });

  describe("launchd runner", () => {
    it("derives enable as launchctl bootstrap with the plist label", async () => {
      const { runFn, calls } = trackingRunFn();

      const { enableService } = await import("../src/lifecycle");
      const svc = makeService({
        runner: { type: "launchd", label: "com.banter.control-shard", plist: "ops/com.banter.control-shard.plist" },
      });
      await enableService(runFn, svc, eventsPath);

      const bootstrapCmd = calls.find(c =>
        c.includes("launchctl") && c.includes("bootstrap")
      );
      expect(bootstrapCmd).toBeDefined();
    });

    it("derives disable as launchctl bootout with the plist label", async () => {
      const { runFn, calls } = trackingRunFn();

      const { disableService } = await import("../src/lifecycle");
      const svc = makeService({
        runner: { type: "launchd", label: "com.banter.control-shard", plist: "ops/com.banter.control-shard.plist" },
      });
      await disableService(runFn, svc, eventsPath);

      const bootoutCmd = calls.find(c =>
        c.includes("launchctl") && c.includes("bootout")
      );
      expect(bootoutCmd).toBeDefined();
    });
  });

  describe("managed runner", () => {
    it("derives start command from runner.startCmd as argv, no shell wrapping", async () => {
      const { runFn, calls } = trackingRunFn();
      const pollHealthFn: PollHealthFn = async () => true;

      const { startService } = await import("../src/lifecycle");
      const svc = makeService({
        runner: { type: "managed", startCmd: ["paseo", "daemon", "start"], stopCmd: ["paseo", "daemon", "stop"], healthCmd: "paseo daemon status" },
        network: { port: 6767, healthPath: "", tailscaleServe: false },
      });
      await startService(runFn, pollHealthFn, svc, eventsPath);

      // The start command itself is argv, unwrapped — a separate sh -c call is
      // expected later in the same sequence for the healthCmd poll, so assert
      // on the start call specifically rather than the whole call list.
      expect(calls).toContainEqual(["paseo", "daemon", "start"]);
    });

    it("derives stop command from runner.stopCmd as argv, no shell wrapping", async () => {
      const calls: string[][] = [];
      const runFn: RunFn = async (cmd) => {
        calls.push(cmd);
        // healthCmd (via sh -c) reports unhealthy so post-stop confirmation succeeds
        if (cmd[0] === "sh" && cmd[1] === "-c") return { stdout: "", exitCode: 1, stderr: "" };
        return { stdout: "", exitCode: 0, stderr: "" };
      };

      const { stopService } = await import("../src/lifecycle");
      const svc = makeService({
        runner: { type: "managed", startCmd: ["paseo", "daemon", "start"], stopCmd: ["paseo", "daemon", "stop"], healthCmd: "paseo daemon status" },
        network: { port: 6767, healthPath: "", tailscaleServe: false },
      });
      await stopService(runFn, svc, eventsPath);

      expect(calls).toContainEqual(["paseo", "daemon", "stop"]);
    });

    it("does not spawn or hold a child process on start", async () => {
      let spawnCalled = false;
      const spawnFn: SpawnProcessFn = () => {
        spawnCalled = true;
        return { pid: 1, exited: new Promise(() => {}), kill: () => {} };
      };
      const pollHealthFn: PollHealthFn = async () => true;

      const { startService, getChild } = await import("../src/lifecycle");
      const svc = makeService({
        runner: { type: "managed", startCmd: ["paseo", "daemon", "start"], stopCmd: ["paseo", "daemon", "stop"], healthCmd: "paseo daemon status" },
        network: { port: 6767, healthPath: "", tailscaleServe: false },
      });
      await startService(successRunFn(), pollHealthFn, svc, eventsPath, spawnFn as any);

      expect(spawnCalled).toBe(false);
      expect(getChild(svc.id)).toBeUndefined();
    });

    it("a start command exiting 0 immediately (fork-and-detach) is not treated as failure", async () => {
      const runFn: RunFn = async (cmd) => {
        // Simulates paseo's own start command: exits 0 right away, no lingering process
        return { stdout: "Daemon starting in background (PID 1234).", exitCode: 0, stderr: "" };
      };
      const pollHealthFn: PollHealthFn = async () => true;

      const { startService } = await import("../src/lifecycle");
      const svc = makeService({
        runner: { type: "managed", startCmd: ["paseo", "daemon", "start"], stopCmd: ["paseo", "daemon", "stop"], healthCmd: "paseo daemon status" },
        network: { port: 6767, healthPath: "", tailscaleServe: false },
      });
      const result = await startService(runFn, pollHealthFn, svc, eventsPath);

      expect(result.ok).toBe(true);
    });

    it("returns error if the start command itself fails (nonzero exit)", async () => {
      const runFn: RunFn = async () => ({ stdout: "", exitCode: 1, stderr: "paseo: command not found" });
      const pollHealthFn: PollHealthFn = async () => true;

      const { startService } = await import("../src/lifecycle");
      const svc = makeService({
        runner: { type: "managed", startCmd: ["paseo", "daemon", "start"], stopCmd: ["paseo", "daemon", "stop"], healthCmd: "paseo daemon status" },
        network: { port: 6767, healthPath: "", tailscaleServe: false },
      });
      const result = await startService(runFn, pollHealthFn, svc, eventsPath);

      expect(result.ok).toBe(false);
      expect(result.error).toContain("command not found");
    });

    it("returns error if the stop command fails (nonzero exit)", async () => {
      const runFn: RunFn = async () => ({ stdout: "", exitCode: 1, stderr: "stop failed" });

      const { stopService } = await import("../src/lifecycle");
      const svc = makeService({
        runner: { type: "managed", startCmd: ["paseo", "daemon", "start"], stopCmd: ["paseo", "daemon", "stop"], healthCmd: "paseo daemon status" },
        network: { port: 6767, healthPath: "", tailscaleServe: false },
      });
      const result = await stopService(runFn, svc, eventsPath);

      expect(result.ok).toBe(false);
    });

    it("confirms the daemon is actually down via healthCmd after the stop command succeeds", async () => {
      let healthChecked = false;
      const runFn: RunFn = async (cmd) => {
        if (cmd[0] === "sh" && cmd[1] === "-c") {
          healthChecked = true;
          return { stdout: "", exitCode: 1, stderr: "" }; // unhealthy — confirms stopped
        }
        return { stdout: "", exitCode: 0, stderr: "" }; // stop command succeeds
      };

      const { stopService } = await import("../src/lifecycle");
      const svc = makeService({
        runner: { type: "managed", startCmd: ["paseo", "daemon", "start"], stopCmd: ["paseo", "daemon", "stop"], healthCmd: "paseo daemon status" },
        network: { port: 6767, healthPath: "", tailscaleServe: false },
      });
      const result = await stopService(runFn, svc, eventsPath);

      expect(healthChecked).toBe(true);
      expect(result.ok).toBe(true);
    });

    it("returns error if the stop command succeeds but healthCmd still reports healthy", async () => {
      // Stop command exiting 0 doesn't guarantee the daemon actually stopped —
      // this is the scenario healthCmd confirmation exists to catch. This test
      // exhausts the real MANAGED_STOP_CONFIRM_MS grace period (a few seconds),
      // since it's asserting the negative case (never goes unhealthy).
      const runFn: RunFn = async (cmd) => {
        if (cmd[0] === "sh" && cmd[1] === "-c") return { stdout: "", exitCode: 0, stderr: "" }; // still healthy
        return { stdout: "", exitCode: 0, stderr: "" }; // stop command reports success
      };

      const { stopService } = await import("../src/lifecycle");
      const svc = makeService({
        runner: { type: "managed", startCmd: ["paseo", "daemon", "start"], stopCmd: ["paseo", "daemon", "stop"], healthCmd: "paseo daemon status" },
        network: { port: 6767, healthPath: "", tailscaleServe: false },
      });
      const result = await stopService(runFn, svc, eventsPath);

      expect(result.ok).toBe(false);
      expect(result.error).toContain("healthy");
    }, 10000);

    it("polls health via healthCmd through runFn during startup, not HTTP", async () => {
      let httpPolled = false;
      const pollHealthFn: PollHealthFn = async () => {
        httpPolled = true;
        return true;
      };
      const runFn: RunFn = async (cmd) => {
        if (cmd[0] === "sh" && cmd[1] === "-c" && cmd[2].includes("paseo daemon status")) {
          return { stdout: '{"localDaemon":"running"}', exitCode: 0, stderr: "" };
        }
        return { stdout: "", exitCode: 0, stderr: "" };
      };

      const { startService } = await import("../src/lifecycle");
      const svc = makeService({
        runner: { type: "managed", startCmd: ["paseo", "daemon", "start"], stopCmd: ["paseo", "daemon", "stop"], healthCmd: "paseo daemon status --json | jq -e '.localDaemon == \"running\"'" },
        network: { port: 6767, healthPath: "", tailscaleServe: false },
      });
      const result = await startService(runFn, pollHealthFn, svc, eventsPath);

      expect(result.ok).toBe(true);
      expect(httpPolled).toBe(false);
    });

    it("start fails if healthCmd never exits 0 within startupTime", async () => {
      const pollHealthFn: PollHealthFn = async () => true; // unused by managed runner
      const runFn: RunFn = async (cmd) => {
        if (cmd[0] === "sh" && cmd[1] === "-c") {
          return { stdout: "", exitCode: 1, stderr: "" }; // health check never succeeds
        }
        return { stdout: "", exitCode: 0, stderr: "" };
      };

      const { startService } = await import("../src/lifecycle");
      const svc = makeService({
        runner: { type: "managed", startCmd: ["paseo", "daemon", "start"], stopCmd: ["paseo", "daemon", "stop"], healthCmd: "paseo daemon status" },
        network: { port: 6767, healthPath: "", tailscaleServe: false },
        lifecycle: { startupTime: 100 },
      });
      const result = await startService(runFn, pollHealthFn, svc, eventsPath);

      expect(result.ok).toBe(false);
      expect(result.error).toContain("startup");
    });

    it("does not require network.tailscaleServe steps when tailscaleServe is unset", async () => {
      let tailscaleCalled = false;
      const runFn: RunFn = async (cmd) => {
        if (cmd[0] === "tailscale") tailscaleCalled = true;
        if (cmd[0] === "sh" && cmd[1] === "-c") return { stdout: "", exitCode: 0, stderr: "" };
        return { stdout: "", exitCode: 0, stderr: "" };
      };
      const pollHealthFn: PollHealthFn = async () => true;

      const { startService } = await import("../src/lifecycle");
      const svc = makeService({
        runner: { type: "managed", startCmd: ["paseo", "daemon", "start"], stopCmd: ["paseo", "daemon", "stop"], healthCmd: "paseo daemon status" },
        network: { port: 6767, healthPath: "", tailscaleServe: false },
      });
      await startService(runFn, pollHealthFn, svc, eventsPath);

      expect(tailscaleCalled).toBe(false);
    });
  });

  describe("external runner", () => {
    it("start returns error for external services", async () => {
      const pollHealthFn: PollHealthFn = async () => true;

      const { startService } = await import("../src/lifecycle");
      const svc = makeService({ runner: { type: "external" } });
      const result = await startService(successRunFn(), pollHealthFn, svc, eventsPath);

      expect(result.ok).toBe(false);
      expect(result.error).toContain("external");
    });

    it("stop returns error for external services", async () => {
      const { stopService } = await import("../src/lifecycle");
      const svc = makeService({ runner: { type: "external" } });
      const result = await stopService(successRunFn(), svc, eventsPath);

      expect(result.ok).toBe(false);
      expect(result.error).toContain("external");
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Start sequence: atomic lifecycle
// ═════════════════════════════════════════════════════════════════════════════

describe("startService — atomic lifecycle", () => {
  it("sequence is: teardown serve → start → poll health → setup serve → emit event", async () => {
    const order: string[] = [];
    const runFn: RunFn = async (cmd) => {
      // Return valid JSON for status check so isPortServed returns true and teardown actually fires
      if (cmd.includes("status")) {
        return { stdout: JSON.stringify({ Web: { "hostname:8080": {} } }), exitCode: 0, stderr: "" };
      }
      if (cmd[0] === "tailscale" && cmd.includes("off")) order.push("teardown-serve");
      else if (cmd[0] === "tailscale" && !cmd.includes("off")) order.push("setup-serve");
      else if (cmd.some(a => a.includes("server"))) order.push("start");
      return { stdout: "", exitCode: 0, stderr: "" };
    };
    const pollHealthFn: PollHealthFn = async () => {
      order.push("poll-health");
      return true;
    };

    const { startService } = await import("../src/lifecycle");
    const svc = makeService();
    await startService(runFn, pollHealthFn, svc, eventsPath);

    // Process runner: no stop command (kills child directly). Verify remaining ordering.
    expect(order.indexOf("teardown-serve")).toBeLessThan(order.indexOf("start"));
    expect(order.indexOf("start")).toBeLessThan(order.indexOf("poll-health"));
    expect(order.indexOf("poll-health")).toBeLessThan(order.indexOf("setup-serve"));
  });

  it("polls health at localhost, not the Tailscale endpoint", async () => {
    let polledUrl = "";
    const pollHealthFn: PollHealthFn = async (url) => {
      polledUrl = url;
      return true;
    };

    const { startService } = await import("../src/lifecycle");
    const svc = makeService({
      network: { port: 9999, endpoint: "https://remote-host:9999", healthPath: "/healthz", healthTimeout: 5000 },
    });
    await startService(successRunFn(), pollHealthFn, svc, eventsPath);

    expect(polledUrl).toBe("http://localhost:9999/healthz");
  });

  it("passes startupTime to pollHealth, not healthTimeout", async () => {
    let polledTimeout = 0;
    const pollHealthFn: PollHealthFn = async (_url, timeout) => {
      polledTimeout = timeout;
      return true;
    };

    const { startService } = await import("../src/lifecycle");
    const svc = makeService({
      network: { port: 8080, healthPath: "/health", endpoint: "http://localhost:8080", healthTimeout: 5000 },
      lifecycle: { startupTime: 60000 },
    });
    await startService(successRunFn(), pollHealthFn, svc, eventsPath);

    expect(polledTimeout).toBe(60000);
  });

  it("emits service.up event after successful start", async () => {
    const pollHealthFn: PollHealthFn = async () => true;

    const { startService } = await import("../src/lifecycle");
    const svc = makeService();
    await startService(successRunFn(), pollHealthFn, svc, eventsPath);

    const events = await readEvents(eventsPath);
    expect(events.some(e => e.type === "service.up" && e.subjectId === "test-svc")).toBe(true);
  });

  it("returns error if health poll times out", async () => {
    const pollHealthFn: PollHealthFn = async () => false;

    const { startService } = await import("../src/lifecycle");
    // Use systemd runner so a stop command exists for cleanup
    const svc = makeService({
      runner: { type: "systemd", unit: "test-svc", unitFile: "ops/test-svc.service" },
      network: { port: 8080, healthPath: "/health", endpoint: "http://localhost:8080", tailscaleServe: false },
    });
    const result = await startService(successRunFn(), pollHealthFn, svc, eventsPath);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("startup");
  });

  it("issues stop command to clean up if health poll times out (systemd runner)", async () => {
    const stopped: boolean[] = [];
    const runFn: RunFn = async (cmd) => {
      if (cmd.includes("stop") && cmd.includes("test-svc.service")) stopped.push(true);
      return { stdout: "", exitCode: 0, stderr: "" };
    };
    const pollHealthFn: PollHealthFn = async () => false;

    const { startService } = await import("../src/lifecycle");
    const svc = makeService({
      runner: { type: "systemd", unit: "test-svc", unitFile: "ops/test-svc.service" },
      network: { port: 8080, healthPath: "/health", endpoint: "http://localhost:8080", tailscaleServe: false },
    });
    await startService(runFn, pollHealthFn, svc, eventsPath);
    expect(stopped.length).toBeGreaterThan(0);
  });

  it("does not setup Tailscale Serve if health poll times out", async () => {
    let serveAdded = false;
    const runFn: RunFn = async (cmd) => {
      if (cmd[0] === "tailscale" && !cmd.includes("off") && !cmd.includes("status") && cmd.some(a => a.includes("localhost"))) {
        serveAdded = true;
      }
      return { stdout: "", exitCode: 0, stderr: "" };
    };
    const pollHealthFn: PollHealthFn = async () => false;

    const { startService } = await import("../src/lifecycle");
    const svc = makeService();
    await startService(runFn, pollHealthFn, svc, eventsPath);

    expect(serveAdded).toBe(false);
  });

  it("returns error if Tailscale Serve setup fails", async () => {
    const runFn: RunFn = async (cmd) => {
      // Serve add fails
      if (cmd[0] === "tailscale" && !cmd.includes("off") && !cmd.includes("status")) {
        return { stdout: "", exitCode: 1, stderr: "serve failed" };
      }
      return { stdout: "", exitCode: 0, stderr: "" };
    };
    const pollHealthFn: PollHealthFn = async () => true;

    const { startService } = await import("../src/lifecycle");
    const svc = makeService();
    const result = await startService(runFn, pollHealthFn, svc, eventsPath);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("tailscale");
  });

  it("issues stop command after Tailscale Serve setup fails (systemd runner)", async () => {
    let stopCalled = false;
    const runFn: RunFn = async (cmd) => {
      // Serve add fails
      if (cmd[0] === "tailscale" && !cmd.includes("off") && !cmd.includes("status")) {
        return { stdout: "", exitCode: 1, stderr: "serve failed" };
      }
      if (cmd.includes("stop") && cmd.includes("test-svc.service")) stopCalled = true;
      return { stdout: "", exitCode: 0, stderr: "" };
    };
    const pollHealthFn: PollHealthFn = async () => true;

    const { startService } = await import("../src/lifecycle");
    const svc = makeService({
      runner: { type: "systemd", unit: "test-svc", unitFile: "ops/test-svc.service" },
    });
    await startService(runFn, pollHealthFn, svc, eventsPath);
    expect(stopCalled).toBe(true);
  });

  it("emits tailscale.serve_failed event when Tailscale Serve setup fails", async () => {
    const runFn: RunFn = async (cmd) => {
      if (cmd[0] === "tailscale" && !cmd.includes("off") && !cmd.includes("status") && cmd.some(a => a.includes("localhost"))) {
        return { stdout: "", exitCode: 1, stderr: "serve failed" };
      }
      return { stdout: "", exitCode: 0, stderr: "" };
    };
    const pollHealthFn: PollHealthFn = async () => true;

    const { startService } = await import("../src/lifecycle");
    const svc = makeService();
    await startService(runFn, pollHealthFn, svc, eventsPath);

    const events = await readEvents(eventsPath);
    expect(events.some(e => e.type === "tailscale.serve_failed")).toBe(true);
  });

  it("skips Tailscale Serve steps when tailscaleServe is false", async () => {
    let tailscaleCalled = false;
    const runFn: RunFn = async (cmd) => {
      if (cmd[0] === "tailscale") tailscaleCalled = true;
      return { stdout: "", exitCode: 0, stderr: "" };
    };
    const pollHealthFn: PollHealthFn = async () => true;

    const { startService } = await import("../src/lifecycle");
    const svc = makeService({ network: { port: 8080, healthPath: "/health", endpoint: "http://localhost:8080", tailscaleServe: false } });
    await startService(runFn, pollHealthFn, svc, eventsPath);

    expect(tailscaleCalled).toBe(false);
  });

  it("returns error if start command fails", async () => {
    const runFn: RunFn = async (cmd) => {
      // Fail on any start-like command that isn't a stop or tailscale command
      if (!cmd.some(a => a.includes("stop")) && cmd[0] !== "tailscale") {
        return { stdout: "", exitCode: 1, stderr: "start failed" };
      }
      return { stdout: "", exitCode: 0, stderr: "" };
    };
    const pollHealthFn: PollHealthFn = async () => true;

    const { startService } = await import("../src/lifecycle");
    const svc = makeService();
    const result = await startService(runFn, pollHealthFn, svc, eventsPath);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("start failed");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Fast path: already-running process, Tailscale Serve repair
// ═════════════════════════════════════════════════════════════════════════════

describe("startService — fast path Tailscale Serve repair", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockHealthyFetch() {
    globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;
  }

  // Reports the port as NOT registered with Tailscale Serve until an add command
  // runs — mirrors real `tailscale serve` state so addTailscaleServe's own
  // post-add verification (tailscale.ts) succeeds.
  function unservedRunFn(port = 8080): { runFn: RunFn; calls: string[][] } {
    const calls: string[][] = [];
    let served = false;
    const runFn: RunFn = async (cmd) => {
      calls.push(cmd);
      if (cmd.includes("status") && cmd.includes("--json")) {
        return { stdout: JSON.stringify({ Web: served ? { [`test-host:${port}`]: {} } : {} }), exitCode: 0, stderr: "" };
      }
      if (cmd[0] === "tailscale" && !cmd.includes("off")) served = true;
      return { stdout: "", exitCode: 0, stderr: "" };
    };
    return { runFn, calls };
  }

  it("repairs a missing Tailscale Serve entry instead of respawning when no child is held", async () => {
    mockHealthyFetch();
    const { runFn, calls } = unservedRunFn();
    const pollHealthFn: PollHealthFn = async () => true;

    const { startService, clearChildren } = await import("../src/lifecycle");
    clearChildren();
    const svc = makeService();
    const result = await startService(runFn, pollHealthFn, svc, eventsPath);

    expect(result.ok).toBe(true);
    // The process start command must never run — respawning would collide on the
    // port with the still-running (unmanaged) process.
    expect(calls.some(c => c.some(a => a.includes("server")))).toBe(false);
    // But the missing Serve entry must be repaired.
    expect(calls.some(c => c[0] === "tailscale" && !c.includes("off") && !c.includes("status"))).toBe(true);
  });

  it("emits service.up with alreadyRunning after repairing Tailscale Serve", async () => {
    mockHealthyFetch();
    const { runFn } = unservedRunFn();
    const pollHealthFn: PollHealthFn = async () => true;

    const { startService, clearChildren } = await import("../src/lifecycle");
    clearChildren();
    const svc = makeService();
    await startService(runFn, pollHealthFn, svc, eventsPath);

    const events = await readEvents(eventsPath);
    const upEvent = events.find(e => e.type === "service.up" && e.subjectId === "test-svc");
    expect(upEvent?.data).toEqual({ alreadyRunning: true, serveRepaired: true });
  });

  it("skips the Tailscale check entirely when tailscaleServe is false", async () => {
    mockHealthyFetch();
    const { runFn, calls } = unservedRunFn();
    const pollHealthFn: PollHealthFn = async () => true;

    const { startService, clearChildren } = await import("../src/lifecycle");
    clearChildren();
    const svc = makeService({ network: { port: 8080, healthPath: "/health", endpoint: "http://localhost:8080", tailscaleServe: false } });
    const result = await startService(runFn, pollHealthFn, svc, eventsPath);

    expect(result.ok).toBe(true);
    expect(calls.some(c => c[0] === "tailscale")).toBe(false);
  });

  it("short-circuits without re-registering when Serve is already present", async () => {
    mockHealthyFetch();
    const { runFn, calls } = trackingRunFn(); // reports port 8080 as already served
    const pollHealthFn: PollHealthFn = async () => true;

    const { startService, clearChildren } = await import("../src/lifecycle");
    clearChildren();
    const svc = makeService();
    const result = await startService(runFn, pollHealthFn, svc, eventsPath);

    expect(result.ok).toBe(true);
    // Only the status check should have run — no redundant add/remove.
    expect(calls.filter(c => c[0] === "tailscale" && !c.includes("status")).length).toBe(0);
    // Assert the adopt-existing event specifically: without this the call-count
    // check above would also pass for a full restart that skipped Serve entirely.
    const events = await readEvents(eventsPath);
    const upEvent = events.find(e => e.type === "service.up" && e.subjectId === "test-svc");
    expect(upEvent?.data).toEqual({ alreadyRunning: true });
    // The process must not have been respawned.
    expect(calls.some(c => c.some(a => a.includes("server")))).toBe(false);
  });

  // Finding 3: the "Serve missing AND we hold a child reference" branch — the case
  // the fast-path comment is specifically about, previously uncovered. Here a
  // restart IS safe (we own the process), so it must take the full sequence:
  // kill the tracked child, respawn, and re-register Serve.
  it("falls through to a full restart when Serve is missing and a child is held", async () => {
    const { startService, clearChildren, getChild } = await import("../src/lifecycle");
    clearChildren();

    let killed = 0;
    let spawned: string[][] = [];
    const spawnFn = (cmd: string[]) => { spawned.push(cmd); return { kill: () => { killed++; } }; };
    const pollHealthFn: PollHealthFn = async () => true;

    // First start: probe fails, so the full path runs and seeds a child reference.
    globalThis.fetch = (async () => { throw new Error("connection refused"); }) as typeof fetch;
    const seed = unservedRunFn();
    await startService(seed.runFn, pollHealthFn, makeService(), eventsPath, spawnFn as any);
    expect(getChild("test-svc")).toBeDefined();

    // Now the process answers locally but its Serve entry is gone, and we still
    // hold the child — the fast path must NOT adopt-and-repair here.
    mockHealthyFetch();
    spawned = [];
    const { runFn, calls } = unservedRunFn();
    const result = await startService(runFn, pollHealthFn, makeService(), eventsPath, spawnFn as any);

    expect(result.ok).toBe(true);
    expect(killed).toBe(1);                              // old child torn down
    expect(spawned).toEqual([["./server", "--port", "8080"]]); // and respawned
    // Serve re-registered as part of the full sequence.
    expect(calls.some(c => c[0] === "tailscale" && c.includes("localhost:8080"))).toBe(true);
    // A full restart emits a plain service.up, not the adopt-existing shape.
    const events = await readEvents(eventsPath);
    const ups = events.filter(e => e.type === "service.up" && e.subjectId === "test-svc");
    expect(ups[ups.length - 1]?.data).toEqual({});
  });

  // Finding 5: a failed `tailscale serve status` is not evidence the entry is
  // missing. Treating "unknown" as "not-served" would turn a transient tailscaled
  // blip into a failed start for a service that is running fine.
  it("does not attempt a repair when the Serve status query itself fails", async () => {
    mockHealthyFetch();
    const calls: string[][] = [];
    const runFn: RunFn = async (cmd) => {
      calls.push(cmd);
      if (cmd.includes("status") && cmd.includes("--json")) {
        return { stdout: "", exitCode: 1, stderr: "tailscaled is not running" };
      }
      return { stdout: "", exitCode: 0, stderr: "" };
    };
    const pollHealthFn: PollHealthFn = async () => true;

    const { startService, clearChildren } = await import("../src/lifecycle");
    clearChildren();
    const result = await startService(runFn, pollHealthFn, makeService(), eventsPath);

    // Adopted as already-running rather than failed on an unverifiable status.
    expect(result.ok).toBe(true);
    // No add attempted — the previous behaviour tried one and failed the start.
    expect(calls.some(c => c[0] === "tailscale" && !c.includes("status"))).toBe(false);
    const events = await readEvents(eventsPath);
    const upEvent = events.find(e => e.type === "service.up" && e.subjectId === "test-svc");
    expect(upEvent?.data).toEqual({ alreadyRunning: true });
  });

  it("returns an error if repairing the Tailscale Serve entry fails", async () => {
    mockHealthyFetch();
    const runFn: RunFn = async (cmd) => {
      if (cmd.includes("status") && cmd.includes("--json")) {
        return { stdout: JSON.stringify({ Web: {} }), exitCode: 0, stderr: "" };
      }
      if (cmd[0] === "tailscale") return { stdout: "", exitCode: 1, stderr: "etag mismatch" };
      return { stdout: "", exitCode: 0, stderr: "" };
    };
    const pollHealthFn: PollHealthFn = async () => true;

    const { startService, clearChildren } = await import("../src/lifecycle");
    clearChildren();
    const svc = makeService();
    const result = await startService(runFn, pollHealthFn, svc, eventsPath);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("etag mismatch");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Stop sequence
// ═════════════════════════════════════════════════════════════════════════════

describe("stopService", () => {
  it("tears down Tailscale Serve before stopping the process (systemd runner)", async () => {
    const order: string[] = [];
    const runFn: RunFn = async (cmd) => {
      if (cmd.includes("status")) {
        return { stdout: JSON.stringify({ Web: { "hostname:8080": {} } }), exitCode: 0, stderr: "" };
      }
      if (cmd[0] === "tailscale") order.push("tailscale");
      else order.push("stop");
      return { stdout: "", exitCode: 0, stderr: "" };
    };

    const { stopService } = await import("../src/lifecycle");
    const svc = makeService({
      runner: { type: "systemd", unit: "test-svc", unitFile: "ops/test-svc.service" },
    });
    await stopService(runFn, svc, eventsPath);

    expect(order.indexOf("tailscale")).toBeLessThan(order.indexOf("stop"));
  });

  it("stops the process even if Tailscale Serve teardown fails (systemd runner)", async () => {
    let stopped = false;
    const runFn: RunFn = async (cmd) => {
      if (cmd.includes("status")) {
        return { stdout: JSON.stringify({ Web: { "hostname:8080": {} } }), exitCode: 0, stderr: "" };
      }
      if (cmd[0] === "tailscale") return { stdout: "", exitCode: 1, stderr: "error" };
      stopped = true;
      return { stdout: "", exitCode: 0, stderr: "" };
    };

    const { stopService } = await import("../src/lifecycle");
    const svc = makeService({
      runner: { type: "systemd", unit: "test-svc", unitFile: "ops/test-svc.service" },
    });
    await stopService(runFn, svc, eventsPath);

    expect(stopped).toBe(true);
  });

  it("emits service.stopped event", async () => {
    const { stopService } = await import("../src/lifecycle");
    const svc = makeService();
    await stopService(successRunFn(), svc, eventsPath);

    const events = await readEvents(eventsPath);
    expect(events.some(e => e.type === "service.stopped" && e.subjectId === "test-svc")).toBe(true);
  });

  it("returns ok even if Tailscale Serve teardown fails", async () => {
    const runFn: RunFn = async (cmd) => {
      if (cmd.includes("status")) return { stdout: JSON.stringify({ Web: { "hostname:8080": {} } }), exitCode: 0, stderr: "" };
      if (cmd[0] === "tailscale") return { stdout: "", exitCode: 1, stderr: "error" };
      return { stdout: "", exitCode: 0, stderr: "" };
    };

    const { stopService } = await import("../src/lifecycle");
    const svc = makeService();
    const result = await stopService(runFn, svc, eventsPath);

    expect(result.ok).toBe(true);
  });

  it("emits tailscale.serve_remove_failed when teardown fails", async () => {
    const runFn: RunFn = async (cmd) => {
      if (cmd.includes("status")) return { stdout: JSON.stringify({ Web: { "hostname:8080": {} } }), exitCode: 0, stderr: "" };
      if (cmd[0] === "tailscale" && cmd.includes("off")) return { stdout: "", exitCode: 1, stderr: "error" };
      return { stdout: "", exitCode: 0, stderr: "" };
    };

    const { stopService } = await import("../src/lifecycle");
    const svc = makeService();
    await stopService(runFn, svc, eventsPath);

    const events = await readEvents(eventsPath);
    expect(events.some(e => e.type === "tailscale.serve_remove_failed")).toBe(true);
  });

  it("skips Tailscale Serve teardown when tailscaleServe is false", async () => {
    let tailscaleCalled = false;
    const runFn: RunFn = async (cmd) => {
      if (cmd[0] === "tailscale") tailscaleCalled = true;
      return { stdout: "", exitCode: 0, stderr: "" };
    };

    const { stopService } = await import("../src/lifecycle");
    const svc = makeService({ network: { port: 8080, healthPath: "/health", endpoint: "http://localhost:8080", tailscaleServe: false } });
    await stopService(runFn, svc, eventsPath);

    expect(tailscaleCalled).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Crash recovery
// ═════════════════════════════════════════════════════════════════════════════

describe("crash recovery", () => {
  it("emits service.crashed event when a process exits unexpectedly", async () => {
    const { handleProcessExit } = await import("../src/lifecycle");
    const svc = makeService({ lifecycle: { restartOnCrash: false } });
    await handleProcessExit(successRunFn(), svc, eventsPath, 1);

    const events = await readEvents(eventsPath);
    const crashEvent = events.find(e => e.type === "service.crashed");
    expect(crashEvent).toBeDefined();
    expect(crashEvent!.subjectId).toBe("test-svc");
    expect(crashEvent!.data.exitCode).toBe(1);
  });

  it("tears down Tailscale Serve on crash", async () => {
    let serveRemoved = false;
    const runFn: RunFn = async (cmd) => {
      if (cmd.includes("status")) {
        return { stdout: JSON.stringify({ Web: { "hostname:8080": {} } }), exitCode: 0, stderr: "" };
      }
      if (cmd[0] === "tailscale" && cmd.includes("off")) serveRemoved = true;
      return { stdout: "", exitCode: 0, stderr: "" };
    };

    const { handleProcessExit } = await import("../src/lifecycle");
    const svc = makeService({ lifecycle: { restartOnCrash: false } });
    await handleProcessExit(runFn, svc, eventsPath, 1);

    expect(serveRemoved).toBe(true);
  });

  it("does not restart when restartOnCrash is false", async () => {
    let startCalled = false;
    const runFn: RunFn = async (cmd) => {
      if (cmd.some(a => a.includes("server"))) startCalled = true;
      return { stdout: "", exitCode: 0, stderr: "" };
    };

    const { handleProcessExit } = await import("../src/lifecycle");
    const svc = makeService({ lifecycle: { restartOnCrash: false } });
    await handleProcessExit(runFn, svc, eventsPath, 1);

    expect(startCalled).toBe(false);
  });

  it("emits service.down when restartOnCrash is false", async () => {
    const { handleProcessExit } = await import("../src/lifecycle");
    const svc = makeService({ lifecycle: { restartOnCrash: false } });
    await handleProcessExit(successRunFn(), svc, eventsPath, 1);

    const events = await readEvents(eventsPath);
    expect(events.some(e => e.type === "service.down")).toBe(true);
  });

  it("attempts restart when restartOnCrash is true and budget remains", async () => {
    const { runFn, calls } = trackingRunFn();
    const pollHealthFn: PollHealthFn = async () => true;

    const { handleProcessExit } = await import("../src/lifecycle");
    const svc = makeService({
      lifecycle: { restartOnCrash: true, maxRestarts: 3, restartBackoff: 10 },
    });
    await handleProcessExit(runFn, svc, eventsPath, 1, { restartCount: 0, pollHealthFn });

    // Should have attempted to start the service
    const startAttempt = calls.some(c => c.some(a => a.includes("server") || a.includes("start")));
    expect(startAttempt).toBe(true);
  });

  it("emits service.down and does not restart when maxRestarts is exhausted", async () => {
    let startCalled = false;
    const runFn: RunFn = async (cmd) => {
      if (cmd.some(a => a.includes("server"))) startCalled = true;
      return { stdout: "", exitCode: 0, stderr: "" };
    };

    const { handleProcessExit } = await import("../src/lifecycle");
    const svc = makeService({
      lifecycle: { restartOnCrash: true, maxRestarts: 3, restartBackoff: 10 },
    });
    await handleProcessExit(runFn, svc, eventsPath, 1, { restartCount: 3, pollHealthFn: async () => true });

    expect(startCalled).toBe(false);
    const events = await readEvents(eventsPath);
    expect(events.some(e => e.type === "service.down")).toBe(true);
  });

  it("restart count of maxRestarts - 1 still allows one more restart", async () => {
    const { runFn, calls } = trackingRunFn();
    const pollHealthFn: PollHealthFn = async () => true;

    const { handleProcessExit } = await import("../src/lifecycle");
    const svc = makeService({
      lifecycle: { restartOnCrash: true, maxRestarts: 3, restartBackoff: 10 },
    });
    await handleProcessExit(runFn, svc, eventsPath, 1, { restartCount: 2, pollHealthFn });

    // Should still attempt restart (count 2, max 3 — one more allowed)
    const startAttempt = calls.some(c => c.some(a => a.includes("server") || a.includes("start")));
    expect(startAttempt).toBe(true);
  });

  it("does not attempt restart for exit code 0 (clean exit)", async () => {
    let startCalled = false;
    const runFn: RunFn = async (cmd) => {
      if (cmd.some(a => a.includes("server"))) startCalled = true;
      return { stdout: "", exitCode: 0, stderr: "" };
    };

    const { handleProcessExit } = await import("../src/lifecycle");
    const svc = makeService({
      lifecycle: { restartOnCrash: true, maxRestarts: 3, restartBackoff: 10 },
    });
    await handleProcessExit(runFn, svc, eventsPath, 0, { restartCount: 0, pollHealthFn: async () => true });

    expect(startCalled).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Startup time vs health timeout
// ═════════════════════════════════════════════════════════════════════════════

describe("startupTime", () => {
  it("uses startupTime as the health poll timeout during startup, not healthTimeout", async () => {
    let polledTimeout = 0;
    const pollHealthFn: PollHealthFn = async (_url, timeout) => {
      polledTimeout = timeout;
      return true;
    };

    const { startService } = await import("../src/lifecycle");
    const svc = makeService({
      network: { port: 8080, healthPath: "/health", endpoint: "http://localhost:8080", healthTimeout: 5000 },
      lifecycle: { startupTime: 120000 },
    });
    await startService(successRunFn(), pollHealthFn, svc, eventsPath);

    // startupTime (120s) should be used, not healthTimeout (5s)
    expect(polledTimeout).toBe(120000);
    expect(polledTimeout).not.toBe(5000);
  });

  it("defaults startupTime to 30000ms when not specified", async () => {
    let polledTimeout = 0;
    const pollHealthFn: PollHealthFn = async (_url, timeout) => {
      polledTimeout = timeout;
      return true;
    };

    const { startService } = await import("../src/lifecycle");
    const svc = makeService({ lifecycle: {} });
    // Remove startupTime to test default
    delete (svc as any).lifecycle.startupTime;
    await startService(successRunFn(), pollHealthFn, svc, eventsPath);

    expect(polledTimeout).toBe(30000);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Lifecycle locking
// ═════════════════════════════════════════════════════════════════════════════

describe("lifecycle locking", () => {
  it("rejects concurrent start on the same service", async () => {
    const pollHealthFn: PollHealthFn = async () => true;

    const { startServiceWithLock, acquireLock, releaseLock, isLocked } = await import("../src/lifecycle");
    const svc = makeService();

    // Simulate a lock already held (e.g. a prior start is in progress)
    acquireLock(svc.id);
    expect(isLocked(svc.id)).toBe(true);

    // A second call should be rejected
    const result = await startServiceWithLock(successRunFn(), pollHealthFn, svc, eventsPath);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("in progress");

    releaseLock(svc.id);
    expect(isLocked(svc.id)).toBe(false);
  });

  it("releases lock after successful start", async () => {
    const pollHealthFn: PollHealthFn = async () => true;

    const { startServiceWithLock, isLocked } = await import("../src/lifecycle");
    const svc = makeService();
    await startServiceWithLock(successRunFn(), pollHealthFn, svc, eventsPath);

    expect(isLocked(svc.id)).toBe(false);
  });

  it("releases lock after failed start", async () => {
    const pollHealthFn: PollHealthFn = async () => false; // health fails

    const { startServiceWithLock, isLocked } = await import("../src/lifecycle");
    const svc = makeService();
    await startServiceWithLock(successRunFn(), pollHealthFn, svc, eventsPath);

    expect(isLocked(svc.id)).toBe(false);
  });
});
