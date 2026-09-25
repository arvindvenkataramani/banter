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

      // The ping map outlives an unload, so a ping older than the current load
      // belongs to an earlier one and must not count against this one.
      const lastActivity = Math.max(pingMap.get(svc.id) ?? 0, svc.state.loadTime);
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
