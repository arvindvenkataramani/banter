import { OpenAPIHono } from "@hono/zod-openapi";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { loadRegistry } from "../../shared/src/registry";
import { createApp } from "../../shared/src/api";
import { startShardPollLoop } from "./shard-poller";
import { proxyShardAction, proxyShardPatch, proxyShardEnabledToggle, proxyShardCheck, proxyShardInfo, fetchShardService } from "./shard-client";
import { registerGatewayConfig, registerVoiceConfig, registerVoiceDebug, registerConfigReload } from "./gateway-config";
import * as cpRoutes from "./routes";
import type { PlatformConfig } from "./gateway-config";
import type { Service, ServiceWithHealth, Event, Shard, Registry } from "../../../shared/types";
import type { SpawnFn, RunFn } from "../../shared/src/tailscale";

type CheckFn = (service: Service, eventsPath: string, opts?: { bypassThreshold?: boolean; localHostId?: string; runFn?: RunFn }) => Promise<void>;

export interface ControlPlaneAppDeps {
  registryPath: string;
  /**
   * The live registry object. Callers that also drive long-running loops over
   * the registry (the health loop) must pass the same object they gave those
   * loops: the API's write paths mutate it in place, and a second `loadRegistry`
   * here would leave those loops iterating a copy that never sees the writes.
   * Omitted only by tests that drive the app alone; then it is loaded here.
   */
  registry?: Registry;
  eventsPath: string;
  shardPollIntervalMs?: number;
  checkService: CheckFn;
  runFn: (cmd: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  pollHealthFn: (url: string, timeoutMs: number) => Promise<boolean>;
  spawnFn?: SpawnFn;
  config?: PlatformConfig;
  configPath?: string;
  localHostId?: string;
}

type Poller = ReturnType<typeof startShardPollLoop>;

export async function createControlPlaneApp(deps: ControlPlaneAppDeps): Promise<OpenAPIHono & { stopShardPoll: (() => void) | null }> {
  const { registryPath, eventsPath, shardPollIntervalMs, checkService, runFn, pollHealthFn, spawnFn, config, configPath, localHostId } = deps;

  const registry = deps.registry ?? await loadRegistry(registryPath);

  const sharedApp = createApp({
    registryState: registry,
    registryPath,
    eventsPath,
    checkService,
    runFn,
    pollHealthFn,
    spawnFn,
    localHostId,
  });

  const pollIntervalMs = shardPollIntervalMs ?? parseInt(process.env.BANTER_SHARD_POLL_INTERVAL_MS ?? "900000");

  let poller: Poller | null = null;
  if (registry.shards && registry.shards.length > 0) {
    poller = startShardPollLoop(registry.shards, pollIntervalMs);
  }

  const shards = registry.shards ?? [];

  // Helper: find which shard endpoint owns a given hostId
  function shardEndpointFor(hostId: string): string | null {
    const s = shards.find((s) => s.hostId === hostId);
    return s ? s.endpoint : null;
  }

  // Helper: get all cached shard services from all polled shards
  function allShardServices(): ServiceWithHealth[] {
    if (!poller) return [];
    return poller.getAllShardServices();
  }

  function allShardEvents(): Event[] {
    if (!poller) return [];
    return poller.getAllShardEvents();
  }

  function shardIsOnline(hostId: string): boolean {
    return poller ? poller.isShardOnline(hostId) : false;
  }

  // Helper: is this service in the local registry?
  function isLocal(id: string): boolean {
    return registry.services.some((s) => s.id === id);
  }

  // Helper: rewrite localhost in a shard service's endpoint to the shard's external URL
  function rewriteShardEndpoint(svc: ServiceWithHealth): ServiceWithHealth {
    const shardEndpoint = shardEndpointFor(svc.hostId);
    if (!shardEndpoint) return svc;
    if (!svc.network?.endpoint) return svc;
    const shardUrl = new URL(shardEndpoint);
    const svcUrl = new URL(svc.network.endpoint);
    if (svcUrl.hostname !== "localhost" && svcUrl.hostname !== "127.0.0.1") return svc;
    svcUrl.hostname = shardUrl.hostname;
    return { ...svc, network: { ...svc.network, endpoint: svcUrl.toString() } };
  }

  const app = new OpenAPIHono() as OpenAPIHono & { stopShardPoll: (() => void) | null };
  app.stopShardPoll = poller ? poller.stop : null;

  // GET /api/shards — shard connection status
  app.openapi(cpRoutes.getShards, (c) => {
    const result = shards.map(shard => ({
      hostId: shard.hostId,
      endpoint: shard.endpoint,
      online: shardIsOnline(shard.hostId),
      lastPoll: poller ? poller.getLastPoll(shard.hostId) : 0,
    }));
    return c.json(result);
  });

  // POST /api/shards/:hostId/poll — trigger an immediate poll
  app.openapi(cpRoutes.pollShard, async (c) => {
    const { hostId } = c.req.valid("param");
    if (!shards.find(s => s.hostId === hostId)) {
      return c.json({ error: "shard not found" }, 404);
    }
    if (!poller) return c.json({ error: "no poller" }, 500);
    await poller.pollShard(hostId);
    return c.json({
      hostId,
      online: shardIsOnline(hostId),
      lastPoll: poller.getLastPoll(hostId),
    }, 200);
  });

  // GET /api/services — merge local + shard
  app.get("/api/services", async (c) => {
    const capability = c.req.query("capability");
    const url = capability
      ? `http://localhost/api/services?capability=${encodeURIComponent(capability)}`
      : "http://localhost/api/services";
    const localRes = await sharedApp.fetch(new Request(url));
    const localServices = (await localRes.json()) as ServiceWithHealth[];
    let shardServices = allShardServices().map(rewriteShardEndpoint);
    if (capability) {
      shardServices = shardServices.filter(s => s.capabilityId === capability);
    }
    return c.json([...localServices, ...shardServices]);
  });

  // GET /api/services/:id — local first, then live fetch from shard (cache fallback)
  app.get("/api/services/:id", async (c) => {
    const id = c.req.param("id");
    if (isLocal(id)) {
      return sharedApp.fetch(c.req.raw);
    }
    const cachedSvc = allShardServices().find((s) => s.id === id);
    if (!cachedSvc) return c.json({ error: "service not found" }, 404);

    const endpoint = shardEndpointFor(cachedSvc.hostId);
    if (!endpoint) return c.json(rewriteShardEndpoint(cachedSvc));

    try {
      const liveSvc = await fetchShardService(endpoint, id);
      if (liveSvc) {
        if (poller) poller.updateCachedService(cachedSvc.hostId, liveSvc);
        return c.json(rewriteShardEndpoint(liveSvc));
      }
      return c.json(rewriteShardEndpoint(cachedSvc));
    } catch {
      return c.json(rewriteShardEndpoint(cachedSvc));
    }
  });

  // GET /api/events — merge and sort newest-first, apply limit
  app.get("/api/events", async (c) => {
    const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!) : 50;
    const subjectId = c.req.query("subjectId") ?? undefined;

    const localUrl = new URL("http://localhost/api/events");
    localUrl.searchParams.set("limit", String(limit));
    if (subjectId) localUrl.searchParams.set("subjectId", subjectId);

    const localRes = await sharedApp.fetch(new Request(localUrl.toString()));
    const localEvents = (await localRes.json()) as Event[];
    const shardEvents = allShardEvents().filter(e => !subjectId || e.subjectId === subjectId);

    const merged = [...localEvents, ...shardEvents].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
    return c.json(merged.slice(0, limit));
  });

