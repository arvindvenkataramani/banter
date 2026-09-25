import { homedir } from "node:os";
import { resolveShardPaths } from "./paths";
import { loadRegistry } from "../../shared/src/registry";
import { createApp } from "../../shared/src/api";
import { checkService, startHealthLoop } from "../../shared/src/health";
import { startService, stopService, startDeadlineMs, stopDeadlineMs } from "../../shared/src/lifecycle";
import type { StartResult } from "../../shared/src/lifecycle";
import { appendEvent } from "../../shared/src/events";
import { submit } from "../../shared/src/executor";
import { getFreeMem, checkMemoryBudget } from "./memory";
import { shardStartup, shardShutdown } from "./lifecycle";
import { startIdleLoop } from "./idle";
import { createShardApp } from "./shard-api";
import { isPlatformPath, routesToShardApp } from "./routing";
import { createRunFn, createSpawnFn, createPollHealthFn } from "../../shared/src/exec";
import type { Service } from "../../../shared/types";

// Paths and intervals resolve in ./paths.ts, which takes the environment and
// home directory as arguments so the answer can be tested without starting a
// server. An unusable numeric override throws from here rather than reaching
// Bun.serve as NaN.
const paths = resolveShardPaths(process.env, homedir());

const REGISTRY_PATH = paths.registryPath;
const EVENTS_PATH = paths.eventsPath;
const PORT = paths.port;
// See BANTER_CONTROL_HOST in the control plane — loopback, fronted by Tailscale Serve.
const HOST = process.env.BANTER_SHARD_HOST ?? "localhost";
const HEALTH_INTERVAL_MS = paths.healthIntervalMs;
const IDLE_INTERVAL_MS = paths.idleIntervalMs;

const runFn = createRunFn({ timeoutMs: 10000 });
const pollHealthFn = createPollHealthFn();
const spawnFn = createSpawnFn();

// Ping map for idle eviction
const pingMap = new Map<string, number>();

// Every lifecycle path on this node goes through submit, so a start and a
// stop for the same service always serialize and a concurrent request joins
// the in-flight submission rather than being rejected. Failure reporting and
// state mutation live here, run once per submission regardless of how many
// callers are awaiting it — not once per caller, which duplicate service.down
// events in the fire-and-forget start route used to produce under coalescing.
async function loadService(svc: Service): Promise<StartResult> {
  const result = await submit(svc.id, "start", () => startService(runFn, pollHealthFn, svc, EVENTS_PATH, spawnFn), { deadlineMs: startDeadlineMs(svc) });
  if (result.ok) {
    svc.state = { ...svc.state, loadTime: Date.now() };
  } else {
    console.error(`[shard] ${svc.id} load failed: ${result.error}`);
    await appendEvent(EVENTS_PATH, {
      type: "service.down",
      subjectType: "service",
      subjectId: svc.id,
      data: { reason: "start_failed", error: result.error },
      actor: "system",
    });
  }
  return result;
}

async function unloadService(svc: Service): Promise<{ ok: boolean; error?: string }> {
  const result = await submit(svc.id, "stop", () => stopService(runFn, svc, EVENTS_PATH), { deadlineMs: stopDeadlineMs() });
  if (result.ok) {
    svc.state = { ...svc.state, loadTime: undefined };
  }
  return result;
}

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
  loadService,
  unloadService,
  pingMap,
  registryPath: REGISTRY_PATH,
});

// Step 4: Merge apps and start HTTP server
const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  fetch: (req) => {
    const url = new URL(req.url);
    if (!isPlatformPath(url.pathname)) {
      return new Response("Not found", { status: 404 });
    }
    return (routesToShardApp(url.pathname) ? shardApp : sharedApp).fetch(req);
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
    await unloadService(svc);
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
