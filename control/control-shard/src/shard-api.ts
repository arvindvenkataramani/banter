import { OpenAPIHono } from "@hono/zod-openapi";
import { deriveHealthMap, deriveHealth, readEvents, appendEvent } from "../../shared/src/events";
import { isLocked } from "../../shared/src/lifecycle";
import * as shardRoutes from "./routes";
import type { Registry, Service } from "../../../shared/types";

type CheckMemoryBudgetFn = () => Promise<{ ok: boolean; error?: string }>;
type LoadServiceFn = (svc: Service) => Promise<{ ok: boolean; error?: string }>;
type UnloadServiceFn = (svc: Service) => Promise<{ ok: boolean; error?: string }>;

interface ShardAppDeps {
  registryState: Registry;
  eventsPath: string;
  getFreeMem: () => Promise<number>;
  checkMemoryBudget: CheckMemoryBudgetFn;
  loadService: LoadServiceFn;
  unloadService: UnloadServiceFn;
}

export function createShardApp(deps: ShardAppDeps) {
  const { registryState, eventsPath, getFreeMem, checkMemoryBudget, loadService, unloadService } = deps;
  const app = new OpenAPIHono();
  const pingMap = new Map<string, number>();

  // GET /api/health
  app.get("/api/health", (c) => {
    return c.json({ status: "ok" });
  });

  // GET /api/services
  app.get("/api/services", async (c) => {
    const healthMap = await deriveHealthMap(eventsPath);
    const result = registryState.services.map((svc) => {
      if (!svc.permissions.enabled) {
        return { ...svc, health: "disabled" as const, lastEvent: null };
      }
      const lastEvent = healthMap.get(svc.id) ?? null;
      return { ...svc, health: deriveHealth(lastEvent), lastEvent };
    });
    return c.json(result);
  });

  // GET /api/events
  app.get("/api/events", async (c) => {
    const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!) : 50;
    const subjectId = c.req.query("subjectId") ?? undefined;
    const events = await readEvents(eventsPath, { limit, subjectId });
    return c.json(events);
  });

  // GET /status
  app.openapi(shardRoutes.getStatus, async (c) => {
    const freeMem = await getFreeMem();
    const healthMap = await deriveHealthMap(eventsPath);

    const services: Record<string, { health: string; lastPing: number | null }> = {};
    for (const svc of registryState.services) {
      const lastEvent = svc.permissions.enabled ? (healthMap.get(svc.id) ?? null) : null;
      const health = svc.permissions.enabled ? deriveHealth(lastEvent) : "disabled";
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
    if (isLocked(svcId)) return c.json({ error: "lifecycle operation in progress" }, 409);

    // For demand-loaded services, check memory budget before starting
    if (svc.lifecycle?.loadStrategy === "demand") {
      const budgetCheck = await checkMemoryBudget();
      if (!budgetCheck.ok) {
        await appendEvent(eventsPath, {
          type: "memory.pressure",
          subjectType: "service",
          subjectId: svcId,
          data: { error: budgetCheck.error },
          actor: "system",
        });
        return c.json({ success: false, error: budgetCheck.error ?? "memory pressure" }, 503);
      }

      // Fire-and-forget: kick off lifecycle in background, return 202 immediately.
      // Caller polls GET /api/services/:id for locked + health status.
      loadService(svc).then(async result => {
        if (result.ok) {
          svc.state = { ...svc.state, loadTime: Date.now() };
        } else {
          console.error(`[shard] ${svcId} load failed: ${result.error}`);
          await appendEvent(eventsPath, {
            type: "service.down",
            subjectType: "service",
            subjectId: svcId,
            data: { reason: "start_failed", error: result.error },
            actor: "system",
          });
        }
      }).catch(async err => {
        const error = err instanceof Error ? err.message : String(err);
        console.error(`[shard] ${svcId} load error: ${error}`);
        await appendEvent(eventsPath, {
          type: "service.down",
          subjectType: "service",
          subjectId: svcId,
          data: { reason: "start_error", error },
          actor: "system",
        });
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
    if (isLocked(svcId)) return c.json({ error: "lifecycle operation in progress" }, 409);

    // For demand-loaded services, handle the stop
    if (svc.lifecycle?.loadStrategy === "demand") {
      const result = await unloadService(svc);
      if (!result.ok) {
        return c.json({ success: false, error: result.error ?? "stop failed" }, 500);
      }
      svc.state = { ...svc.state, loadTime: undefined };
      return c.json({ success: true });
    }

    // For non-demand services, fall through to shared app
    return c.json({ success: false, error: "not a demand service" }, 400);
  });

  return app;
}