  // Lifecycle + PATCH routing: local → shared app, shard → proxy
  async function routeAction(
    c: any,
    id: string,
    handle: (endpoint: string) => Promise<{ ok: boolean; status?: number; data?: any; error?: string }>
  ) {
    if (isLocal(id)) return sharedApp.fetch(c.req.raw);

    const shardSvc = allShardServices().find((s) => s.id === id);
    if (!shardSvc) return c.json({ error: "service not found" }, 404);

    if (!shardIsOnline(shardSvc.hostId)) {
      return c.json({ error: "shard is offline" }, 503);
    }

    const endpoint = shardEndpointFor(shardSvc.hostId);
    if (!endpoint) return c.json({ error: "shard not found" }, 404);

    const result = await handle(endpoint);

    // Refresh cache in background so list endpoint picks up changes
    if (result.ok && poller) {
      poller.pollShard(shardSvc.hostId).catch(() => {});
    }

    return c.json(result.data ?? { error: result.error }, (result.status ?? (result.ok ? 200 : 500)) as ContentfulStatusCode);
  }

  app.post("/api/services/:id/start", (c) =>
    routeAction(c, c.req.param("id"), (ep) => proxyShardAction(ep, c.req.param("id"), "start"))
  );

  app.post("/api/services/:id/stop", (c) =>
    routeAction(c, c.req.param("id"), (ep) => proxyShardAction(ep, c.req.param("id"), "stop"))
  );

