import { join } from "node:path";

// An unusable override is an error, not a reason to fall back: parseInt yields
// NaN for anything unparseable, which reaches Bun.serve as port NaN and binds
// something nobody asked for. Zero is rejected for the same reason: to
// Bun.serve it means "pick any free port".
export function positiveInt(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${label} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

export interface ShardPaths {
  liveDir: string;
  registryPath: string;
  eventsPath: string;
  port: number;
  idleIntervalMs: number;
}

/** Where the shard reads and writes, from its environment and the user's home. */
export function resolveShardPaths(env: Record<string, string | undefined>, home: string): ShardPaths {
  // The node's live directory holds registry.json, shipped/ and state/.
  const liveDir = env.BANTER_SHARD_LIVE_DIR ?? join(home, "services/banter");
  return {
    liveDir,
    registryPath: env.BANTER_SHARD_REGISTRY_PATH ?? join(liveDir, "registry.json"),
    eventsPath: env.BANTER_SHARD_EVENTS_PATH ?? join(home, "services/banter/logs/events.jsonl"),
    port: positiveInt(env.BANTER_SHARD_PORT, 4200, "BANTER_SHARD_PORT"),
    idleIntervalMs: positiveInt(env.BANTER_IDLE_INTERVAL_MS, 60000, "BANTER_IDLE_INTERVAL_MS"),
  };
}
