// Running short commands with a timeout, and spawning long-lived services.

import { describe, it, expect } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunFn, createSpawnFn } from "../src/exec";

describe("runFn", () => {
  it("returns stdout, stderr and the exit code, nonzero included, without throwing", async () => {
    const runFn = createRunFn();
    expect(await runFn(["sh", "-c", "echo out; echo err >&2; exit 3"])).toEqual({ stdout: "out\n", stderr: "err\n", exitCode: 3 });
  });

  it("kills a command that outlives its timeout and says it timed out", async () => {
    const result = await createRunFn({ timeoutMs: 50 })(["sleep", "30"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toLowerCase()).toContain("timed out");
  });

  it("applies the timeout it is given, so a command inside it finishes normally", async () => {
    expect((await createRunFn({ timeoutMs: 50 })(["sleep", "1"])).exitCode).not.toBe(0);
    expect((await createRunFn({ timeoutMs: 3000 })(["sleep", "1"])).exitCode).toBe(0);
  });
});

describe("spawnFn", () => {
  it("returns at once and leaves the process running, with no timeout, until killed", async () => {
    const child = createSpawnFn()(["sleep", "30"]);
    const settled = await Promise.race([
      child.exited!.then(() => "exited"),
      new Promise(r => setTimeout(() => r("running"), 200)),
    ]);
    expect(settled).toBe("running");
    child.kill();
    expect(typeof (await child.exited)).toBe("number");
  });

  it("resolves exited with the process's exit code", async () => {
    expect(await createSpawnFn()(["sh", "-c", "exit 7"]).exited).toBe(7);
  });

  it("appends each run's output to the log files", async () => {
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
