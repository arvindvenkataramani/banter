import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkService, checkAllServices, startHealthLoop, resetFailureCounts } from "../src/health";
import { readEvents } from "../src/events";
import type { Service, Registry } from "../../../shared/types";

let tmpDir: string;
let eventsPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "health-test-"));
  eventsPath = join(tmpDir, "events.jsonl");
  resetFailureCounts();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeService(overrides: Partial<Service> = {}): Service {
  const { permissions, network, ...rest } = overrides;
  return {
    id: "svc1",
    capabilityId: "cap1",
    hostId: "host1",
    permissions: { enabled: true, ...permissions },
    network: { port: 9999, healthPath: "/health", endpoint: "http://localhost:9999", ...network },
    ...rest,
  };
}

describe("Single service check", () => {
  it("service responding 200 on healthPath → emits service.up event with latency", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const svc = makeService({ network: { port: server.port!, healthPath: "/health", endpoint: `http://localhost:${server.port}` } });
    await checkService(svc, eventsPath, { bypassThreshold: true });
    const events = await readEvents(eventsPath, {});
    expect(events[0].type).toBe("service.up");
    expect(typeof (events[0].data as Record<string, unknown>).latencyMs).toBe("number");
    server.stop(true);
  });

  it("service responding 500 → emits service.down event", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("err", { status: 500 }) });
    const svc = makeService({ network: { port: server.port!, healthPath: "/health", endpoint: `http://localhost:${server.port}` } });
    await checkService(svc, eventsPath, { bypassThreshold: true });
    const events = await readEvents(eventsPath, {});
    expect(events[0].type).toBe("service.down");
    server.stop(true);
  });

  it("service not responding (connection refused) → emits service.down event", async () => {
    const svc = makeService({ network: { port: 19876, healthPath: "/health", endpoint: "http://localhost:19876" } });
    await checkService(svc, eventsPath, { bypassThreshold: true });
    const events = await readEvents(eventsPath, {});
    expect(events[0].type).toBe("service.down");
  });

  it("service responding but exceeding timeout → emits service.timed_out event", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        await new Promise(r => setTimeout(r, 500));
        return new Response("ok");
      }
    });
    const svc = makeService({ network: { port: server.port!, healthPath: "/health", endpoint: `http://localhost:${server.port}` } });
    await checkService(svc, eventsPath, { bypassThreshold: true, timeoutMs: 100 });
    const events = await readEvents(eventsPath, {});
    expect(events[0].type).toBe("service.timed_out");
    server.stop(true);
  });

  it("disabled service is skipped — no event emitted", async () => {
    const svc = makeService({ permissions: { enabled: false } });
    await checkService(svc, eventsPath, { bypassThreshold: true });
    const events = await readEvents(eventsPath, {});
    expect(events).toHaveLength(0);
  });
});

describe("Consecutive failure threshold", () => {
  it("does not emit service.down until consecutive failure threshold is reached", async () => {
    const svc = makeService({ network: { port: 19877, healthPath: "/health", endpoint: "http://localhost:19877" } });
    // First failure — should not emit yet (threshold = 2)
    await checkService(svc, eventsPath, {});
    const events = await readEvents(eventsPath, {});
    expect(events).toHaveLength(0);
  });

  it("emits service.down once the consecutive failure threshold is reached", async () => {
    const svc = makeService({ network: { port: 19877, healthPath: "/health", endpoint: "http://localhost:19877" } });
    await checkService(svc, eventsPath, {});
    // First failure — no event yet
    let events = await readEvents(eventsPath, {});
    expect(events).toHaveLength(0);
    // Second failure — threshold reached, event emitted
    await checkService(svc, eventsPath, {});
    events = await readEvents(eventsPath, {});
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("service.down");
  });

  it("emits service.up immediately on first success", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const svc = makeService({ network: { port: server.port!, healthPath: "/health", endpoint: `http://localhost:${server.port}` } });
    await checkService(svc, eventsPath, {});
    const events = await readEvents(eventsPath, {});
    expect(events[0].type).toBe("service.up");
    server.stop(true);
  });

  it("resets failure counter on success after consecutive failures", async () => {
    const svc = makeService({ id: "svc-reset", network: { port: 19878, healthPath: "/health", endpoint: "http://localhost:19878" } });
    // Two failures (threshold reached)
    await checkService(svc, eventsPath, {});
    await checkService(svc, eventsPath, {});
    // Now success
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const svcSuccess = { ...svc, network: { ...svc.network, endpoint: `http://localhost:${server.port}` } };
    await checkService(svcSuccess, eventsPath, {});
    const events = await readEvents(eventsPath, { subjectId: "svc-reset" });
    const lastEvent = events[0];
    expect(lastEvent.type).toBe("service.up");
    server.stop(true);
  });
});

