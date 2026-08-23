import { appendEvent } from "../../shared/src/events";
import type { Service } from "../../../shared/types";

export function startIdleLoop(
  services: Service[],
  pingMap: Map<string, number>,
  evictFn: (svc: Service) => Promise<void>,
  eventsPath: string,
  intervalMs = 60000
): { stop: () => void } {
  let stopped = false;

  const timer = setInterval(async () => {
    if (stopped) return;

    for (const svc of services) {
      // Only evict loaded services with idleUnload === true
      if (svc.lifecycle?.idleUnload !== true) continue;
      if (svc.state?.loadTime == null) continue;

      const lastActivity = pingMap.get(svc.id) ?? svc.state.loadTime ?? Date.now();
      const idleTimeout = svc.lifecycle!.idleTimeout!;

      if (Date.now() - lastActivity > idleTimeout) {
        await evictFn(svc);
        await appendEvent(eventsPath, {
          type: "service.unloaded",
          subjectType: "service",
          subjectId: svc.id,
          data: {},
          actor: "system",
        });
      }
    }
  }, intervalMs);

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export function createPingEndpoint(
  services: Service[],
  pingMap: Map<string, number>
): (serviceId: string) => Promise<{ status: number }> {
  return async (serviceId: string) => {
    const svc = services.find(s => s.id === serviceId);
    if (!svc) {
      return { status: 404 };
    }

    pingMap.set(serviceId, Date.now());
    return { status: 200 };
  };
}
