import { appendEvent } from "./events";
import { addTailscaleServe, removeTailscaleServe, queryPortServed } from "./tailscale";
import type { RunFn, PollHealthFn, SpawnFn } from "./tailscale";
import type { Service, ServiceRunner } from "../../../shared/types";

export type { RunFn, PollHealthFn, SpawnFn };

// ── Lifecycle locking ────────────────────────────────────────────────────────

const locks = new Set<string>();

export function acquireLock(svcId: string): void {
  locks.add(svcId);
}

export function releaseLock(svcId: string): void {
  locks.delete(svcId);
}

export function isLocked(svcId: string): boolean {
  return locks.has(svcId);
}

export function clearLocks(): void {
  locks.clear();
}

// ── Process child registry ──────────────────────────────────────────────────
// Tracks spawned process-runner children so stopService can kill them.

const children = new Map<string, { kill: () => void }>();

export function getChild(svcId: string): { kill: () => void } | undefined {
  return children.get(svcId);
}

export function clearChildren(): void {
  children.clear();
}

// ── Command derivation ───────────────────────────────────────────────────────

function getRunner(svc: Service): ServiceRunner {
  return svc.runner ?? { type: "external" };
}

export function deriveStartCmd(svc: Service): string[] | null {
  const r = getRunner(svc);
  switch (r.type) {
    case "process": return r.main.split(" ");
    case "systemd": return ["systemctl", "--user", "start", `${r.unit}.service`];
    case "launchd": return ["launchctl", "bootstrap", `gui/${process.getuid?.() ?? 501}`, `${process.env.HOME}/Library/LaunchAgents/${r.label}.plist`];
    case "external": return null;
    case "managed": return r.startCmd;
  }
}

export function deriveStopCmd(svc: Service): string[] | null {
  const r = getRunner(svc);
  switch (r.type) {
    case "process": return null; // process runner kills the child reference directly
    case "systemd": return ["systemctl", "--user", "stop", `${r.unit}.service`];
    case "launchd": return ["launchctl", "bootout", `gui/${process.getuid?.() ?? 501}`, `${process.env.HOME}/Library/LaunchAgents/${r.label}.plist`];
    case "external": return null;
    case "managed": return r.stopCmd;
  }
}

export function deriveRestartCmd(svc: Service): string[] | null {
  const r = getRunner(svc);
  switch (r.type) {
    case "process": return null; // process runner: stop then start
    case "systemd": return ["systemctl", "--user", "restart", `${r.unit}.service`];
    case "launchd": return null; // launchd: bootout + bootstrap
    case "external": return null;
    case "managed": return null; // managed: stop then start, like process
  }
}

export function deriveEnableCmd(svc: Service): string[] | null {
  const r = getRunner(svc);
  switch (r.type) {
    case "process": return null;
    case "systemd": return ["systemctl", "--user", "enable", "--now", `${r.unit}.service`];
    case "launchd": return ["launchctl", "bootstrap", `gui/${process.getuid?.() ?? 501}`, `${process.env.HOME}/Library/LaunchAgents/${r.label}.plist`];
    case "external": return null;
    case "managed": return null; // no enable/disable concept for a self-managed daemon
  }
}

export function deriveDisableCmd(svc: Service): string[] | null {
  const r = getRunner(svc);
  switch (r.type) {
    case "process": return null;
    case "systemd": return ["systemctl", "--user", "disable", "--now", `${r.unit}.service`];
    case "launchd": return ["launchctl", "bootout", `gui/${process.getuid?.() ?? 501}`, `${process.env.HOME}/Library/LaunchAgents/${r.label}.plist`];
    case "external": return null;
    case "managed": return null;
  }
}

// ── Per-service lifecycle ────────────────────────────────────────────────────

const DEFAULT_STARTUP_TIME = 30000;
const ALREADY_RUNNING_PROBE_MS = 3000;
// Grace period for healthCmd to report unhealthy after a managed runner's stop
// command exits successfully — the daemon may take a moment to actually exit.
// Confirmed live against Paseo: a graceful stop reports unhealthy within ~1s.
const MANAGED_STOP_CONFIRM_MS = 5000;

