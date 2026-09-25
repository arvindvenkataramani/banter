import { Hono } from "hono";
import { deriveHealthMap, deriveHealth, readEvents, appendEvent } from "./events";
import { updateService, setEnabled } from "./registry";
import {
  startService,
  stopService,
  restartService,
  enableService,
  disableService,
  startDeadlineMs,
  stopDeadlineMs,
  restartDeadlineMs,
} from "./lifecycle";
import { submit, isPending } from "./executor";
import type { RunFn, PollHealthFn, SpawnFn } from "./lifecycle";
import type { Registry, Service, ServiceWithHealth } from "../../../shared/types";

type CheckFn = (service: Service, eventsPath: string, opts?: { bypassThreshold?: boolean; localHostId?: string; runFn?: RunFn }) => Promise<void>;

interface AppDeps {
  registryState: Registry;
  registryPath: string;
  eventsPath: string;
  checkService: CheckFn;
  runFn: RunFn;
  pollHealthFn: PollHealthFn;
  spawnFn?: SpawnFn;
  localHostId?: string;
}

/** A Node filesystem/system error, which carries a string `code` like ENOENT.
 * These signal an infrastructure failure rather than a bad request. */
function isErrnoException(err: unknown): boolean {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === "string";
}

export function createApp(deps: AppDeps) {
  const { registryState, registryPath, eventsPath, checkService, runFn, pollHealthFn, spawnFn, localHostId } = deps;
  const app = new Hono();

  app.onError((err, c) => {
    console.error(`[api] ${c.req.method} ${c.req.path}:`, err);
    return c.json({ error: err instanceof Error ? err.message : "internal error" }, 500);
  });

  // GET /api/health
  app.get("/api/health", (c) => {
    return c.json({ status: "ok", uptime: process.uptime() });
  });

  // GET /api/services
  app.get("/api/services", async (c) => {
    const capability = c.req.query("capability");
    const healthMap = await deriveHealthMap(eventsPath);
    const services = capability
      ? registryState.services.filter(s => s.capabilityId === capability)
      : registryState.services;
    const result: ServiceWithHealth[] = services.map((svc) => {
      const pending = svc.runner?.type === "external" ? false : isPending(svc.id);
      if (!svc.permissions.enabled) {
        return { ...svc, health: "disabled" as const, lastEvent: null, pending };
      }
      const lastEvent = healthMap.get(svc.id) ?? null;
      return { ...svc, health: deriveHealth(lastEvent), lastEvent, pending };
    });
    return c.json(result);
  });

  // GET /api/services/:id
  app.get("/api/services/:id", async (c) => {
    const svc = registryState.services.find(s => s.id === c.req.param("id"));
    if (!svc) return c.json({ error: "service not found" }, 404);

    const healthMap = await deriveHealthMap(eventsPath);
    const lastEvent = svc.permissions.enabled ? (healthMap.get(svc.id) ?? null) : null;
    const health = svc.permissions.enabled ? deriveHealth(lastEvent) : "disabled" as const;
    const pending = svc.runner?.type === "external" ? false : isPending(svc.id);
    return c.json({ ...svc, health, lastEvent, pending });
  });

  // GET /api/services/:id/info — proxy to the service's /info endpoint
  app.get("/api/services/:id/info", async (c) => {
    const svc = registryState.services.find(s => s.id === c.req.param("id"));
    if (!svc) return c.json({ error: "service not found" }, 404);

    try {
      const res = await fetch(`${svc.network.endpoint}/info`);
      const data = await res.json();
      return c.json(data, res.status as any);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "fetch failed" }, 502);
    }
  });

  // GET /api/hosts
  app.get("/api/hosts", (c) => {
    return c.json(registryState.hosts);
  });

  // GET /api/capabilities
  app.get("/api/capabilities", (c) => {
    return c.json(registryState.capabilities);
  });

  // GET /api/events
  app.get("/api/events", async (c) => {
    const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!) : 50;
    const subjectId = c.req.query("subjectId") ?? undefined;
    const events = await readEvents(eventsPath, { limit, subjectId });
    return c.json(events);
  });

  // POST /api/services/:id/check
  app.post("/api/services/:id/check", async (c) => {
    const svc = registryState.services.find(s => s.id === c.req.param("id"));
    if (!svc) return c.json({ error: "service not found" }, 404);

    await checkService(svc, eventsPath, { bypassThreshold: true, localHostId, runFn });

    const healthMap = await deriveHealthMap(eventsPath);
    const lastEvent = svc.permissions.enabled ? (healthMap.get(svc.id) ?? null) : null;
    const health = svc.permissions.enabled ? deriveHealth(lastEvent) : "disabled" as const;
    return c.json({ ...svc, health, lastEvent });
  });

  // PATCH /api/services/:id
  app.patch("/api/services/:id", async (c) => {
    const svc = registryState.services.find(s => s.id === c.req.param("id"));
    if (!svc) return c.json({ error: "service not found" }, 404);

    const patch = await c.req.json() as Record<string, unknown>;
    let updated: Service;
    try {
      updated = await updateService(registryState, registryPath, c.req.param("id"), patch);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // An errno from the filesystem is our failure, not the caller's — a patch
      // rejected as malformed and a registry that could not be written are not
      // the same thing, and reporting both as 400 sends the client to debug its
      // own request over an infrastructure problem.
      const status = isErrnoException(err) ? 500 : msg.includes("not found") ? 404 : 400;
      return c.json({ error: msg }, status);
    }

    const healthMap = await deriveHealthMap(eventsPath);
    const lastEvent = updated.permissions.enabled ? (healthMap.get(updated.id) ?? null) : null;
    const health = updated.permissions.enabled ? deriveHealth(lastEvent) : "disabled" as const;
    return c.json({ ...updated, health, lastEvent });
  });

  // POST /api/services/:id/start
  app.post("/api/services/:id/start", async (c) => {
    const svc = registryState.services.find(s => s.id === c.req.param("id"));
    if (!svc) return c.json({ error: "service not found" }, 404);
    if (!svc.permissions.enabled) return c.json({ error: "service is disabled" }, 400);

    const result = await submit(svc.id, "start", () => startService(runFn, pollHealthFn, svc, eventsPath, spawnFn), { deadlineMs: startDeadlineMs(svc) });
    if (!result.ok) {
      const status = result.error?.includes("external") ? 400 : 500;
      return c.json({ error: result.error ?? "start failed" }, status as any);
    }

    return c.json({ success: true, ...(result.stage && { stage: result.stage }), ...(result.error && { error: result.error }) });
  });

  // POST /api/services/:id/stop
  app.post("/api/services/:id/stop", async (c) => {
    const svc = registryState.services.find(s => s.id === c.req.param("id"));
    if (!svc) return c.json({ error: "service not found" }, 404);
    if (svc.permissions.protected) return c.json({ error: "Cannot stop a protected service" }, 403);

    const result = await submit(svc.id, "stop", () => stopService(runFn, svc, eventsPath), { deadlineMs: stopDeadlineMs() });
    if (!result.ok) {
      const status = result.error?.includes("external") ? 400 : 500;
      return c.json({ error: result.error ?? "stop failed" }, status as any);
    }

    return c.json({ success: true });
  });

  // POST /api/services/:id/restart
  app.post("/api/services/:id/restart", async (c) => {
    const svc = registryState.services.find(s => s.id === c.req.param("id"));
    if (!svc) return c.json({ error: "service not found" }, 404);

    const result = await submit(svc.id, "restart", () => restartService(runFn, pollHealthFn, svc, eventsPath, spawnFn), { deadlineMs: restartDeadlineMs(svc) });
    if (!result.ok) {
      const status = result.error?.includes("external") ? 400 : 500;
      return c.json({ error: result.error ?? "restart failed" }, status as any);
    }

    return c.json({ success: true, ...(result.stage && { stage: result.stage }), ...(result.error && { error: result.error }) });
  });

  // PATCH /api/services/:id/enabled
  app.patch("/api/services/:id/enabled", async (c) => {
    const svc = registryState.services.find(s => s.id === c.req.param("id"));
    if (!svc) return c.json({ error: "service not found" }, 404);

    const body = await c.req.json() as { enabled: boolean };

    if (!body.enabled && svc.permissions.protected) {
      return c.json({ error: "Cannot disable a protected service" }, 403);
    }

    if (body.enabled) {
      const result = await enableService(runFn, svc, eventsPath);
      if (!result.ok && result.error && !result.error.includes("no enable command")) {
        return c.json({ error: result.error }, 500);
      }
    } else {
      const result = await disableService(runFn, svc, eventsPath);
      if (!result.ok && result.error && !result.error.includes("no disable command")) {
        return c.json({ error: result.error }, 500);
      }
    }

    const updated = await setEnabled(registryState, registryPath, c.req.param("id"), body.enabled);

    await appendEvent(eventsPath, {
      type: body.enabled ? "service.enabled" : "service.disabled",
      subjectType: "service",
      subjectId: updated.id,
      data: {},
      actor: "user",
    });

    return c.json(updated);
  });

  return app;
}
