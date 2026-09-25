import { closeSync, openSync } from "node:fs";
import type { PollHealthFn } from "./tailscale";

export type RunResult = { stdout: string; stderr: string; exitCode: number };
export type RunFn = (cmd: string[]) => Promise<RunResult>;

export type SpawnOpts = { cwd?: string; env?: Record<string, string>; logDir?: string };
export type SpawnHandle = { kill: () => void; exited: Promise<number> };
export type SpawnFn = (cmd: string[], opts?: SpawnOpts) => SpawnHandle;

// Runs a command via Bun.spawn, returns stdout/stderr/exitCode. With
// timeoutMs set, a command still running at the deadline is killed and
// reported as a failed command rather than left to block its caller's lane
// indefinitely.
export function createRunFn(opts?: { timeoutMs?: number }): RunFn {
  return async (cmd) => {
    const proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe", env: process.env });

    if (opts?.timeoutMs === undefined) {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout, stderr, exitCode };
    }

    const timeoutMs = opts.timeoutMs;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);

    if (timedOut) {
      const message = `command timed out after ${timeoutMs}ms`;
      return { stdout, stderr: [stderr, message].filter(Boolean).join("\n"), exitCode: exitCode || 1 };
    }
    return { stdout, stderr, exitCode };
  };
}

// Polls a health endpoint every second until it answers or the timeout
// elapses.
export function createPollHealthFn(): PollHealthFn {
  return async (url, timeoutMs, opts) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (res.ok || opts?.acceptsAnyResponse) return true;
      } catch {
        // not ready yet
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    return false;
  };
}

// Spawns a long-running process and returns a kill handle. When logDir is
// set, stdout/stderr stream to log files; install scripts pre-create the
// directory. Never bounded by a timeout — a process runner's service is
// long-lived by design, and crash detection watches exited.
export function createSpawnFn(): SpawnFn {
  return (cmd, opts) => {
    const env = { ...process.env, ...opts?.env };
    if (opts?.logDir) {
      // Opened for append: a restart writes into the same files, and a
      // Bun.file target is opened without it, so each run overwrote the last
      // from offset 0.
      const stdout = openSync(`${opts.logDir}/stdout.log`, "a");
      const stderr = openSync(`${opts.logDir}/stderr.log`, "a");
      try {
        const proc = Bun.spawn({ cmd, cwd: opts.cwd, env, stdout, stderr });
        return { kill: () => proc.kill(), exited: proc.exited };
      } finally {
        // The child holds its own copies.
        closeSync(stdout);
        closeSync(stderr);
      }
    }
    const proc = Bun.spawn({ cmd, cwd: opts?.cwd, env, stdout: "ignore", stderr: "ignore" });
    return { kill: () => proc.kill(), exited: proc.exited };
  };
}