export async function startService(
  runFn: RunFn,
  pollHealthFn: PollHealthFn,
  svc: Service,
  eventsPath: string,
  spawnFn?: SpawnFn
): Promise<{ ok: boolean; error?: string }> {
  const runner = getRunner(svc);
  if (runner.type === "external") {
    return { ok: false, error: "external services cannot be started by the platform" };
  }

  // Fast path (process runner only): if the service is already healthy, skip the
  // start (or repair-only when Tailscale Serve is missing — see below).
  // systemd/launchd start commands are already idempotent — no need to probe first.
  // Uses a direct fetch (not pollHealthFn) so test mocks don't short-circuit the real start.
  if (runner.type === "process") {
    try {
      const probeUrl = `http://localhost:${svc.network.port}${svc.network.healthPath}`;
      const probe = await fetch(probeUrl, { signal: AbortSignal.timeout(ALREADY_RUNNING_PROBE_MS) });
      // "Healthy locally" alone isn't proof the service is fully up: a process can
      // end up running without going through startService (killed and manually
      // restarted outside the platform), leaving its Serve registration stale or
      // missing. Repair that here instead of trusting the fast path blindly.
      //
      // Only "not-served" justifies a repair. A failed status query ("unknown" —
      // tailscaled down, unparseable output) is not evidence the entry is missing:
      // treating it as missing would turn a transient blip into a failed start for
      // a service that is running fine.
      const port = svc.network.port;
      const serveState = probe.ok && svc.network.tailscaleServe && port != null
        ? await queryPortServed(runFn, port)
        : "served";
      const needsServe = serveState === "not-served";

      // If Serve needs repair and we hold a child reference, fall through to the
      // full sequence below — it cleanly stops and restarts with Serve torn down
      // and re-registered in the correct order.
      if (probe.ok && (!needsServe || !children.has(svc.id))) {
        if (needsServe) {
          // No child reference means there's no safe way to restart a process
          // runner (stopping one means killing its tracked child) — re-spawning
          // here would collide on the port with the still-running process.
          // Just repair the Serve registration and adopt the existing process.
          // port is non-null here: needsServe is only ever true when the
          // port != null check above passed. Narrowed explicitly so this reads
          // without a non-null assertion.
          if (port == null) return { ok: false, error: "tailscaleServe is set but network.port is missing" };
          const addResult = await addTailscaleServe(runFn, port);
          if (!addResult.ok) {
            await appendEvent(eventsPath, {
              type: "tailscale.serve_failed",
              subjectType: "service",
              subjectId: svc.id,
              data: { action: "add", port, error: addResult.error },
              actor: "system",
            });
            return { ok: false, error: `tailscale serve failed: ${addResult.error}` };
          }
        }
        // serveRepaired distinguishes "adopted a healthy already-running service"
        // from "found its Serve entry missing and silently fixed it" — without it
        // a recurring registration failure leaves no trace in the event log.
        await appendEvent(eventsPath, {
          type: "service.up",
          subjectType: "service",
          subjectId: svc.id,
          data: needsServe ? { alreadyRunning: true, serveRepaired: true } : { alreadyRunning: true },
          actor: "system",
        });
        return { ok: true };
      }
    } catch {
      // Not healthy — proceed with full start sequence
    }
  }

  // Step 0: Kill any existing child we hold, and run stop command (idempotent)
  const existingChild = children.get(svc.id);
  if (existingChild) {
    existingChild.kill();
    children.delete(svc.id);
  }
  await runStopCmd(runFn, svc);

  // Step 1: Remove any stale Tailscale Serve entry
  if (svc.network.tailscaleServe && svc.network.port) {
    await removeTailscaleServe(runFn, svc.network.port);
  }

  // Step 2: Start the process
  const startCmd = deriveStartCmd(svc);
  if (!startCmd) {
    return { ok: false, error: `no start command for runner type '${runner.type}'` };
  }

  if (runner.type === "process" && spawnFn) {
    // Process runner: spawn and detach — the server runs indefinitely
    const spawnOpts: { cwd?: string; env?: Record<string, string>; logDir?: string } = {};
    if (svc.ops?.env?.workingDirectory) {
      spawnOpts.cwd = svc.ops.env.workingDirectory;
      spawnOpts.logDir = `${svc.ops.env.workingDirectory}/logs`;
    }
    if (svc.ops?.env?.variables) spawnOpts.env = svc.ops.env.variables;
    const child = spawnFn(startCmd, spawnOpts);
    children.set(svc.id, child);
  } else {
    // systemd/launchd: runFn completes quickly (systemctl start returns immediately)
    const startResult = await runFn(startCmd);
    if (startResult.exitCode !== 0) {
      return { ok: false, error: startResult.stderr || `start failed with exit code ${startResult.exitCode}` };
    }
  }

  // Step 3: Poll health using startupTime as the grace period.
  // Managed runners have no HTTP surface — health comes from healthCmd's exit code, not a URL.
  const startupTime = svc.lifecycle?.startupTime ?? DEFAULT_STARTUP_TIME;
  const healthy = runner.type === "managed"
    ? await pollManagedHealth(runFn, runner.healthCmd, startupTime)
    : await pollHealthFn(
        `http://localhost:${svc.network.port}${svc.network.healthPath}`,
        startupTime
      );
  if (!healthy) {
    // Kill the child if we spawned one
    const child = children.get(svc.id);
    if (child) {
      child.kill();
      children.delete(svc.id);
    }
    await runStopCmd(runFn, svc);
    return { ok: false, error: `startup health poll timed out after ${startupTime}ms` };
  }

  // Step 4: Register with Tailscale Serve
  if (svc.network.tailscaleServe && svc.network.port) {
    const addResult = await addTailscaleServe(runFn, svc.network.port);
    if (!addResult.ok) {
      await appendEvent(eventsPath, {
        type: "tailscale.serve_failed",
        subjectType: "service",
        subjectId: svc.id,
        data: { action: "add", port: svc.network.port, error: addResult.error },
        actor: "system",
      });
      const child = children.get(svc.id);
      if (child) {
        child.kill();
        children.delete(svc.id);
      }
      await runStopCmd(runFn, svc);
      return { ok: false, error: `tailscale serve failed: ${addResult.error}` };
    }
  }

  // Step 5: Emit service.up
  await appendEvent(eventsPath, {
    type: "service.up",
    subjectType: "service",
    subjectId: svc.id,
    data: {},
    actor: "system",
  });

  return { ok: true };
}