  app.post("/api/services/:id/restart", (c) =>
    routeAction(c, c.req.param("id"), (ep) => proxyShardAction(ep, c.req.param("id"), "restart"))
  );

  app.patch("/api/services/:id/enabled", async (c) => {
    const id = c.req.param("id");
    if (isLocal(id)) return sharedApp.fetch(c.req.raw);

    const shardSvc = allShardServices().find((s) => s.id === id);
    if (!shardSvc) return c.json({ error: "service not found" }, 404);
    if (!shardIsOnline(shardSvc.hostId)) return c.json({ error: "shard is offline" }, 503);

    const endpoint = shardEndpointFor(shardSvc.hostId);
    if (!endpoint) return c.json({ error: "shard not found" }, 404);

    const body = await c.req.json();
    const result = await proxyShardEnabledToggle(endpoint, id, body);
    if (result.ok && poller) {
      poller.pollShard(shardSvc.hostId).catch(() => {});
    }
    return c.json(result.data ?? { error: result.error }, (result.status ?? (result.ok ? 200 : 500)) as ContentfulStatusCode);
  });

  app.patch("/api/services/:id", async (c) => {
    const id = c.req.param("id");
    if (isLocal(id)) return sharedApp.fetch(c.req.raw);

    const shardSvc = allShardServices().find((s) => s.id === id);
    if (!shardSvc) return c.json({ error: "service not found" }, 404);
    if (!shardIsOnline(shardSvc.hostId)) return c.json({ error: "shard is offline" }, 503);

    const endpoint = shardEndpointFor(shardSvc.hostId);
    if (!endpoint) return c.json({ error: "shard not found" }, 404);

    const patch = await c.req.json();
    const result = await proxyShardPatch(endpoint, id, patch);
    if (result.ok && poller) {
      poller.pollShard(shardSvc.hostId).catch(() => {});
    }
    return c.json(result.data ?? { error: result.error }, (result.status ?? (result.ok ? 200 : 500)) as ContentfulStatusCode);
  });

  app.post("/api/services/:id/check", (c) =>
    routeAction(c, c.req.param("id"), (ep) => proxyShardCheck(ep, c.req.param("id")))
  );

  app.get("/api/services/:id/info", (c) =>
    routeAction(c, c.req.param("id"), (ep) => proxyShardInfo(ep, c.req.param("id")))
  );

  // Gateway + voice config
  if (config) {
    registerGatewayConfig(app, config, configPath)
    registerVoiceConfig(app, config, configPath, () => [
      ...registry.services,
      ...allShardServices(),
    ])
    registerConfigReload(app, config, configPath)
    registerVoiceDebug(app, config)
  }

  // Register all route definitions in the OpenAPI spec.
  // Routes handled by app.openapi() above (shards) are already registered.
  // Routes handled by plain app.get()/app.post() or delegated to the shared app
  // are registered here for documentation only.
  for (const route of [
    cpRoutes.getHealth,
    cpRoutes.getServices,
    cpRoutes.getServiceById,
    cpRoutes.getServiceInfo,
    cpRoutes.getEvents,
    cpRoutes.checkService,
    cpRoutes.startService,
    cpRoutes.stopService,
    cpRoutes.restartService,
    cpRoutes.patchService,
    cpRoutes.toggleServiceEnabled,
    cpRoutes.getHosts,
    cpRoutes.getCapabilities,
    cpRoutes.getGateway,
    cpRoutes.getVoice,
  ]) {
    app.openAPIRegistry.registerPath(route);
  }

  // OpenAPI spec endpoint
  app.doc("/api/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Banter API", version: "1.0.0" },
  });

  // Everything else falls through to shared app
  app.all("*", (c) => sharedApp.fetch(c.req.raw));

  return app;
}
