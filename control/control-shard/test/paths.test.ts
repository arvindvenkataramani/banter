import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { resolveShardPaths } from "../src/paths";

const HOME = "/home/someone";

describe("resolveShardPaths", () => {
  it("returns today's defaults under home with an empty environment", () => {
    expect(resolveShardPaths({}, HOME)).toEqual({
      liveDir: join(HOME, "services/banter"),
      registryPath: join(HOME, "services/banter/registry.json"),
      eventsPath: join(HOME, "services/banter/logs/events.jsonl"),
      port: 4200,
      idleIntervalMs: 60000,
    });
  });

  it("BANTER_SHARD_LIVE_DIR moves the registry; an explicit BANTER_SHARD_REGISTRY_PATH wins over it", () => {
    const moved = resolveShardPaths({ BANTER_SHARD_LIVE_DIR: "/srv/live" }, HOME);
    expect(moved.registryPath).toBe("/srv/live/registry.json");

    const pinned = resolveShardPaths({ BANTER_SHARD_LIVE_DIR: "/srv/live", BANTER_SHARD_REGISTRY_PATH: "/etc/reg.json" }, HOME);
    expect(pinned.registryPath).toBe("/etc/reg.json");
  });

  it("a non-integer or zero BANTER_SHARD_PORT throws, naming the variable", () => {
    expect(() => resolveShardPaths({ BANTER_SHARD_PORT: "abc" }, HOME)).toThrow(/BANTER_SHARD_PORT/);
    expect(() => resolveShardPaths({ BANTER_SHARD_PORT: "0" }, HOME)).toThrow(/BANTER_SHARD_PORT/);
  });
});