export async function stopService(
  runFn: RunFn,
  svc: Service,
  eventsPath: string
): Promise<{ ok: boolean; error?: string }> {
  const runner = getRunner(svc);
  if (runner.type === "external") {
    return { ok: false, error: "external services cannot be stopped by the platform" };
  }

  // Step 1: Remove Tailscale Serve entry (best effort)
  if (svc.network.tailscaleServe && svc.network.port) {
    const removeResult = await removeTailscaleServe(runFn, svc.network.port);
    if (!removeResult.ok) {
      await appendEvent(eventsPath, {
        type: "tailscale.serve_remove_failed",
        subjectType: "service",
        subjectId: svc.id,
        data: { error: removeResult.error },
        actor: "system",
      });
    }
  }

  // Step 2: Kill held child (process runner), then run stop command
  const child = children.get(svc.id);
  if (child) {
    child.kill();
    children.delete(svc.id);
  }

  // Managed runners delegate to their own stop command — unlike systemd/launchd
  // (best-effort via runStopCmd), a failure here must be reported, since there is
  // no other mechanism to confirm the daemon actually stopped. The stop command
  // exiting 0 only means the command succeeded, not that the daemon is actually
  // down — confirm via healthCmd, since a tool's own stop command isn't
  // necessarily trustworthy on its own (the reason healthCmd exists as a
  // separate concept in the first place).
  if (runner.type === "managed") {
    const stopResult = await runFn(runner.stopCmd);
    if (stopResult.exitCode !== 0) {
      return { ok: false, error: stopResult.stderr || `stop failed with exit code ${stopResult.exitCode}` };
    }
    const confirmedDown = await pollManagedUnhealthy(runFn, runner.healthCmd, MANAGED_STOP_CONFIRM_MS);
    if (!confirmedDown) {
      return { ok: false, error: "stop command succeeded but healthCmd still reports healthy" };
    }
  } else {
    await runStopCmd(runFn, svc);
  }

  // Step 3: Emit service.stopped
  await appendEvent(eventsPath, {
    type: "service.stopped",
    subjectType: "service",
    subjectId: svc.id,
    data: {},
    actor: "system",
  });

  return { ok: true };
}

export async function restartService(
  runFn: RunFn,
  pollHealthFn: PollHealthFn,
  svc: Service,
  eventsPath: string,
  spawnFn?: SpawnFn
): Promise<{ ok: boolean; error?: string }> {
  const runner = getRunner(svc);
  if (runner.type === "external") {
    return { ok: false, error: "external services cannot be restarted by the platform" };
  }

  const restartCmd = deriveRestartCmd(svc);
  if (restartCmd) {
    // systemd/launchd: use native restart command
    const result = await runFn(restartCmd);
    if (result.exitCode !== 0) {
      return { ok: false, error: result.stderr || `restart failed` };
    }
    await appendEvent(eventsPath, {
      type: "service.restarted",
      subjectType: "service",
      subjectId: svc.id,
      data: {},
      actor: "system",
    });
    return { ok: true };
  }

  // process runner: stop then start
  await stopService(runFn, svc, eventsPath);
  return startService(runFn, pollHealthFn, svc, eventsPath, spawnFn);
}

export async function enableService(
  runFn: RunFn,
  svc: Service,
  eventsPath: string
): Promise<{ ok: boolean; error?: string }> {
  const cmd = deriveEnableCmd(svc);
  if (!cmd) {
    return { ok: false, error: `no enable command for runner type '${getRunner(svc).type}'` };
  }
  const result = await runFn(cmd);
  if (result.exitCode !== 0) {
    return { ok: false, error: result.stderr || `enable failed` };
  }
  await appendEvent(eventsPath, {
    type: "service.enabled",
    subjectType: "service",
    subjectId: svc.id,
    data: {},
    actor: "system",
  });
  return { ok: true };
}

