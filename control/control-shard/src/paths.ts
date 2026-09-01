import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";

/**
 * Where the shard reads and writes, and the three numbers that govern its loops.
 *
 * These live here rather than at the top of index.ts so the resolution can be
 * asked a question without starting a server: given this environment and this
 * home directory, which registry would you read? That question has had four
 * different answers across the plist, the Swift supervisor, and the deploy
 * script, and one testable answer is the point.
 */

export type Env = Record<string, string | undefined>;

export interface ShardPaths {
  registryPath: string;
  eventsPath: string;
  port: number;
  healthIntervalMs: number;
  idleIntervalMs: number;
}

/**
 * The shard's data root. Historically this was `~/Services` (capital S), a
 * macOS convention that is a *different directory* from the control plane's
 * `~/services` on a case-sensitive filesystem. Prefer the lowercase form, which
 * matches the plane and works on any OS, but fall back to an existing
 * `~/Services` so established macOS installs keep resolving.
 */
export function shardRoot(env: Env, home: string): string {
  const override = env.BANTER_SHARD_ROOT;
  if (override) return override;

  const lower = join(home, "services");
  const legacy = join(home, "Services");

  // existsSync cannot answer this on a case-insensitive filesystem (macOS's
  // default): it reports "services" as present when only "Services" exists,
  // because to the OS they are the same directory. Read the parent and look at
  // the names actually on disk, so the two spellings stay distinguishable
  // everywhere. Falling back to existsSync if home is unreadable keeps the
  // previous behaviour rather than throwing from a path resolver.
  let names: string[];
  try {
    names = readdirSync(home);
  } catch {
    if (!existsSync(lower) && existsSync(legacy)) return legacy;
    return lower;
  }

  if (!names.includes("services") && names.includes("Services")) return legacy;
  return lower;
}

/**
 * An unusable value is an error rather than a reason to fall back: Number()
 * yields NaN for anything unparseable, which reaches Bun.serve as port NaN and
 * binds something nobody asked for. Zero is rejected for the same reason — to
 * Bun.serve it means "pick any free port", which is not what an operator who
 * typed 0 meant.
 */
function positiveInt(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${label} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/**
 * Resolve every path and interval the shard needs, from the environment and the
 * home directory, in that order of precedence over the derived defaults.
 *
 * Pure but for `shardRoot`'s existence check, which is the rule being preserved
 * rather than an incidental dependency.
 *
 * The registry deliberately sits beneath the data root rather than inside the
 * deployed tree. The deploy removes and rebuilds that tree on every run, and the
 * live registry is not tracked — only an example is — so a registry kept inside
 * it would not survive a redeploy.
 */
export function resolveShardPaths(env: Env, home: string): ShardPaths {
  const root = shardRoot(env, home);

  return {
    registryPath: env.BANTER_SHARD_REGISTRY_PATH ?? join(root, "shard/registry.json"),
    eventsPath: env.BANTER_SHARD_EVENTS_PATH ?? join(root, "banter/logs/events.jsonl"),
    port: positiveInt(env.BANTER_SHARD_PORT, 4200, "BANTER_SHARD_PORT"),
    healthIntervalMs: positiveInt(env.BANTER_HEALTH_INTERVAL_MS, 900000, "BANTER_HEALTH_INTERVAL_MS"),
    idleIntervalMs: positiveInt(env.BANTER_IDLE_INTERVAL_MS, 60000, "BANTER_IDLE_INTERVAL_MS"),
  };
}
