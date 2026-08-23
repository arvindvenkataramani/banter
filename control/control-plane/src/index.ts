import { join } from "node:path";
import { loadRegistry } from "../../shared/src/registry";
import { createControlPlaneApp } from "./app";
import { checkService, startHealthLoop } from "../../shared/src/health";
import { serveStatic } from "../../shared/src/static";
import { loadConfig } from "./gateway-config";
import { resolveRuntimeSettings } from "./runtime-settings";
import type { RunFn, PollHealthFn, SpawnFn } from "../../shared/src/tailscale";

// Bootstrap pointers: where to find the files. These stay in the environment
// because a file cannot carry its own location. Both default to the deployed
// tree, so a normal run needs neither.
const REGISTRY_PATH = process.env.BANTER_REGISTRY_PATH ?? join(import.meta.dir, "../data/registry.json");
const CONFIG_PATH = process.env.BANTER_CONFIG_PATH ?? join(import.meta.dir, "../data/config.json");
const DIST = process.env.DASHBOARD_DIST ?? join(import.meta.dir, "../../../dashboard/dist");

const registry = await loadRegistry(REGISTRY_PATH);
const config = await loadConfig(CONFIG_PATH).catch(() => undefined);

// Everything else — port, bind address, event log, loop intervals — comes from
// the registry and config, with the environment kept only as an override.
const { port: PORT, host: HOST, eventsPath: EVENTS_PATH, healthIntervalMs: HEALTH_INTERVAL_MS,
        shardPollIntervalMs: SHARD_POLL_INTERVAL_MS, portSource } =
  resolveRuntimeSettings(registry, config, process.env);

console.log(`Loaded registry: ${registry.services.length} services, ${registry.hosts.length} hosts`);

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

// Real SpawnFn — spawns a long-running process and returns a kill handle.
// When logDir is set, stdout/stderr stream to log files; install scripts pre-create the directory.
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