export async function disableService(
  runFn: RunFn,
  svc: Service,
  eventsPath: string
): Promise<{ ok: boolean; error?: string }> {
  const cmd = deriveDisableCmd(svc);
  if (!cmd) {
    return { ok: false, error: `no disable command for runner type '${getRunner(svc).type}'` };
  }
  const result = await runFn(cmd);
  if (result.exitCode !== 0) {
    return { ok: false, error: result.stderr || `disable failed` };
  }
  await appendEvent(eventsPath, {
    type: "service.disabled",
    subjectType: "service",
    subjectId: svc.id,
    data: {},
    actor: "system",
  });
  return { ok: true };
}

// ── Crash recovery ───────────────────────────────────────────────────────────

interface HandleExitOpts {
  restartCount: number;
  pollHealthFn: PollHealthFn;
  spawnFn?: SpawnFn;
}

export async function handleProcessExit(
  runFn: RunFn,
  svc: Service,
  eventsPath: string,
  exitCode: number,
  opts?: HandleExitOpts
): Promise<void> {
  // Clean exit — no recovery needed
  if (exitCode === 0) return;

  // Teardown Tailscale Serve since the process is gone
  if (svc.network.tailscaleServe && svc.network.port) {
    await removeTailscaleServe(runFn, svc.network.port);
  }

  // Emit crash event
  await appendEvent(eventsPath, {
    type: "service.crashed",
    subjectType: "service",
    subjectId: svc.id,
    data: { exitCode },
    actor: "system",
  });

  const restartOnCrash = svc.lifecycle?.restartOnCrash ?? false;
  if (!restartOnCrash || !opts) {
    await appendEvent(eventsPath, {
      type: "service.down",
      subjectType: "service",
      subjectId: svc.id,
      data: { reason: "crashed", exitCode },
      actor: "system",
    });
    return;
  }

  const maxRestarts = svc.lifecycle?.maxRestarts ?? 3;
  const restartBackoff = svc.lifecycle?.restartBackoff ?? 5000;

  if (opts.restartCount >= maxRestarts) {
    await appendEvent(eventsPath, {
      type: "service.down",
      subjectType: "service",
      subjectId: svc.id,
      data: { reason: "max_restarts_exceeded", restartCount: opts.restartCount },
      actor: "system",
    });
    return;
  }

  // Wait backoff then attempt restart
  await new Promise(r => setTimeout(r, restartBackoff));
  await startService(runFn, opts.pollHealthFn, svc, eventsPath, opts.spawnFn);
}

// ── WithLock variants ────────────────────────────────────────────────────────

export async function startServiceWithLock(
  runFn: RunFn,
  pollHealthFn: PollHealthFn,
  svc: Service,
  eventsPath: string,
  spawnFn?: SpawnFn
): Promise<{ ok: boolean; error?: string }> {
  if (isLocked(svc.id)) {
    return { ok: false, error: "lifecycle operation in progress" };
  }
  acquireLock(svc.id);
  try {
    return await startService(runFn, pollHealthFn, svc, eventsPath, spawnFn);
  } finally {
    releaseLock(svc.id);
  }
}

export async function stopServiceWithLock(
  runFn: RunFn,
  svc: Service,
  eventsPath: string
): Promise<{ ok: boolean; error?: string }> {
  if (isLocked(svc.id)) {
    return { ok: false, error: "lifecycle operation in progress" };
  }
  acquireLock(svc.id);
  try {
    return await stopService(runFn, svc, eventsPath);
  } finally {
    releaseLock(svc.id);
  }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

async function runStopCmd(runFn: RunFn, svc: Service): Promise<void> {
  const cmd = deriveStopCmd(svc);
  if (cmd) {
    await runFn(cmd);
  }
  // process runner: no command — caller holds the child reference and kills it directly
}

// Managed runners have no HTTP health surface — poll healthCmd's exit code instead,
// on the same deadline/retry cadence the HTTP pollHealthFn implementations use.
async function pollManagedHealth(runFn: RunFn, healthCmd: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await runFn(["sh", "-c", healthCmd]);
    if (result.exitCode === 0) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

// Post-stop confirmation: poll healthCmd until it reports UNHEALTHY (inverse of
// pollManagedHealth). Returns true once confirmed down, false if it never goes
// unhealthy within timeoutMs — i.e. the stop command lied about succeeding.
// intervalMs is a parameter (not a hardcoded 1000ms like pollManagedHealth) so
// tests can exhaust the "never goes unhealthy" case quickly.
async function pollManagedUnhealthy(runFn: RunFn, healthCmd: string, timeoutMs: number, intervalMs = 1000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await runFn(["sh", "-c", healthCmd]);
    if (result.exitCode !== 0) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

// ── Legacy aliases (used by shard until fully migrated) ─────────────────────

export const loadService = startService;
export const unloadService = stopService;
