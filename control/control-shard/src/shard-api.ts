import { OpenAPIHono } from "@hono/zod-openapi";
import { deriveHealthMap, deriveHealth, deriveServiceHealth } from "../../shared/src/events";
import { emptyRoster } from "../../shared/src/roster";
import { reloadRegistry } from "../../shared/src/registry";
import * as shardRoutes from "./routes";
import type { Registry, Service } from "../../../shared/types";

type LoadServiceFn = (svc: Service) => Promise<{ ok: boolean; error?: string }>;
type UnloadServiceFn = (svc: Service) => Promise<{ ok: boolean; error?: string }>;

interface ShardAppDeps {
  registryState: Registry;
  eventsPath: string;
  getFreeMem: () => Promise<number>;
  loadService: LoadServiceFn;
  unloadService: UnloadServiceFn;
  /** Last-activity timestamps, keyed by service id. Must be the same map the
   *  idle loop reads, or pings never reach the eviction decision. */
  pingMap?: Map<string, number>;
  registryPath?: string;
}

export function createShardApp(deps: ShardAppDeps) {
  const { registryState, eventsPath, getFreeMem, loadService, unloadService } = deps;
  const app = new OpenAPIHono();
  const pingMap = deps.pingMap ?? new Map<string, number>();

  // GET /status
  app.openapi(shardRoutes.getStatus, async (c) => {
    const freeMem = await getFreeMem();
    const healthOf = await deriveServiceHealth(eventsPath);

    const services: Record<string, { health: string; lastPing: number | null }> = {};
    for (const svc of registryState.services) {
      const { health } = healthOf(svc);
      services[svc.id] = {
        health,
        lastPing: pingMap.get(svc.id) ?? null,
      };
    }

    return c.json({ freeMem, services });
  });

  // POST /ping/:service
  app.openapi(shardRoutes.pingService, (c) => {
    const { service: svcId } = c.req.valid("param");
    const svc = registryState.services.find(s => s.id === svcId);
    if (!svc) return c.json({ error: "service not found" }, 404);

    pingMap.set(svcId, Date.now());
    return c.json({ ok: true }, 200);
  });

  // POST /api/services/:id/start (shard override for demand-loaded services)
  app.post("/api/services/:id/start", async (c) => {
    const svcId = c.req.param("id");
    const svc = registryState.services.find(s => s.id === svcId);
    if (!svc) return c.json({ error: "service not found" }, 404);
    if (!svc.permissions.enabled) return c.json({ error: "service is disabled" }, 400);

    if (svc.lifecycle?.loadStrategy === "demand") {
      // Fire-and-forget: submit and return 202 immediately. A concurrent
      // request against this service joins the same submission rather than
      // being rejected, so state handling and failure reporting belong to
      // loadService itself — done once per submission, not once per caller.
      // Caller polls GET /api/services/:id for pending + health status.
      loadService(svc).catch(err => {
        const error = err instanceof Error ? err.message : String(err);
        console.error(`[shard] ${svcId} load error: ${error}`);
      });
      return c.json({ success: true }, 202);
    }

    // For non-demand services, fall through to shared app (will be called below)
    return c.json({ success: false, error: "not a demand service" }, 400);
  });

  // POST /api/services/:id/stop (shard override for demand-loaded services)
  app.post("/api/services/:id/stop", async (c) => {
    const svcId = c.req.param("id");
    const svc = registryState.services.find(s => s.id === svcId);
    if (!svc) return c.json({ error: "service not found" }, 404);

    // For demand-loaded services, handle the stop
    if (svc.lifecycle?.loadStrategy === "demand") {
      const result = await unloadService(svc);
      if (!result.ok) {
        return c.json({ success: false, error: result.error ?? "stop failed" }, 500);
      }
      return c.json({ success: true });
    }

    // For non-demand services, fall through to shared app
    return c.json({ success: false, error: "not a demand service" }, 400);
  });

  // Read from the live registry object on every request, not cached at
  // factory time, so a reload is reflected without a restart.
  app.get("/api/roster", (c) => {
    return c.json(registryState.roster ?? emptyRoster());
  });

  app.post("/api/config/reload", async (c) => {
    if (!deps.registryPath) {
      return c.json({ registry: { ok: false, error: "no registry path configured" }, warnings: [] }, 500);
    }
    const healthMap = await deriveHealthMap(eventsPath);
    const isRunning = (serviceId: string) =>
      ["healthy", "degraded", "timed_out"].includes(deriveHealth(healthMap.get(serviceId) ?? null));
    const result = await reloadRegistry(deps.registryPath, registryState, isRunning);
    if (!result.ok) {
      return c.json({ registry: { ok: false, error: result.error }, warnings: [] }, 500);
    }
    return c.json({ registry: { ok: true }, warnings: result.warnings });
  });

  return app;
}
