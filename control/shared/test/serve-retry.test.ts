import { describe, it, expect } from "bun:test";
import { addTailscaleServe, removeTailscaleServe } from "../src/tailscale";

// Tailscale Serve writes the node's whole config behind an etag, so a write
// that loses a race fails with "Preconditions failed: etag mismatch". The
// executor serializes the platform's own writers; retry covers writers outside
// the process — an operator at a terminal, a client update.
//
// Attempt count and delay are parameters, not constants: they are declared
// configuration resolved from the registry, and the invocation layer applies
// what it is given. Tests pass a 1ms delay so the suite does not pay real
// backoff time.

const RETRY = { attempts: 3, delayMs: 1 };

type RunFn = (cmd: string[]) => Promise<{ stdout: string; exitCode: number; stderr: string }>;

const ETAG_ERROR =
  "Another client is changing the serve config; please try again.\netag mismatch\n";

function isStatus(cmd: string[]): boolean {
  return cmd.includes("status") && cmd.includes("--json");
}

function isOff(cmd: string[]): boolean {
  return cmd.includes("off");
}

function servedStatus(port: number): string {
  return JSON.stringify({ Web: { [`test-host:${port}`]: {} } });
}

function unservedStatus(): string {
  return JSON.stringify({ Web: {} });
}

/** A runFn whose serve *writes* fail the first `failures` times, then succeed.
 *  Status probes always report the port as served, so a write that succeeds
 *  passes addTailscaleServe's verification. */
function flakyAddRunFn(failures: number, port = 8080) {
  let writeAttempts = 0;
  const runFn: RunFn = async (cmd) => {
    if (isStatus(cmd)) {
      return { stdout: servedStatus(port), exitCode: 0, stderr: "" };
    }
    writeAttempts++;
    if (writeAttempts <= failures) {
      return { stdout: "", exitCode: 1, stderr: ETAG_ERROR };
    }
    return { stdout: "", exitCode: 0, stderr: "" };
  };
  return { runFn, attempts: () => writeAttempts };
}

// ═════════════════════════════════════════════════════════════════════════════

