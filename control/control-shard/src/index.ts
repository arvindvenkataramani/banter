import { join } from "node:path";
import { homedir } from "node:os";
import { resolveShardPaths } from "./paths";
import { loadRegistry } from "../../shared/src/registry";
import { serveStatic } from "../../shared/src/static";
import { createApp } from "../../shared/src/api";
import { checkService, startHealthLoop } from "../../shared/src/health";
import { stopService } from "../../shared/src/lifecycle";
import { getFreeMem, checkMemoryBudget } from "./memory";
import { startService, shardStartup, shardShutdown } from "./lifecycle";
import { startIdleLoop } from "./idle";
import { createShardApp } from "./shard-api";
import type { RunFn, PollHealthFn, SpawnFn } from "../../shared/src/tailscale";
import type { Service } from "../../../shared/types";

// Paths and intervals resolve in ./paths.ts, which takes the environment and
// home directory as arguments so the answer can be tested without starting a
// server. An unusable numeric override throws from here rather than reaching
// Bun.serve as NaN.
const paths = resolveShardPaths(process.env, homedir());

const REGISTRY_PATH = paths.registryPath;
const EVENTS_PATH = paths.eventsPath;
const DIST = process.env.DASHBOARD_DIST ?? join(import.meta.dir, "../../../dashboard/dist");
const PORT = paths.port;
// See BANTER_CONTROL_HOST in the control plane — loopback, fronted by Tailscale Serve.
const HOST = process.env.BANTER_SHARD_HOST ?? "localhost";
const HEALTH_INTERVAL_MS = paths.healthIntervalMs;
const IDLE_INTERVAL_MS = paths.idleIntervalMs;

// Real RunFn — runs a command via Bun.spawn, returns stdout/stderr/exitCode
const runFn: RunFn = async (cmd) => {
  const proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe", env: process.env });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
};

// Real PollHealthFn — polls the health endpoint every 1s until healthy or timeout
const pollHealthFn: PollHealthFn = async (url, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
};

// Real SpawnFn — spawns a long-running process and returns a kill handle
const spawnFn: SpawnFn = (cmd, opts) => {
  const env = { ...process.env, ...opts?.env };
  if (opts?.logDir) {
    const proc = Bun.spawn({
      cmd,
      cwd: opts.cwd,
      env,
      stdout: Bun.file(`${opts.logDir}/stdout.log`),
      stderr: Bun.file(`${opts.logDir}/stderr.log`),
    });
    return { kill: () => proc.kill() };
  }
  const proc = Bun.spawn({ cmd, cwd: opts?.cwd, env, stdout: "ignore", stderr: "ignore" });
  return { kill: () => proc.kill() };
};

// Ping map for idle eviction
const pingMap = new Map<string, number>();

// ── Startup ────────────────────────────────────────────────────────────────────

console.log("ControlShard starting...");

// Step 1: Load registry
const registry = await loadRegistry(REGISTRY_PATH);
console.log(`Loaded registry: ${registry.services.length} services`);

// Step 2: Wire shared API (standard endpoints: /api/services, /api/events, etc.)
// localHostId is resolved after registry load (Step 1) — hoisted here via let
const localHost = registry.hosts.find(h => h.role === "worker");
const localHostId = localHost?.id;
const sharedApp = createApp({
  registryState: registry,
  registryPath: REGISTRY_PATH,
  eventsPath: EVENTS_PATH,
  checkService: (svc, eventsPath, opts) => checkService(svc, eventsPath, { ...opts, localHostId }),
  runFn,
  pollHealthFn,
  spawnFn,
  localHostId,
});

// Step 3: Wire shard-specific API (/status, /ping, /load, /unload)
const shardApp = createShardApp({
  registryState: registry,
  eventsPath: EVENTS_PATH,
  getFreeMem: () => getFreeMem(runFn),
  checkMemoryBudget: async () => {
    const freeMem = await getFreeMem(runFn);
    return checkMemoryBudget(runFn, freeMem, 0, new Map(), EVENTS_PATH);
  },
  loadService: (svc: Service) => startService(runFn, pollHealthFn, svc, EVENTS_PATH, spawnFn),
  unloadService: (svc: Service) => stopService(runFn, svc, EVENTS_PATH),
});

// Step 4: Merge apps and start HTTP server
const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  fetch: (req) => {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/") || url.pathname === "/status" || url.pathname.startsWith("/ping/")) {
      // Shard-specific routes take precedence for /status, /ping, and /api/services/*/start|stop
      if (
        url.pathname === "/status" ||
        url.pathname.startsWith("/ping/") ||
        (url.pathname.startsWith("/api/services/") && (url.pathname.endsWith("/start") || url.pathname.endsWith("/stop")))
      ) {
        return shardApp.fetch(req);
      }
      return sharedApp.fetch(req);
    }
    return serveStatic(DIST, req);
  },
});
console.log(`ControlShard running on :${PORT}`);

// Step 5: Start health loop
const { stop: stopHealth } = startHealthLoop(registry, EVENTS_PATH, HEALTH_INTERVAL_MS, { onlyLoaded: true, localHostId, runFn });

// Step 6: Start idle loop — evicts idle services
const { stop: stopIdle } = startIdleLoop(
  registry.services,
  pingMap,
  async (svc) => {
    await stopService(runFn, svc, EVENTS_PATH);
    svc.state = { ...svc.state, loadTime: undefined };
  },
  EVENTS_PATH,
  IDLE_INTERVAL_MS
);

// Step 7: Auto-start services
await shardStartup({
  registryState: registry,
  eventsPath: EVENTS_PATH,
  runFn,
  pollHealthFn,
  spawnFn,
});

// ── Shutdown ───────────────────────────────────────────────────────────────────

const shutdownDeps = {
  registryState: registry,
  eventsPath: EVENTS_PATH,
  runFn,
  stopHealth,
  stopIdle,
  stopServer: () => server.stop(),
};

process.on("SIGTERM", () => shardShutdown(shutdownDeps));
process.on("SIGINT", () => shardShutdown(shutdownDeps));