describe("healthExpect: reachable", () => {
  it("healthExpect 'reachable' + service responding 406 → emits service.up event", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("not acceptable", { status: 406 }) });
    const svc = makeService({
      network: {
        port: server.port!,
        healthPath: "/mcp",
        healthExpect: "reachable",
        endpoint: `http://localhost:${server.port}`,
      },
    });
    await checkService(svc, eventsPath, { bypassThreshold: true });
    const events = await readEvents(eventsPath, {});
    expect(events[0].type).toBe("service.up");
    server.stop(true);
  });

  it("healthExpect 'reachable' + service responding 500 → emits service.up event", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("err", { status: 500 }) });
    const svc = makeService({
      network: {
        port: server.port!,
        healthPath: "/mcp",
        healthExpect: "reachable",
        endpoint: `http://localhost:${server.port}`,
      },
    });
    await checkService(svc, eventsPath, { bypassThreshold: true });
    const events = await readEvents(eventsPath, {});
    expect(events[0].type).toBe("service.up");
    server.stop(true);
  });

  // Reachability is about getting *a response*. Nothing listening is still down,
  // otherwise the setting would mean "never report this service as broken".
  it("healthExpect 'reachable' + connection refused → still emits service.down event", async () => {
    const svc = makeService({
      network: {
        port: 19877,
        healthPath: "/mcp",
        healthExpect: "reachable",
        endpoint: "http://localhost:19877",
      },
    });
    await checkService(svc, eventsPath, { bypassThreshold: true });
    const events = await readEvents(eventsPath, {});
    expect(events[0].type).toBe("service.down");
  });

  it("healthExpect 'reachable' + timeout → still emits service.timed_out event", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        await new Promise(r => setTimeout(r, 200));
        return new Response("ok");
      },
    });
    const svc = makeService({
      network: {
        port: server.port!,
        healthPath: "/mcp",
        healthExpect: "reachable",
        endpoint: `http://localhost:${server.port}`,
      },
    });
    await checkService(svc, eventsPath, { bypassThreshold: true, timeoutMs: 50 });
    const events = await readEvents(eventsPath, {});
    expect(events[0].type).toBe("service.timed_out");
    server.stop(true);
  });

  it("healthExpect omitted + service responding 406 → emits service.down event (default unchanged)", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("not acceptable", { status: 406 }) });
    const svc = makeService({
      network: { port: server.port!, healthPath: "/mcp", endpoint: `http://localhost:${server.port}` },
    });
    await checkService(svc, eventsPath, { bypassThreshold: true });
    const events = await readEvents(eventsPath, {});
    expect(events[0].type).toBe("service.down");
    server.stop(true);
  });

  it("healthExpect 'ok' + service responding 406 → emits service.down event", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("not acceptable", { status: 406 }) });
    const svc = makeService({
      network: {
        port: server.port!,
        healthPath: "/mcp",
        healthExpect: "ok",
        endpoint: `http://localhost:${server.port}`,
      },
    });
    await checkService(svc, eventsPath, { bypassThreshold: true });
    const events = await readEvents(eventsPath, {});
    expect(events[0].type).toBe("service.down");
    server.stop(true);
  });
});

describe("managed runner health check", () => {
  function makeManagedService(overrides: Partial<Service> = {}): Service {
    return makeService({
      runner: {
        type: "managed",
        startCmd: ["paseo", "daemon", "start"],
        stopCmd: ["paseo", "daemon", "stop"],
        healthCmd: "paseo daemon status --json",
      },
      network: { port: 6767, healthPath: "", endpoint: "" },
      ...overrides,
    } as Partial<Service>);
  }

  it("healthCmd exits 0 → emits service.up event, no HTTP request made", async () => {
    let httpCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      httpCalled = true;
      return originalFetch(...args);
    }) as typeof fetch;

    const runFn = async (_cmd: string[]) => ({ stdout: '{"localDaemon":"running"}', exitCode: 0, stderr: "" });
    const svc = makeManagedService();
    await checkService(svc, eventsPath, { bypassThreshold: true, runFn });

    globalThis.fetch = originalFetch;

    const events = await readEvents(eventsPath, {});
    expect(events[0].type).toBe("service.up");
    expect(httpCalled).toBe(false);
  });

  it("healthCmd exits nonzero → emits service.down event", async () => {
    const runFn = async (_cmd: string[]) => ({ stdout: '{"localDaemon":"stale_pid"}', exitCode: 1, stderr: "" });
    const svc = makeManagedService();
    await checkService(svc, eventsPath, { bypassThreshold: true, runFn });

    const events = await readEvents(eventsPath, {});
    expect(events[0].type).toBe("service.down");
  });

  it("healthCmd is run via the injected runFn as a single shell string through sh -c", async () => {
    let receivedCmd: string[] = [];
    const runFn = async (cmd: string[]) => {
      receivedCmd = cmd;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const svc = makeManagedService({
      runner: {
        type: "managed",
        startCmd: ["paseo", "daemon", "start"],
        stopCmd: ["paseo", "daemon", "stop"],
        healthCmd: "paseo daemon status --json | jq -e '.localDaemon == \"running\"'",
      } as any,
    });
    await checkService(svc, eventsPath, { bypassThreshold: true, runFn });

    expect(receivedCmd).toEqual(["sh", "-c", "paseo daemon status --json | jq -e '.localDaemon == \"running\"'"]);
  });

  it("consecutive failure threshold still applies to managed runner health checks", async () => {
    const runFn = async (_cmd: string[]) => ({ exitCode: 1, stdout: "", stderr: "" });
    const svc = makeManagedService();

    await checkService(svc, eventsPath, { runFn });
    let events = await readEvents(eventsPath, {});
    expect(events).toHaveLength(0);

    await checkService(svc, eventsPath, { runFn });
    events = await readEvents(eventsPath, {});
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("service.down");
  });

  it("disabled managed-runner service is skipped — no health command run", async () => {
    let called = false;
    const runFn = async (_cmd: string[]) => {
      called = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const svc = makeManagedService({ permissions: { enabled: false } });
    await checkService(svc, eventsPath, { bypassThreshold: true, runFn });

    expect(called).toBe(false);
  });
});

