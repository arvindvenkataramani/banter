import { appendEvent } from "../../shared/src/events";
import type { Service } from "../../../shared/types";

/**
 * Evicts loaded services idle past their timeout, one pass every intervalMs.
 * A pass starts only after the previous one finishes, and stop() resolves once
 * any pass in progress has written its events.
 */
export function startIdleLoop(
  services: Service[],
  pingMap: Map<string, number>,
  evictFn: (svc: Service) => Promise<void>,
  eventsPath: string,
  intervalMs = 60000
): { stop: () => Promise<void> } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pass: Promise<void> | null = null;

  async function evictIdle() {
    for (const svc of services) {
      if (stopped) return;
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
  }

  function schedule() {
    timer = setTimeout(() => {
      timer = null;
      pass = evictIdle()
        .catch(err => console.error("idle loop pass failed:", err))
        .finally(() => {
          pass = null;
          if (!stopped) schedule();
        });
    }, intervalMs);
  }

  schedule();

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await pass;
    },
  };
}
