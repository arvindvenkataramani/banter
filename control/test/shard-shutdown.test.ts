// The shard closes its HTTP server before stopping any service. A request that
// arrives while services are being stopped would otherwise be served from the
// exiting shard's registry, and a service it starts after the stop loop has
// passed it is left running with no shard to own it.

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shardShutdown } from "../control-shard/src/lifecycle";
import type { Registry } from "../../shared/types";

let tmpDir: string;

function registry(): Registry {
  const svc = (id: string) => ({
    id,
    capabilityId: "tts",
    hostId: "gpu-machine",
    permissions: { enabled: true, protected: false },
    runner: { type: "systemd" as const, unit: id },
    network: { port: 8001, healthPath: "/health" },
    lifecycle: { shutdown: true },
  });
  return {
    version: 2,
    type: "shard",
    hosts: [{ id: "gpu-machine", name: "gpu-machine", hostname: "gpu-machine.example.ts.net", role: "worker" }],
    capabilities: [{ id: "tts", name: "Text-to-Speech" }],
    services: [svc("svc-a"), svc("svc-b")],
  } as Registry;
}

describe("shardShutdown", () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "shard-shutdown-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("closes the server before stopping any service", async () => {
    const order: string[] = [];
    const exit = spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      await shardShutdown({
        registryState: registry(),
        eventsPath: join(tmpDir, "events.jsonl"),
        runFn: async (cmd) => {
          order.push(cmd.join(" "));
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        stopHealth: () => {},
        stopIdle: () => {},
        stopServer: () => { order.push("server"); },
      });
      expect(order[0]).toBe("server");
      expect(order.filter((c) => c.includes("stop svc-"))).toHaveLength(2);
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      exit.mockRestore();
    }
  });
});