describe("Health check loop", () => {
  it("checks all enabled services on each interval tick", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const registry: Registry = {
      version: 2,
      type: "control",
      hosts: [{ id: "h1", name: "h1", hostname: "h1.ts.net", role: "control" }],
      capabilities: [{ id: "c1", name: "c1" }],
      services: [
        makeService({ id: "s1", network: { port: server.port!, healthPath: "/health", endpoint: `http://localhost:${server.port}` } }),
        makeService({ id: "s2", network: { port: server.port!, healthPath: "/health", endpoint: `http://localhost:${server.port}` } }),
      ]
    };
    const { stop } = startHealthLoop(registry, eventsPath, 100);
    await new Promise(r => setTimeout(r, 200));
    stop();
    const events = await readEvents(eventsPath, {});
    const s1Events = events.filter(e => e.subjectId === "s1");
    const s2Events = events.filter(e => e.subjectId === "s2");
    expect(s1Events.length).toBeGreaterThan(0);
    expect(s2Events.length).toBeGreaterThan(0);
    server.stop(true);
  });

  it("does not check disabled services", async () => {
    const registry: Registry = {
      version: 2,
      type: "control",
      hosts: [{ id: "h1", name: "h1", hostname: "h1.ts.net", role: "control" }],
      capabilities: [{ id: "c1", name: "c1" }],
      services: [makeService({ id: "disabled-svc", permissions: { enabled: false } })]
    };
    const { stop } = startHealthLoop(registry, eventsPath, 50);
    await new Promise(r => setTimeout(r, 150));
    stop();
    const events = await readEvents(eventsPath, { subjectId: "disabled-svc" });
    expect(events).toHaveLength(0);
  });

  it("a slow service does not block checking other services", async () => {
    const fastServer = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const slowServer = Bun.serve({
      port: 0,
      fetch: async () => {
        await new Promise(r => setTimeout(r, 300));
        return new Response("ok");
      }
    });
    const registry: Registry = {
      version: 2,
      type: "control",
      hosts: [{ id: "h1", name: "h1", hostname: "h1.ts.net", role: "control" }],
      capabilities: [{ id: "c1", name: "c1" }],
      services: [
        makeService({ id: "fast", network: { port: fastServer.port!, healthPath: "/health", endpoint: `http://localhost:${fastServer.port}` } }),
        makeService({ id: "slow", network: { port: slowServer.port!, healthPath: "/health", endpoint: `http://localhost:${slowServer.port}` } }),
      ]
    };
    const { stop } = startHealthLoop(registry, eventsPath, 2000);
    await new Promise(r => setTimeout(r, 150));
    stop();
    const fastEvents = await readEvents(eventsPath, { subjectId: "fast" });
    // Fast service should have been checked even while slow was pending
    expect(fastEvents.length).toBeGreaterThan(0);
    fastServer.stop(true);
    slowServer.stop(true);
  });

  it("an unexpected error in one check does not prevent other checks from completing", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const registry: Registry = {
      version: 2,
      type: "control",
      hosts: [{ id: "h1", name: "h1", hostname: "h1.ts.net", role: "control" }],
      capabilities: [{ id: "c1", name: "c1" }],
      services: [
        makeService({ id: "good", network: { port: server.port!, healthPath: "/health", endpoint: `http://localhost:${server.port}` } }),
        makeService({ id: "bad", network: { port: 29999, healthPath: "/health", endpoint: "http://localhost:29999" } }), // connection refused
      ]
    };
    const { stop } = startHealthLoop(registry, eventsPath, 100);
    await new Promise(r => setTimeout(r, 200));
    stop();
    const goodEvents = await readEvents(eventsPath, { subjectId: "good" });
    expect(goodEvents.length).toBeGreaterThan(0);
    server.stop(true);
  });
});