describe("addTailscaleServe — retry", () => {
  it("a serve write failing with an etag mismatch is retried and succeeds without operator action", async () => {
    const { runFn, attempts } = flakyAddRunFn(1);

    const result = await addTailscaleServe(runFn, 8080, RETRY);

    expect(result.ok).toBe(true);
    expect(attempts()).toBe(2);
  });

  it("succeeds on the third attempt when the first two lose the race", async () => {
    const { runFn, attempts } = flakyAddRunFn(2);

    const result = await addTailscaleServe(runFn, 8080, RETRY);

    expect(result.ok).toBe(true);
    expect(attempts()).toBe(3);
  });

  it("gives up after three attempts", async () => {
    const { runFn, attempts } = flakyAddRunFn(99);

    const result = await addTailscaleServe(runFn, 8080, RETRY);

    expect(result.ok).toBe(false);
    expect(attempts()).toBe(3);
  });

  it("does not retry a write that succeeds first time", async () => {
    const { runFn, attempts } = flakyAddRunFn(0);

    const result = await addTailscaleServe(runFn, 8080, RETRY);

    expect(result.ok).toBe(true);
    expect(attempts()).toBe(1);
  });

  it("honours an attempts value other than three", async () => {
    // Pins the count as a parameter rather than a constant: an implementation
    // hardcoding 3 passes every other test in this file and fails this one.
    const { runFn, attempts } = flakyAddRunFn(99);

    const result = await addTailscaleServe(runFn, 8080, { attempts: 2, delayMs: 1 });

    expect(result.ok).toBe(false);
    expect(attempts()).toBe(2);
  });

  it("makes a single attempt when attempts is one", async () => {
    const { runFn, attempts } = flakyAddRunFn(99);

    await addTailscaleServe(runFn, 8080, { attempts: 1, delayMs: 1 });

    expect(attempts()).toBe(1);
  });

  it("retries a write that exits zero but fails its verification probe", async () => {
    // Exit 0 with the entry absent is the same lost race, not a different
    // failure — the config was replaced between write and read.
    let writeAttempts = 0;
    const runFn: RunFn = async (cmd) => {
      if (isStatus(cmd)) {
        // Absent on the first check, present once the second write lands.
        return {
          stdout: writeAttempts >= 2 ? servedStatus(8080) : unservedStatus(),
          exitCode: 0,
          stderr: "",
        };
      }
      writeAttempts++;
      return { stdout: "", exitCode: 0, stderr: "" };
    };

    const result = await addTailscaleServe(runFn, 8080, RETRY);

    expect(result.ok).toBe(true);
    expect(writeAttempts).toBe(2);
  });

  it("reports all distinct errors when attempts fail differently", async () => {
    // Two etag mismatches means contention; an etag mismatch then "tailscaled
    // not running" means the first failure was incidental. Collapsing them
    // loses the distinction that says which.
    let writeAttempts = 0;
    const runFn: RunFn = async (cmd) => {
      if (isStatus(cmd)) return { stdout: unservedStatus(), exitCode: 0, stderr: "" };
      writeAttempts++;
      return {
        stdout: "",
        exitCode: 1,
        stderr: writeAttempts === 1 ? ETAG_ERROR : "tailscaled not running\n",
      };
    };

    const result = await addTailscaleServe(runFn, 8080, RETRY);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("etag mismatch");
    expect(result.error).toContain("tailscaled not running");
  });

  it("reports a single error when every attempt fails identically", async () => {
    const { runFn, attempts } = flakyAddRunFn(99);

    const result = await addTailscaleServe(runFn, 8080, RETRY);

    expect(result.ok).toBe(false);
    // Three attempts were made — without this the single-message assertion
    // below passes vacuously against an implementation that never retried.
    expect(attempts()).toBe(3);
    // One message, not the same text repeated once per attempt.
    expect(result.error!.match(/etag mismatch/g)!.length).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe("removeTailscaleServe — retry", () => {
  it("retries a removal that loses the etag race", async () => {
    // A removal writes the same config behind the same etag, so it can lose
    // the same race. A stale entry that fails to clear causes trouble later.
    let writeAttempts = 0;
    const runFn: RunFn = async (cmd) => {
      if (isStatus(cmd)) return { stdout: servedStatus(8080), exitCode: 0, stderr: "" };
      if (isOff(cmd)) {
        writeAttempts++;
        if (writeAttempts === 1) {
          return { stdout: "", exitCode: 1, stderr: ETAG_ERROR };
        }
      }
      return { stdout: "", exitCode: 0, stderr: "" };
    };

    const result = await removeTailscaleServe(runFn, 8080, RETRY);

    expect(result.ok).toBe(true);
    expect(writeAttempts).toBe(2);
  });

  it("gives up after three removal attempts", async () => {
    let writeAttempts = 0;
    const runFn: RunFn = async (cmd) => {
      if (isStatus(cmd)) return { stdout: servedStatus(8080), exitCode: 0, stderr: "" };
      if (isOff(cmd)) {
        writeAttempts++;
        return { stdout: "", exitCode: 1, stderr: ETAG_ERROR };
      }
      return { stdout: "", exitCode: 0, stderr: "" };
    };

    const result = await removeTailscaleServe(runFn, 8080, RETRY);

    expect(result.ok).toBe(false);
    expect(writeAttempts).toBe(3);
  });

  it("does not attempt a removal when the port is not served", async () => {
    let writeAttempts = 0;
    let statusChecks = 0;
    const runFn: RunFn = async (cmd) => {
      if (isStatus(cmd)) {
        statusChecks++;
        return { stdout: unservedStatus(), exitCode: 0, stderr: "" };
      }
      writeAttempts++;
      return { stdout: "", exitCode: 0, stderr: "" };
    };

    const result = await removeTailscaleServe(runFn, 8080, RETRY);

    expect(result.ok).toBe(true);
    expect(writeAttempts).toBe(0);
    // An absent entry is not a lost race: the early exit must not burn
    // retries re-checking a port that was never served.
    expect(statusChecks).toBe(1);
  });
});
