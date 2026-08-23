import type { ServiceWithHealth, Event, Shard } from "../../../shared/types";
import { fetchShardServices, fetchShardEvents } from "./shard-client";

interface ShardCache {
  services: ServiceWithHealth[];
  events: Event[];
  lastPoll: number;
  online: boolean;
}

export function startShardPollLoop(shards: Shard[], intervalMs: number): { stop: () => void; getShardServices: (hostId: string) => ServiceWithHealth[]; getShardEvents: (hostId: string) => Event[]; isShardOnline: (hostId: string) => boolean; getLastPoll: (hostId: string) => number; getAllShardServices: () => ServiceWithHealth[]; getAllShardEvents: () => Event[]; pollShard: (hostId: string) => Promise<void>; updateCachedService: (hostId: string, svc: ServiceWithHealth) => void } {
  const cache = new Map<string, ShardCache>();
  let stopped = false;
  let sleepResolve: (() => void) | null = null;
  let sleepTimer: ReturnType<typeof setTimeout> | null = null;

  for (const shard of shards) {
    cache.set(shard.hostId, { services: [], events: [], lastPoll: 0, online: false });
  }

  async function pollAll() {
    for (const shard of shards) {
      console.log(`[shard-poller] Polling ${shard.hostId} at ${shard.endpoint}...`);
      await pollOne(shard);
      if (cache.get(shard.hostId)?.online) {
        const c = cache.get(shard.hostId)!;
        console.log(`[shard-poller] ${shard.hostId}: ${c.services.length} services, ${c.events.length} events`);
      }
    }
  }

  // Poll immediately, then on interval
  (async () => {
    await pollAll();
    while (!stopped) {
      await new Promise<void>((resolve) => {
        sleepResolve = resolve;
        sleepTimer = setTimeout(resolve, intervalMs);
      });
      sleepResolve = null;
      sleepTimer = null;
      if (stopped) break;
      await pollAll();
    }
  })();

  async function pollOne(shard: Shard) {
    try {
      const [services, events] = await Promise.all([
        fetchShardServices(shard.endpoint),
        fetchShardEvents(shard.endpoint),
      ]);
      const c = cache.get(shard.hostId)!;
      c.services = services;
      c.events = events;
      c.lastPoll = Date.now();
      c.online = true;
    } catch (err) {
      const c = cache.get(shard.hostId)!;
      c.online = false;
      // Only flip the shard process itself to unknown — its services have an independent lifecycle
      c.services = c.services.map(svc =>
        svc.capabilityId === "control" && svc.hostId === shard.hostId
          ? { ...svc, health: "unknown" as const }
          : svc
      );
      console.error(`[shard-poller] ${shard.hostId} poll failed:`, err instanceof Error ? err.message : err);
    }
  }

  return {
    stop() {
      stopped = true;
      if (sleepTimer) clearTimeout(sleepTimer);
      if (sleepResolve) sleepResolve();
    },
    getShardServices(hostId) { return cache.get(hostId)?.services ?? []; },
    getShardEvents(hostId) { return cache.get(hostId)?.events ?? []; },
    isShardOnline(hostId) { return cache.get(hostId)?.online ?? false; },
    getLastPoll(hostId) { return cache.get(hostId)?.lastPoll ?? 0; },
    getAllShardServices() {
      const all: ServiceWithHealth[] = [];
      for (const c of cache.values()) all.push(...c.services);
      return all;
    },
    getAllShardEvents() {
      const all: Event[] = [];
      for (const c of cache.values()) all.push(...c.events);
      return all;
    },
    async pollShard(hostId: string) {
      const shard = shards.find(s => s.hostId === hostId);
      if (shard) await pollOne(shard);
    },
    updateCachedService(hostId: string, svc: ServiceWithHealth) {
      const c = cache.get(hostId);
      if (!c) return;
      const idx = c.services.findIndex(s => s.id === svc.id);
      if (idx >= 0) {
        c.services[idx] = svc;
      } else {
        c.services.push(svc);
      }
    },
  };
}
