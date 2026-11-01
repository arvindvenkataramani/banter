import { join } from "node:path";
import { homedir } from "node:os";
import { loadRegistry } from "../../shared/src/registry";
import { createControlPlaneApp } from "./app";
import { checkService, startHealthLoop } from "../../shared/src/health";
import { serveStatic } from "../../shared/src/static";
import { loadConfig } from "./gateway-config";
import { resolveRuntimeSettings, DEFAULT_DEPLOYMENT_ROOT } from "./runtime-settings";
import { createRunFn, createSpawnFn, createPollHealthFn } from "../../shared/src/exec";

// The tree this deployment runs from. Relative paths resolve against it, never
// against the directory the process happened to start in.
const DEPLOYMENT_ROOT = DEFAULT_DEPLOYMENT_ROOT;

// Bootstrap pointers: where to find the files. These stay in the environment
// because a file cannot carry its own location. The node's live directory is
// the top of its deployment folder, and holds config.json, registry.json,
// shipped/ and state/; a normal run needs none of them set.
const LIVE_DIR = process.env.BANTER_LIVE_DIR ?? join(homedir(), "services/banter");
const REGISTRY_PATH = process.env.BANTER_REGISTRY_PATH ?? join(LIVE_DIR, "registry.json");
const CONFIG_PATH = process.env.BANTER_CONFIG_PATH ?? join(LIVE_DIR, "config.json");
const DIST = process.env.DASHBOARD_DIST ?? join(DEPLOYMENT_ROOT, "dashboard/dist");

const registry = await loadRegistry(REGISTRY_PATH);
// A missing, unreadable or invalid configuration stops startup.
const config = await loadConfig(CONFIG_PATH).catch((err) => {
  if ((err as NodeJS.ErrnoException).code === "ENOENT") console.error(`config: ${CONFIG_PATH} not found`);
  else console.error(`config: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

// Everything else — port, bind address, event log, loop intervals — comes from
// the registry and config, with the environment kept only as an override.
const { port: PORT, host: HOST, eventsPath: EVENTS_PATH, healthIntervalMs: HEALTH_INTERVAL_MS,
        shardPollIntervalMs: SHARD_POLL_INTERVAL_MS, portSource } =
  resolveRuntimeSettings(registry, config, process.env, DEPLOYMENT_ROOT);

console.log(`Loaded registry: ${registry.services.length} services, ${registry.hosts.length} hosts`);

const runFn = createRunFn({ timeoutMs: 10000 });
const pollHealthFn = createPollHealthFn();
const spawnFn = createSpawnFn();

const localHost = registry.hosts.find(h => h.role === "control");
// The same registry object goes to the app and the health loop. The app's
// write paths mutate it in place, so sharing it is what lets an enable/disable
// or port change through the API reach the loop without a restart.
const app = await createControlPlaneApp({ registryPath: REGISTRY_PATH, registry, eventsPath: EVENTS_PATH, shardPollIntervalMs: SHARD_POLL_INTERVAL_MS, checkService, runFn, pollHealthFn, spawnFn, config, configPath: CONFIG_PATH, localHostId: localHost?.id });

// localHostId enables localhost fallback for services running on this node
const { stop: stopHealth } = startHealthLoop(registry, EVENTS_PATH, HEALTH_INTERVAL_MS, { localHostId: localHost?.id, runFn });

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  fetch: (req) => {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) return app.fetch(req);
    return serveStatic(DIST, req);
  },
});
console.log(`Control plane running on :${PORT} (port from ${portSource})`);
console.log(`Registry: ${REGISTRY_PATH}`);
console.log(`Events:   ${EVENTS_PATH}`);
console.log(`Shard poll interval: ${SHARD_POLL_INTERVAL_MS}ms`);

const stopShardPoll = (app as any).stopShardPoll;

function shutdown() {
  stopHealth();
  if (stopShardPoll) stopShardPoll();
  server.stop();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
