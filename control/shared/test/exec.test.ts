import { describe, it, expect } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunFn, createSpawnFn } from "../src/exec";

// runFn and spawnFn are invocation styles, not policy: one awaits a command's
// completion and returns its output, the other hands back a handle to a process
// meant to keep running. Durations reach them as resolved parameters.
//
// These were previously defined identically in both nodes' index.ts, where
// nothing could import them. Extracting them is what makes this file possible.

describe("runFn — command execution", () => {
  it("returns stdout, stderr and exit code from a command that succeeds", async () => {
    const runFn = createRunFn();

    const result = await runFn(["sh", "-c", "echo out; echo err >&2; exit 0"]);

    expect(result.stdout.trim()).toBe("out");
    expect(result.stderr.trim()).toBe("err");
    expect(result.exitCode).toBe(0);
  });

  it("reports a non-zero exit code rather than throwing", async () => {
    const runFn = createRunFn();

    const result = await runFn(["sh", "-c", "exit 3"]);

    expect(result.exitCode).toBe(3);
  });

  // Timeout tests exec the binary directly rather than through `sh -c`.
  // Killing a shell leaves its child holding the stdout pipe, so reading the
  // pipe blocks until that orphan exits on its own — the kill works, the read
  // does not return. Every command this timeout guards (tailscale, systemctl,
  // launchctl, top) is a direct exec, so this is the shape that matters.
  it("kills a command that exceeds its timeout", async () => {
    const runFn = createRunFn({ timeoutMs: 50 });

    const started = Date.now();
    const result = await runFn(["sleep", "30"]);
    const elapsed = Date.now() - started;

    expect(result.exitCode).not.toBe(0);
    expect(elapsed).toBeLessThan(5000);
  });

  it("says the command timed out, so a caller can tell it apart from a normal failure", async () => {
    const runFn = createRunFn({ timeoutMs: 50 });

    const result = await runFn(["sleep", "30"]);

    expect(result.stderr.toLowerCase()).toContain("timed out");
  });

  it("does not time out a command that finishes inside its timeout", async () => {
    const runFn = createRunFn({ timeoutMs: 5000 });

    const result = await runFn(["sh", "-c", "echo quick"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("quick");
  });

  it("applies the timeout it is given rather than a built-in constant", async () => {
    // The duration is declared configuration passed in, not a number the
    // invocation layer decides for itself.
    const fast = createRunFn({ timeoutMs: 50 });
    const slow = createRunFn({ timeoutMs: 3000 });

    const fastResult = await fast(["sleep", "1"]);
    const slowResult = await slow(["sleep", "1"]);

    expect(fastResult.exitCode).not.toBe(0);
    expect(slowResult.exitCode).toBe(0);
  });
});

describe("spawnFn — long-running processes", () => {
  it("returns a handle without waiting for the process to exit", async () => {
    const spawnFn = createSpawnFn();

    const started = Date.now();
    const child = spawnFn(["sleep", "30"]);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(1000);
    expect(typeof child.kill).toBe("function");

    child.kill();
  });

  it("resolves exited with the code once the process ends", async () => {
    const spawnFn = createSpawnFn();

    const child = spawnFn(["sh", "-c", "exit 7"]);

    expect(await child.exited).toBe(7);
  });

  it("kill terminates a running process", async () => {
    const spawnFn = createSpawnFn();

    const child = spawnFn(["sleep", "30"]);
    child.kill();

    // Resolves rather than hanging — the exact signal-derived code is not
    // asserted, since it varies by platform.
    expect(typeof (await child.exited)).toBe("number");
  });

  it("is not bounded by a command timeout — a long-lived service keeps running", async () => {
    // A process runner's service runs indefinitely by design. Bounding it
    // would break crash detection, which watches exited.
    const spawnFn = createSpawnFn();

    const child = spawnFn(["sleep", "2"]);
    const settled = await Promise.race([
      child.exited.then(() => "exited"),
      new Promise(r => setTimeout(() => r("still-running"), 200)),
    ]);

    expect(settled).toBe("still-running");

    child.kill();
  });

  it("appends each run's output to the log files rather than writing over the last run's", async () => {
    // A restarted service writes into the same logDir. Opened without append,
    // the new run overwrote from offset 0 and left the old run's tail behind
    // its own lines, cut mid-line.
    const logDir = await mkdtemp(join(tmpdir(), "spawn-log-"));
    try {
      const spawnFn = createSpawnFn();
      await spawnFn(["sh", "-c", "echo first run, a long line; echo first err >&2"], { logDir }).exited;
      await spawnFn(["sh", "-c", "echo second; echo second err >&2"], { logDir }).exited;

      expect(await readFile(join(logDir, "stdout.log"), "utf8")).toBe("first run, a long line\nsecond\n");
      expect(await readFile(join(logDir, "stderr.log"), "utf8")).toBe("first err\nsecond err\n");
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });
});
