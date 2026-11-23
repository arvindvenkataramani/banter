// The shard process runs two Hono apps behind one Bun.serve. These
// predicates decide which sees a request — a route registered on shardApp
// but not matched here falls through to sharedApp and 404s, with nothing in
// the shard's logs to say why. That is not hypothetical: /api/media/voices
// (since removed) shipped registered-but-unreachable, and every test passed,
// because the suite exercised createShardApp directly and never the
// dispatcher.

import { describe, it, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPlatformPath, routesToShardApp } from "../control-shard/src/routing";
import { createShardApp } from "../control-shard/src/shard-api";
import type { Registry } from "../../shared/types";

// Every path the shard app registers, with each `:param` filled in.
function shardAppPaths(): string[] {
  const app = createShardApp({
    registryState: { services: [] } as unknown as Registry,
    eventsPath: join(tmpdir(), "shard-routing-events.jsonl"),
    getFreeMem: async () => 4096,
    loadService: async () => ({ ok: true }),
    unloadService: async () => ({ ok: true }),
    sharedLifecycle: async () => Response.json({ success: true }),
  });
  const paths = app.routes
    .map((r) => r.path)
    .filter((p) => !p.includes("*"))
    .map((p) => p.replace(/:[A-Za-z]+/g, "x"));
  return [...new Set(paths)];
}

describe("the shard's request dispatcher", () => {
  it("sends every route the shard app registers to the shard app", () => {
    const paths = shardAppPaths();
    expect(paths).toContain("/api/voices/resolve");
    expect(paths.filter((p) => !routesToShardApp(p))).toEqual([]);
  });

  it("sends every shard-only route to the shard app", () => {
    // Each of these exists ONLY on shardApp. Reaching sharedApp is a 404.
    expect(routesToShardApp("/status")).toBe(true);
    expect(routesToShardApp("/ping/tts-mlx-audio")).toBe(true);
    expect(routesToShardApp("/api/services/tts-mlx-audio/start")).toBe(true);
    expect(routesToShardApp("/api/services/tts-mlx-audio/stop")).toBe(true);
    expect(routesToShardApp("/api/roster")).toBe(true);
    expect(routesToShardApp("/api/config/reload")).toBe(true);
  });

  it("leaves the routes every node shares on the shared app", () => {
    expect(routesToShardApp("/api/health")).toBe(false);
    expect(routesToShardApp("/api/services")).toBe(false);
    expect(routesToShardApp("/api/events")).toBe(false);
  });

  it("treats a path outside the platform's prefixes as not served at all", () => {
    expect(isPlatformPath("/")).toBe(false);
    expect(isPlatformPath("/index.html")).toBe(false);
    expect(isPlatformPath("/api/health")).toBe(true);
    expect(isPlatformPath("/status")).toBe(true);
    expect(isPlatformPath("/ping/x")).toBe(true);
  });
});
